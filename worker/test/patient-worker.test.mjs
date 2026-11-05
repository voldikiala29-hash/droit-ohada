// Tests HTTP du Worker : authentification, quotas, plafond de messages, échec fermé, JWKS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../patient-worker.js";
import CASE_IDS from "../case-ids.js";
import {
  makeCtx, bodyFor, reqFor, sign, claims, makeKey, countingFetch, fakeAI,
  brokenNamespace, FakeKV, makeNamespace, PROJECT, ORIGIN
} from "./helpers.mjs";

const call = (ctx, body, extra = {}) =>
  handleRequest(reqFor(body, { token: ctx.token, ...extra }), ctx.env, ctx.opts);

/* ---------- Authentification ---------- */

test("sans en-tête Authorization : 401, IA non appelée", async () => {
  const c = await makeCtx();
  const r = await handleRequest(reqFor(bodyFor(CASE_IDS[0])), c.env, c.opts);
  assert.equal(r.status, 401);
  assert.equal(c.ai.calls, 0);
});

test("jeton signé par une autre clé : 401", async () => {
  const c = await makeCtx();
  const other = await makeKey("k1");
  const forged = await sign(other, claims(c.now));
  const r = await handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token: forged }), c.env, c.opts);
  assert.equal(r.status, 401);
  assert.equal(c.ai.calls, 0);
});

test("algorithme 'none' : 401", async () => {
  const c = await makeCtx();
  const h = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims(c.now))).toString("base64url");
  const r = await handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token: h + "." + p + "." }), c.env, c.opts);
  assert.equal(r.status, 401);
});

test("mauvais émetteur, mauvaise audience, jeton expiré : 401", async () => {
  const c = await makeCtx();
  const badIss = await sign(c.key, claims(c.now, { iss: "https://securetoken.google.com/autre" }));
  const badAud = await sign(c.key, claims(c.now, { aud: "autre" }));
  const expired = await sign(c.key, claims(c.now, { exp: Math.floor(c.now / 1000) - 10 }));
  for (const t of [badIss, badAud, expired]) {
    assert.equal((await handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token: t }), c.env, c.opts)).status, 401);
  }
});

test("email non vérifié : 403, IA non appelée", async () => {
  const c = await makeCtx({ emailVerified: false });
  const r = await call(c, bodyFor(CASE_IDS[0]));
  assert.equal(r.status, 403);
  assert.equal(c.ai.calls, 0);
});

test("jeton valide : 200 avec le détail du quota", async () => {
  const c = await makeCtx();
  const r = await call(c, bodyFor(CASE_IDS[0]));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.reponse, "Oui docteur, ça fait quatre jours.");
  assert.deepEqual(j.quota, { plan: "free", used: 1, limit: 5, msgs: 1, msgCap: 40 });
});

/* ---------- Quotas en concurrence ---------- */

test("100 requêtes simultanées, compte gratuit, cas distincts : 5 réussies, 5 appels IA", async () => {
  // Latence de stockage élevée : maximise le chevauchement des réservations.
  const c = await makeCtx({ env: {}, latencyMs: 25 });
  const reqs = Array.from({ length: 100 }, (_, i) => call(c, bodyFor(CASE_IDS[i])));
  const responses = await Promise.all(reqs);
  const statuses = responses.map(r => r.status);
  assert.equal(statuses.filter(s => s === 200).length, 5, "exactement 5 réussites");
  assert.equal(statuses.filter(s => s === 402).length, 95, "le reste refusé pour quota");
  assert.equal(c.ai.calls, 5, "l'IA n'est appelée que pour les 5 réussites");
});

test("avec la limite de débit par défaut (20/min) : jamais plus de 5 réussites", async () => {
  const c = await makeCtx({ env: { USER_REQUESTS_PER_MINUTE: "20" }, latencyMs: 25 });
  const responses = await Promise.all(Array.from({ length: 100 }, (_, i) => call(c, bodyFor(CASE_IDS[i]))));
  const ok = responses.filter(r => r.status === 200).length;
  assert.equal(ok, 5);
  assert.equal(c.ai.calls, 5);
});

