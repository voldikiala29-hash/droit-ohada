// Outils de test partagés. Ils simulent Firebase (jetons RS256), Workers KV et les Durable Objects.
// Limite : la simulation sérialise les appels comme un Durable Object, mais ne remplace pas
// un test sur le runtime Cloudflare réel (voir docs/securite-phase-1.md).
import { QuotaLimiter } from "../patient-worker.js";
import { randomBytes } from "node:crypto";

export const PROJECT = "salledegarde-89dae";
export const ORIGIN = "https://salledegarde.online";
const enc = new TextEncoder();

export function b64url(bytes) {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlJson(obj) {
  return b64url(enc.encode(JSON.stringify(obj)));
}

export async function makeKey(kid = "k1") {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" }, kid };
}

export async function sign(key, payload, header = {}) {
  const h = b64urlJson({ alg: "RS256", kid: key.kid, typ: "JWT", ...header });
  const p = b64urlJson(payload);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, enc.encode(h + "." + p));
  return h + "." + p + "." + b64url(new Uint8Array(sig));
}

export function claims(nowMs, over = {}) {
  const sec = Math.floor(nowMs / 1000);
  return {
    iss: "https://securetoken.google.com/" + PROJECT,
    aud: PROJECT,
    iat: sec,
    auth_time: sec,
    exp: sec + 3600,
    sub: "uid-medecin-1",
    email: "medecin@example.org",
    email_verified: true,
    ...over
  };
}

/** fetch simulé pour le JWKS. getKeys peut être un tableau ou une fonction. */
export function countingFetch(getKeys) {
  const f = async () => {
    f.calls++;
    const keys = typeof getKeys === "function" ? getKeys() : getKeys;
    return new Response(JSON.stringify({ keys }), { status: 200 });
  };
  f.calls = 0;
  return f;
}

export class FakeKV {
  constructor() { this.m = new Map(); }
  async get(k) { return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.m.set(k, String(v)); }
}

const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/**
 * Stockage simulé. latencyMs > 0 ajoute une vraie attente (macrotâche) à chaque opération,
 * comme un stockage distant : c'est ce qui permet à deux requêtes de se chevaucher.
 */
export class FakeStorage {
  constructor(latencyMs = 0) { this.m = new Map(); this.latencyMs = latencyMs; }
  async tick() { if (this.latencyMs > 0) await new Promise(r => setTimeout(r, this.latencyMs)); }
  async get(k) { await this.tick(); return this.m.has(k) ? clone(this.m.get(k)) : undefined; }
  async put(k, v) { await this.tick(); this.m.set(k, clone(v)); }
  async delete(k) { await this.tick(); return this.m.delete(k); }
  async deleteAll() { await this.tick(); this.m.clear(); }
}

/**
 * Espace de noms de Durable Objects simulé : un objet par nom, avec une latence de stockage.
 * Chaque appel passe par la classe réelle QuotaLimiter.
 */
export function makeNamespace(latencyMs = 3) {
  const instances = new Map();
  const ns = {
    instances,
    idFromName: n => n,
    get(name) {
      if (!instances.has(name)) instances.set(name, new QuotaLimiter({ storage: new FakeStorage(latencyMs) }));
      const obj = instances.get(name);
      return {
        rateHit: async (a) => obj.rateHit(a),
        reserve: async (a) => obj.reserve(a),
        confirm: async (a) => obj.confirm(a),
        release: async (a) => obj.release(a)
      };
    }
  };
  return ns;
}

/** Espace de noms dont le stub échoue toujours (Durable Object indisponible). */
export function brokenNamespace() {
  const fail = async () => { throw new Error("durable_object_unavailable"); };
  return { idFromName: n => n, get: () => ({ rateHit: fail, reserve: fail, confirm: fail, release: fail }) };
}

/** IA simulée. fail = nombre d'appels qui échouent avant le premier succès. */
export function fakeAI({ fail = 0, reply = "Oui docteur, ça fait quatre jours." } = {}) {
  const ai = { calls: 0, failures: fail };
  ai.run = async () => {
    ai.calls++;
    if (ai.failures > 0) { ai.failures--; throw new Error("ai_down"); }
    return { response: reply };
  };
  return ai;
}

export async function makeCtx({ now = Date.now(), uid = "uid-A", env = {}, latencyMs = 3, emailVerified = true } = {}) {
  const key = await makeKey("k1");
  const token = await sign(key, claims(now, { sub: uid, email_verified: emailVerified }));
  const fetchImpl = countingFetch([key.jwk]);
  const kv = new FakeKV();
  const ai = fakeAI();
  const e = {
    AI: ai,
    STATE: kv,
    QUOTA: makeNamespace(latencyMs),
    FIREBASE_PROJECT_ID: PROJECT,
    USER_REQUESTS_PER_MINUTE: "1000",
    IP_REQUESTS_PER_MINUTE: "1000",
    PROTOCOL_CUTOFF: new Date(now + 30 * 24 * 3600 * 1000).toISOString(),
    ...env
  };
  const opts = { nowMs: now, fetchImpl, jwksCache: { keys: null, expiresAt: 0, lastFetch: 0 } };
  return { key, token, uid, kv, ai, env: e, opts, fetchImpl, now };
}

export function bodyFor(caseId, message = "Depuis quand ?") {
  return {
    persona: "Tu es Awa, 34 ans, femme, commerçante, tu habites à Kinshasa.",
    facts: "- Motif de ta venue : fièvre depuis quatre jours",
    step: "Anamnèse",
    history: [],
    message,
    question: message,
    cas: { id: caseId }
  };
}

/** Identifiant de requête UUID version 7 dont les 48 premiers bits sont l'heure ms (comme le navigateur). */
export function uuidV7(ms, seed = randomBytes(10)) {
  const hex = ms.toString(16).padStart(12, "0");
  const rnd = seed.toString("hex"); // 20 caractères hexadécimaux
  const variant = (parseInt(rnd[0], 16) & 0x3 | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rnd.slice(1, 4)}-${variant}${rnd.slice(5, 8)}-${rnd.slice(8, 20)}`;
}

export function reqFor(body, { token, origin = ORIGIN, method = "POST", ip = "203.0.113.7", protocol = "2", requestId } = {}) {
  const headers = { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": ip };
  if (protocol !== null) headers["X-SDG-Protocol"] = protocol;
  if (requestId !== undefined) headers["X-SDG-Request-Id"] = requestId;
  if (token) headers.Authorization = "Bearer " + token;
  return new Request("https://worker.test/", {
    method,
    headers,
    body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined
  });
}
