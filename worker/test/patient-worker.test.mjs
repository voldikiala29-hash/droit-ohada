import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, verifyIdToken } from "../patient-worker.js";

const PROJECT = "salledegarde-89dae";
const ORIGIN = "https://salledegarde.online";
const enc = new TextEncoder();

function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj) {
  return b64url(enc.encode(JSON.stringify(obj)));
}

async function makeKey(kid = "k1") {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" }, kid };
}

async function sign(key, payload, header = {}) {
  const h = b64urlJson({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const p = b64urlJson(payload);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, enc.encode(h + "." + p));
  return h + "." + p + "." + b64url(new Uint8Array(sig));
}

function claims(now, overrides = {}) {
  const sec = Math.floor(now / 1000);
  return {
    iss: "https://securetoken.google.com/" + PROJECT,
    aud: PROJECT,
    iat: sec,
    auth_time: sec,
    exp: sec + 3600,
    sub: "uid-medecin-1",
    email: "medecin@example.org",
    email_verified: true,
    ...overrides
  };
}

function fakeFetch(jwk) {
  return async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
}

class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
}

function fakeAI(reply = "Oui docteur, ça fait quatre jours.") {
  const calls = { n: 0 };
  return {
    calls,
    run: async () => { calls.n++; return { response: reply }; }
  };
}

const BODY = (caseId = "cas_1") => ({
  persona: "Homme de 35 ans",
  facts: "- Motif : fièvre",
  step: "Anamnèse",
  history: [],
  message: "Depuis quand ?",
  question: "Depuis quand ?",
  cas: { id: caseId }
});

function req(body, { auth, origin = ORIGIN, method = "POST" } = {}) {
  const headers = { "Content-Type": "application/json", Origin: origin };
  if (auth) headers.Authorization = "Bearer " + auth;
  return new Request("https://worker.test/", { method, headers, body: method === "POST" ? JSON.stringify(body) : undefined });
}

async function setup({ now = Date.now(), tokenOverrides = {}, signKey, env = {} } = {}) {
  const key = await makeKey();
  const otherKey = await makeKey("k1");
  const token = await sign(signKey || key, claims(now, tokenOverrides));
  const state = new FakeKV();
  const ai = fakeAI();
  const e = { AI: ai, STATE: state, FIREBASE_PROJECT_ID: PROJECT, ...env };
  const opts = { nowMs: now, fetchImpl: fakeFetch(key.jwk), jwksCache: { keys: null, expiresAt: 0 } };
  return { key, otherKey, token, state, ai, env: e, opts };
}

/* ---------- Vérification du jeton ---------- */

test("jeton valide : accès accordé", async () => {
  const s = await setup();
  const res = await handleRequest(req(BODY(), { auth: s.token }), s.env, s.opts);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.reponse, "Oui docteur, ça fait quatre jours.");
  assert.equal(j.quota.plan, "free");
  assert.equal(j.quota.used, 1);
});

test("sans en-tête Authorization : 401", async () => {
  const s = await setup();
  const res = await handleRequest(req(BODY()), s.env, s.opts);
  assert.equal(res.status, 401);
  assert.equal(s.ai.calls.n, 0);
});

test("jeton signé par une autre clé : 401", async () => {
  const s = await setup();
  const forged = await sign(s.otherKey, claims(Date.now()));
  const res = await handleRequest(req(BODY(), { auth: forged }), s.env, s.opts);
  assert.equal(res.status, 401);
  assert.equal(s.ai.calls.n, 0);
});

test("algorithme 'none' refusé : 401", async () => {
  const s = await setup();
  const h = b64urlJson({ alg: "none", typ: "JWT" });
  const p = b64urlJson(claims(Date.now()));
  const res = await handleRequest(req(BODY(), { auth: h + "." + p + "." }), s.env, s.opts);
  assert.equal(res.status, 401);
});

test("mauvaise audience ou émetteur : 401", async () => {
  const s = await setup({ tokenOverrides: { aud: "autre-projet" } });
  const bad1 = await sign(s.key, claims(s.opts.nowMs, { aud: "autre-projet" }));
  const bad2 = await sign(s.key, claims(s.opts.nowMs, { iss: "https://securetoken.google.com/autre" }));
  assert.equal((await handleRequest(req(BODY(), { auth: bad1 }), s.env, s.opts)).status, 401);
  assert.equal((await handleRequest(req(BODY(), { auth: bad2 }), s.env, s.opts)).status, 401);
});

test("jeton expiré : 401", async () => {
  const now = Date.now();
  const s = await setup({ now });
  const expired = await sign(s.key, claims(now, { exp: Math.floor(now / 1000) - 10 }));
  assert.equal((await handleRequest(req(BODY(), { auth: expired }), s.env, s.opts)).status, 401);
});