test("formule Premium (KV plan:<uid> valide) : 150 cas distincts acceptés, le 151e refusé", async () => {
  const c = await makeCtx();
  const until = new Date(c.now + 30 * 24 * 3600 * 1000).toISOString();
  await c.kv.put("plan:" + c.uid, JSON.stringify({ plan: "premium", until }));
  let last;
  for (let i = 0; i < 151; i++) {
    last = await call(c, bodyFor(CASE_IDS[i]));
    if (i < 150) assert.equal(last.status, 200, "cas " + i);
  }
  assert.equal(last.status, 402);
  assert.equal((await last.json()).quota.limit, 150);
});

test("Premium expiré : retour à la formule gratuite", async () => {
  const c = await makeCtx();
  const until = new Date(c.now - 1000).toISOString();
  await c.kv.put("plan:" + c.uid, JSON.stringify({ plan: "premium", until }));
  const j = await (await call(c, bodyFor(CASE_IDS[0]))).json();
  assert.equal(j.quota.plan, "free");
});

test("plan illisible dans KV : formule gratuite", async () => {
  const c = await makeCtx();
  await c.kv.put("plan:" + c.uid, "pas du json");
  const j = await (await call(c, bodyFor(CASE_IDS[0]))).json();
  assert.equal(j.quota.plan, "free");
});

/* ---------- Plafond de messages ---------- */

test("40 messages sur un même cas acceptés, le 41e refusé (409, reason messages)", async () => {
  const c = await makeCtx();
  for (let i = 0; i < 40; i++) {
    const r = await call(c, bodyFor(CASE_IDS[0], "message " + i));
    assert.equal(r.status, 200, "message " + (i + 1));
  }
  const r = await call(c, bodyFor(CASE_IDS[0], "de trop"));
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.error, "messages");
  assert.equal(j.quota.msgCap, 40);
  assert.equal(c.ai.calls, 40);
});

test("MAX_MESSAGES_PER_CASE configurable : 3 messages puis refus", async () => {
  const c = await makeCtx({ env: { MAX_MESSAGES_PER_CASE: "3" } });
  for (let i = 0; i < 3; i++) assert.equal((await call(c, bodyFor(CASE_IDS[0]))).status, 200);
  assert.equal((await call(c, bodyFor(CASE_IDS[0]))).status, 409);
});

test("une réponse IA en échec ne consomme pas de message", async () => {
  const c = await makeCtx();
  c.env.AI = fakeAI({ fail: 1 });
  assert.equal((await call(c, bodyFor(CASE_IDS[0]))).status, 502);
  for (let i = 0; i < 40; i++) assert.equal((await call(c, bodyFor(CASE_IDS[0]))).status, 200, "msg " + i);
  assert.equal((await call(c, bodyFor(CASE_IDS[0]))).status, 409);
});

test("une réponse IA vide est traitée comme un échec et libérée", async () => {
  const c = await makeCtx();
  c.env.AI = fakeAI({ reply: "   " });
  assert.equal((await call(c, bodyFor(CASE_IDS[0]))).status, 502);
  const ok = await call(c, bodyFor(CASE_IDS[0]));
  assert.equal(ok.status, 502);
});

/* ---------- Identifiants de cas ---------- */

test("identifiant de cas inventé : 400, IA non appelée", async () => {
  const c = await makeCtx();
  for (const id of ["n_importe_quoi", "palu_adulte_fake", "../../etc", "x".repeat(81)]) {
    assert.equal((await call(c, bodyFor(id))).status, 400, id);
  }
  assert.equal(c.ai.calls, 0);
});

test("identifiant d'un vrai cas : accepté", async () => {
  const c = await makeCtx();
  assert.equal((await call(c, bodyFor("palu_adulte"))).status, 200);
});

/* ---------- Échec fermé ---------- */

test("liaison QUOTA absente : 503, IA non appelée", async () => {
  const c = await makeCtx();
  delete c.env.QUOTA;
  assert.equal((await call(c, bodyFor(CASE_IDS[0]))).status, 503);
  assert.equal(c.ai.calls, 0);
});

test("liaison STATE absente : 503, IA non appelée", async () => {
  const c = await makeCtx();
  delete c.env.STATE;
  assert.equal((await call(c, bodyFor(CASE_IDS[0]))).status, 503);
  assert.equal(c.ai.calls, 0);
});

test("Durable Object indisponible : 503, IA non appelée", async () => {
  const c = await makeCtx();
  c.env.QUOTA = brokenNamespace();
  assert.equal((await call(c, bodyFor(CASE_IDS[0]))).status, 503);
  assert.equal(c.ai.calls, 0);
});

