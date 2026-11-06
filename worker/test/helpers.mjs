// Outils de test partagés. Ils simulent Firebase (jetons RS256), Workers KV et les Durable Objects.
// Limite : la simulation sérialise les appels comme un Durable Object, mais ne remplace pas
// un test sur le runtime Cloudflare réel (voir docs/securite-phase-1.md).
import { QuotaLimiter } from "../patient-worker.js";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

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
 * Stockage SQLite simulé avec node:sqlite (SQLite réel en mémoire), exposé avec la même forme que
 * ctx.storage.sql des Durable Objects : exec(sql, ...liaisons).toArray(). Les transactions passent par
 * transactionSync, comme dans le runtime. failNext permet d'injecter une panne de stockage au prochain
 * ordre SQL qui correspond à l'expression donnée (tests de panne et d'atomicité).
 */
export class FakeSql {
  constructor() { this.db = new DatabaseSync(":memory:"); this.failNext = null; this.statements = 0; }
  exec(sql, ...args) {
    if (this.failNext && this.failNext.test(sql)) {
      this.failNext = null;
      throw new Error("storage_fault");
    }
    this.statements++;
    const stmt = this.db.prepare(sql);
    const rows = /^\s*(SELECT|PRAGMA)/i.test(sql) ? stmt.all(...args) : (stmt.run(...args), []);
    return { toArray: () => rows, one: () => rows[0] };
  }
}

/** État d'un Durable Object simulé : storage.sql et transactionSync (synchrone, avec annulation en cas d'erreur). */
export function makeDoState() {
  const sql = new FakeSql();
  return {
    sql,
    storage: {
      sql,
      transactionSync(fn) {
        sql.db.exec("BEGIN");
        try {
          const r = fn();
          sql.db.exec("COMMIT");
          return r;
        } catch (e) {
          sql.db.exec("ROLLBACK");
          throw e;
        }
      }
    }
  };
}

/**
 * Espace de noms de Durable Objects simulé : un objet par nom, chacun avec son propre stockage SQLite.
 * Chaque appel passe par la classe réelle QuotaLimiter. Le paramètre latencyMs est conservé pour compatibilité :
 * le stockage des Durable Objects est synchrone, donc la latence n'a plus d'effet ici.
 */
export function makeNamespace(_latencyMs = 0) {
  const instances = new Map();
  const objects = new Map();
  const ns = {
    instances,
    idFromName: n => n,
    get(name) {
      if (!instances.has(name)) {
        const state = makeDoState();
        objects.set(name, state);
        instances.set(name, new QuotaLimiter(state));
      }
      const obj = instances.get(name);
      return {
        rateHit: async (a) => obj.rateHit(a),
        reserve: async (a) => obj.reserve(a),
        confirm: async (a) => obj.confirm(a),
        release: async (a) => obj.release(a),
        sweepAll: async (t) => obj.sweepAll(t),
        stats: () => obj.stats()
      };
    },
    /** Accès direct au stockage SQL (tests de capacité, de panne et de purge). */
    sqlOf(name) { return objects.get(name)?.sql; }
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
    PROTOCOL_CUTOFF: cutoffIso(now + 30 * 24 * 3600 * 1000),
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

/** Date de transition au format strict exigé par le Worker (AAAA-MM-JJTHH:MM:SSZ, sans millisecondes). */
export function cutoffIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}