test("email non vérifié : 403", async () => {
  const s = await setup();
  const t = await sign(s.key, claims(s.opts.nowMs, { email_verified: false }));
  const res = await handleRequest(req(BODY(), { auth: t }), s.env, s.opts);
  assert.equal(res.status, 403);
  assert.equal(s.ai.calls.n, 0);
});

test("verifyIdToken renvoie l'identifiant et l'email", async () => {
  const s = await setup();
  const user = await verifyIdToken(s.token, { projectId: PROJECT, nowMs: s.opts.nowMs, fetchImpl: s.opts.fetchImpl, jwksCache: { keys: null, expiresAt: 0 } });
  assert.equal(user.uid, "uid-medecin-1");
  assert.equal(user.emailVerified, true);
});

/* ---------- Quotas ---------- */

test("formule gratuite : 5 cas distincts puis refus au 6e", async () => {
  const s = await setup();
  for (let i = 1; i <= 5; i++) {
    const r = await handleRequest(req(BODY("cas_" + i), { auth: s.token }), s.env, s.opts);
    assert.equal(r.status, 200, "cas " + i);
  }
  const sixth = await handleRequest(req(BODY("cas_6"), { auth: s.token }), s.env, s.opts);
  assert.equal(sixth.status, 402);
  const j = await sixth.json();
  assert.equal(j.quota.limit, 5);
  assert.equal(j.quota.used, 5);
});

test("un cas déjà compté reste accessible même quota atteint", async () => {
  const s = await setup();
  for (let i = 1; i <= 5; i++) await handleRequest(req(BODY("cas_" + i), { auth: s.token }), s.env, s.opts);
  const again = await handleRequest(req(BODY("cas_3"), { auth: s.token }), s.env, s.opts);
  assert.equal(again.status, 200);
});

test("Premium actif : quota élevé", async () => {
  const s = await setup();
  const until = new Date(s.opts.nowMs + 30 * 24 * 3600 * 1000).toISOString();
  await s.state.put("plan:uid-medecin-1", JSON.stringify({ plan: "premium", until }));
  for (let i = 1; i <= 6; i++) {
    const r = await handleRequest(req(BODY("cas_" + i), { auth: s.token }), s.env, s.opts);
    assert.equal(r.status, 200, "cas " + i);
  }
  const j = await (await handleRequest(req(BODY("cas_6"), { auth: s.token }), s.env, s.opts)).json();
  assert.equal(j.quota.plan, "premium");
});

test("Premium expiré : retour à la formule gratuite", async () => {
  const s = await setup();
  const until = new Date(s.opts.nowMs - 1000).toISOString();
  await s.state.put("plan:uid-medecin-1", JSON.stringify({ plan: "premium", until }));
  const r = await handleRequest(req(BODY("cas_1"), { auth: s.token }), s.env, s.opts);
  assert.equal((await r.json()).quota.plan, "free");
});

test("enregistrement de plan illisible : formule gratuite", async () => {
  const s = await setup();
  await s.state.put("plan:uid-medecin-1", "pas du json");
  const r = await handleRequest(req(BODY("cas_1"), { auth: s.token }), s.env, s.opts);
  assert.equal((await r.json()).quota.plan, "free");
});

test("échec de l'IA : le quota n'est pas décompté", async () => {
  const s = await setup();
  s.env.AI = { run: async () => { throw new Error("boom"); } };
  const r = await handleRequest(req(BODY("cas_1"), { auth: s.token }), s.env, s.opts);
  assert.equal(r.status, 502);
  const raw = await s.state.get("usage:uid-medecin-1:" + new Date(s.opts.nowMs).toISOString().slice(0, 7));
  assert.equal(raw, null);
});

/* ---------- Robustesse et configuration ---------- */

test("sans liaison STATE : 503 (échec fermé)", async () => {
  const s = await setup();
  const env = { AI: s.ai, FIREBASE_PROJECT_ID: PROJECT };
  const r = await handleRequest(req(BODY(), { auth: s.token }), env, s.opts);
  assert.equal(r.status, 503);
  assert.equal(s.ai.calls.n, 0);
});

test("origine non autorisée : 403", async () => {
  const s = await setup();
  const r = await handleRequest(req(BODY(), { auth: s.token, origin: "https://evil.example" }), s.env, s.opts);
  assert.equal(r.status, 403);
});

test("identifiant de cas manquant : 400", async () => {
  const s = await setup();
  const body = BODY(); delete body.cas;
  const r = await handleRequest(req(body, { auth: s.token }), s.env, s.opts);
  assert.equal(r.status, 400);
});

test("limite de débit par utilisateur : 429 après 20 requêtes par minute", async () => {
  const s = await setup();
  let last;
  for (let i = 0; i < 21; i++) last = await handleRequest(req(BODY("cas_1"), { auth: s.token }), s.env, s.opts);
  assert.equal(last.status, 429);
});

test("pré-vol CORS autorise l'en-tête Authorization", async () => {
  const s = await setup();
  const r = await handleRequest(req(null, { method: "OPTIONS" }), s.env, s.opts);
  assert.match(r.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});