test("variable de configuration invalide : 503 (échec fermé)", async () => {
  const c = await makeCtx({ env: { MAX_MESSAGES_PER_CASE: "abc" } });
  assert.equal((await call(c, bodyFor(CASE_IDS[0]))).status, 503);
  assert.equal(c.ai.calls, 0);
});

test("STATE (plans) indisponible : 503, IA non appelée", async () => {
  const c = await makeCtx();
  c.env.STATE = { get: async () => { throw new Error("kv_down"); }, put: async () => {} };
  assert.equal((await call(c, bodyFor(CASE_IDS[0]))).status, 503);
  assert.equal(c.ai.calls, 0);
});

/* ---------- Origine, méthode, débit par IP ---------- */

test("origine non autorisée : 403", async () => {
  const c = await makeCtx();
  assert.equal((await call(c, bodyFor(CASE_IDS[0]), { origin: "https://evil.example" })).status, 403);
});

test("méthode GET : 405 ; pré-vol OPTIONS autorise Authorization", async () => {
  const c = await makeCtx();
  assert.equal((await handleRequest(reqFor(undefined, { method: "GET" }), c.env, c.opts)).status, 405);
  const pre = await handleRequest(reqFor(undefined, { method: "OPTIONS" }), c.env, c.opts);
  assert.match(pre.headers.get("Access-Control-Allow-Headers"), /Authorization/);
});

test("débit par IP : la 4e requête d'une même adresse est refusée (429) avant toute vérification de jeton", async () => {
  const c = await makeCtx({ env: { IP_REQUESTS_PER_MINUTE: "3" } });
  const statuses = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token: "x.y.z" }), c.env, c.opts)).status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 429]);
});

test("limite de débit par utilisateur : 429 au-delà de la valeur configurée", async () => {
  const c = await makeCtx({ env: { USER_REQUESTS_PER_MINUTE: "2" } });
  const s = [];
  for (let i = 0; i < 3; i++) s.push((await call(c, bodyFor(CASE_IDS[i]))).status);
  assert.deepEqual(s, [200, 200, 429]);
});

/* ---------- Clés Google (JWKS) ---------- */

test("rotation des clés : un kid inconnu déclenche un rechargement et le jeton est accepté", async () => {
  const now = Date.now();
  const newKey = await makeKey("nouvelle");
  const token = await sign(newKey, claims(now));
  const fetchImpl = countingFetch(() => [newKey.jwk]);
  const env = {
    AI: fakeAI(), STATE: new FakeKV(), QUOTA: makeNamespace(0), FIREBASE_PROJECT_ID: PROJECT,
    USER_REQUESTS_PER_MINUTE: "1000", IP_REQUESTS_PER_MINUTE: "1000",
    PROTOCOL_CUTOFF: new Date(now + 30 * 864e5).toISOString()
  };
  // Cache ancien (ne contient pas le nouveau kid), récemment rechargé il y a 10 minutes
  const jwksCache = { keys: [{ kid: "ancienne", kty: "RSA" }], expiresAt: now + 3600e3, lastFetch: now - 10 * 60e3 };
  const r = await handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token }), env, { nowMs: now, fetchImpl, jwksCache });
  assert.equal(r.status, 200);
  assert.equal(fetchImpl.calls, 1);
});

test("kid inconnu répété : Google n'est interrogé qu'une fois pendant le délai de carence", async () => {
  const now = Date.now();
  const bogus = await makeKey("inconnu");
  const token = await sign(bogus, claims(now));
  const fetchImpl = countingFetch(() => []);
  const env = {
    AI: fakeAI(), STATE: new FakeKV(), QUOTA: makeNamespace(0), FIREBASE_PROJECT_ID: PROJECT,
    USER_REQUESTS_PER_MINUTE: "1000", IP_REQUESTS_PER_MINUTE: "1000",
    PROTOCOL_CUTOFF: new Date(now + 30 * 864e5).toISOString()
  };
  const jwksCache = { keys: null, expiresAt: 0, lastFetch: 0 };
  const statuses = [];
  for (let i = 0; i < 20; i++) {
    statuses.push((await handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token }), env, { nowMs: now, fetchImpl, jwksCache })).status);
  }
  assert.ok(statuses.every(s => s === 401));
  assert.equal(fetchImpl.calls, 1);
});

test("JWKS indisponible au premier appel : 503 (panne technique, pas un refus d'authentification)", async () => {
  const c = await makeCtx();
  const down = async () => new Response("erreur", { status: 500 });
  const r = await handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token: c.token }), c.env,
    { nowMs: c.now, fetchImpl: down, jwksCache: { keys: null, expiresAt: 0, lastFetch: 0 } });
  assert.equal(r.status, 503);
  assert.equal(c.ai.calls, 0);
});

/* ---------- 1.4c : taille du corps, limite IP avant lecture, version du contrat, délai IA ---------- */

test("corps trop grand (65 Ko et plus) : 413, IA non appelée, aucune réservation", async () => {
  const c = await makeCtx();
  const huge = "x".repeat(70000);
  const req = new Request("https://worker.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.20",
      "X-SDG-Protocol": "2", Authorization: "Bearer " + c.token },
    body: huge
  });
  const r = await handleRequest(req, c.env, c.opts);
  assert.equal(r.status, 413);
  assert.equal(c.ai.calls, 0);
  assert.equal(c.env.QUOTA.instances.has("uid:uid-A"), false);
});

test("limite IP déclenchée avant la lecture du corps : 429, le corps n'est pas lu", async () => {
  const c = await makeCtx({ env: { IP_REQUESTS_PER_MINUTE: "1" } });
  await handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token: c.token, ip: "203.0.113.30" }), c.env, c.opts);
  let reads = 0;
  const stream = new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new TextEncoder().encode("{}")); controller.close(); }
  }, { highWaterMark: 0 });
  const req = new Request("https://worker.test/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.30",
      "X-SDG-Protocol": "2", Authorization: "Bearer " + c.token },
    body: stream, duplex: "half"
  });
  const r = await handleRequest(req, c.env, c.opts);
  assert.equal(r.status, 429);
  assert.equal(reads, 0);
});

test("avant la date limite, sans X-SDG-Protocol : 200 avec avertissement X-SDG-Upgrade", async () => {
  const c = await makeCtx();
  const r = await call(c, bodyFor(CASE_IDS[0]), { protocol: null });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-SDG-Upgrade"), "requis");
});

test("après la date limite, sans X-SDG-Protocol : 426, sans consommation de quota ni appel IA", async () => {
  const c = await makeCtx({ env: { PROTOCOL_CUTOFF: new Date(Date.now() - 1000).toISOString() } });
  const r = await call(c, bodyFor(CASE_IDS[0]), { protocol: null });
  assert.equal(r.status, 426);
  assert.equal(c.ai.calls, 0);
  assert.equal(c.env.QUOTA.instances.has("uid:uid-A"), false);
});

test("protocole à jour : pas d'avertissement, même après la date limite", async () => {
  const c = await makeCtx({ env: { PROTOCOL_CUTOFF: new Date(Date.now() - 1000).toISOString() } });
  const r = await call(c, bodyFor(CASE_IDS[0]));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("X-SDG-Upgrade"), null);
});

test("date limite absente ou invalide : 503 (échec fermé), aucune réservation", async () => {
  const c = await makeCtx({ env: { PROTOCOL_CUTOFF: "REMPLACER_PAR_DATE_DE_DEPLOIEMENT_PLUS_30_JOURS" } });
  const r = await call(c, bodyFor(CASE_IDS[0]));
  assert.equal(r.status, 503);
  assert.equal(c.ai.calls, 0);
});

test("CORS : l'en-tête X-SDG-Protocol est autorisé", async () => {
  const c = await makeCtx();
  const r = await handleRequest(new Request("https://worker.test/", {
    method: "OPTIONS", headers: { Origin: ORIGIN }
  }), c.env, c.opts);
  assert.match(r.headers.get("Access-Control-Allow-Headers"), /X-SDG-Protocol/);
});

test("IA qui ne répond pas dans le délai : 502, réservation libérée (le quota revient)", async () => {
  const c = await makeCtx();
  c.env.AI = { calls: 0, run: () => { c.env.AI.calls++; return new Promise(() => {}); } };
  const opts = { ...c.opts, aiTimeoutMs: 20 };
  const r = await handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token: c.token }), c.env, opts);
  assert.equal(r.status, 502);
  // Le message suivant doit voir un compteur à 1 (et non 2)
  c.env.AI = fakeAI();
  const ok = await handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token: c.token }), c.env, c.opts);
  assert.equal(ok.status, 200);
  const data = await ok.json();
  assert.equal(data.quota.msgs, 1);
});
