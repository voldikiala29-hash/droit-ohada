/*
 * Salle de Garde — Worker du patient virtuel (Phase 1, C2 durci).
 *
 * Liaisons (voir wrangler.toml et worker/README.md) :
 *   AI     : Workers AI, génération des réponses du patient.
 *   STATE  : Workers KV, LECTURE SEULE. Contient "plan:<uid>" (formule Premium et date de fin).
 *   QUOTA  : Durable Object QuotaLimiter. Quotas, plafond de messages et limites de débit,
 *            appliqués de façon atomique (une requête à la fois par utilisateur).
 *
 * Variables (optionnelles) :
 *   ALLOWED_ORIGIN         "https://salledegarde.online"
 *   FIREBASE_PROJECT_ID    "salledegarde-89dae"
 *   MAX_MESSAGES_PER_CASE  40 (plafond de messages IA par cas et par mois)
 *   USER_REQUESTS_PER_MINUTE  20
 *   IP_REQUESTS_PER_MINUTE    20
 *
 * Contrat :
 *   POST, en-tête "Authorization: Bearer <ID token Firebase>"
 *   body { persona, facts, step, history, message, question, cas: { id } }
 *   -> 200 { reponse, quota: { plan, used, limit, msgs, msgCap } }
 *   -> 400 contenu invalide (validation stricte) | 401 jeton absent ou invalide
 *   -> 402 quota de cas ou plafond de messages atteint | 403 origine ou email non vérifié
 *   -> 429 trop de requêtes | 503 configuration ou stockage indisponible (échec fermé)
 *   -> 502 l'IA n'a pas répondu (le décompte est libéré)
 *
 * Limite assumée : tant que C1 n'est pas traité, le persona et les faits viennent encore du navigateur.
 * La validation réduit la surface (format, taille, caractères), mais ne rend pas le patient inviolable.
 */
import CASE_IDS from "./case-ids.js";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_MSG = 600;            // taille d'un message (utilisateur ou patient)
const MAX_HIST = 12;            // messages d'historique transmis à l'IA
const MAX_HIST_INPUT = 50;      // au-delà, la requête est refusée
const MAX_FACTS = 6000;
const MAX_FACT_LINES = 60;
const MAX_FACT_LINE = 400;
const MAX_PERSONA = 600;
const MAX_CASE_ID = 80;
const ALLOWED_STEPS = ["Anamnèse", "Examen clinique", "Paraclinique", "Conclusion"];
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// Quotas commerciaux : ne pas modifier sans validation (voir docs/securite-phase-1.md).
const FREE_CONSULTATIONS_PER_MONTH = 5;
const PREMIUM_CONSULTATIONS_PER_MONTH = 60;

const DEFAULT_MESSAGES_PER_CASE = 40;
const DEFAULT_USER_RPM = 20;
const DEFAULT_IP_RPM = 20;
const CLOCK_SKEW_SECONDS = 300;
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const JWKS_TTL_MS = 60 * 60 * 1000;
const JWKS_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_PROJECT_ID = "salledegarde-89dae";
const DEFAULT_ORIGIN = "https://salledegarde.online";

const CASE_ID_SET = new Set(CASE_IDS);

function buildSystem(persona, facts, step) {
  return [
    "Tu joues un patient réel dans un hôpital d'Afrique francophone, pendant une consultation d'étudiant en médecine. Tu n'es PAS une intelligence artificielle : tu ne sors jamais de ce rôle.",
    persona,
    "Parle comme une vraie personne : phrases courtes et naturelles, 1 à 3 phrases, français simple et familier, avec les expressions de la vie de tous les jours. Tu peux faire de légères fautes de frappe. Pas de liste, pas de titre, pas de markdown, pas de guillemets.",
    "Étape actuelle de la consultation : " + step + ".",
    "FAITS QUE TU CONNAIS (respecte-les, ne les contredis jamais, dis-les naturellement quand on te les demande) :\n" + facts,
    "Règles :",
    "- Si on te demande quelque chose que les faits ne couvrent pas (ce que tu as mangé, ton sommeil, ton travail, comment tu vas…), réponds naturellement avec des détails de la vie de tous les jours, cohérents et anodins. N'invente jamais de symptôme, de maladie, de traitement ou d'antécédent.",
    "- Si on te demande un symptôme que tu n'as pas, nie-le simplement.",
    "- Ne donne JAMAIS de diagnostic ni de nom de maladie. Si on te le demande : « Je ne sais pas docteur, aidez-moi. »",
    "- Ne dis jamais « je ne comprends pas ». Si la question est confuse, demande gentiment de reformuler en rappelant ce qui te gêne.",
    "- Ne propose pas toi-même d'examen ni de traitement.",
    "- Le médecin peut faire des fautes de frappe, écrire en abrégé, ou mêler un peu de mots d'une langue locale africaine à son français : comprends-le toujours et réponds comme si de rien n'était.",
    "- Réponds en français simple et naturel, comme une personne ordinaire d'Afrique francophone. Pas d'accent ni d'expression régionale marquée, pas de phrase entière dans une autre langue, pas de caricature."
  ].join("\n");
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

/* ---------- Validation stricte du contenu ---------- */

/**
 * Valide le corps de la requête selon le format réel produit par Salle de Garde :
 * persona = "Tu es ...", facts = lignes "- ...", step parmi les quatre étapes,
 * history = messages { r: "d" | "p", t }, cas.id = identifiant d'un des 302 cas.
 */
export function validateContent(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "json" };
  const { persona, facts, step, history, message, cas } = body;

  if (typeof message !== "string") return { ok: false, error: "message" };
  const msg = message.normalize("NFC").trim();
  if (!msg || msg.length > MAX_MSG || CONTROL.test(msg)) return { ok: false, error: "message" };

  if (typeof persona !== "string" || persona.length > MAX_PERSONA || !persona.startsWith("Tu es ") ||
      /[\r\n]/.test(persona) || CONTROL.test(persona)) {
    return { ok: false, error: "persona" };
  }

  if (typeof facts !== "string" || facts.length > MAX_FACTS) return { ok: false, error: "facts" };
  const lines = facts.split("\n");
  if (lines.length > MAX_FACT_LINES) return { ok: false, error: "facts" };
  for (const line of lines) {
    if (!line.startsWith("- ") || line.length > MAX_FACT_LINE || CONTROL.test(line)) return { ok: false, error: "facts" };
  }

  if (!ALLOWED_STEPS.includes(step)) return { ok: false, error: "step" };

  let hist = [];
  if (history !== undefined && history !== null) {
    if (!Array.isArray(history) || history.length > MAX_HIST_INPUT) return { ok: false, error: "history" };
    for (const m of history) {
      if (!m || (m.r !== "d" && m.r !== "p") || typeof m.t !== "string" || CONTROL.test(m.t)) {
        return { ok: false, error: "history" };
      }
    }
    // Les réponses déjà affichées peuvent dépasser la taille d'un message : on les tronque sans refuser.
    hist = history.slice(-MAX_HIST).map(m => ({
      role: m.r === "d" ? "user" : "assistant",
      content: m.t.slice(0, MAX_MSG)
    }));
  }

  const caseId = cas && typeof cas.id === "string" ? cas.id : "";
  if (!caseId || caseId.length > MAX_CASE_ID || !CASE_ID_SET.has(caseId)) return { ok: false, error: "cas" };

  return { ok: true, value: { caseId, persona, facts, step, hist, message: msg } };
}

/* ---------- Configuration ---------- */

function parseIntEnv(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const s = String(raw);
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 1000 ? n : null;
}

/** Retourne null si une variable est présente mais invalide : échec fermé. */
export function readConfig(env) {
  const msgCap = parseIntEnv(env.MAX_MESSAGES_PER_CASE, DEFAULT_MESSAGES_PER_CASE);
  const userRpm = parseIntEnv(env.USER_REQUESTS_PER_MINUTE, DEFAULT_USER_RPM);
  const ipRpm = parseIntEnv(env.IP_REQUESTS_PER_MINUTE, DEFAULT_IP_RPM);
  if (msgCap === null || userRpm === null || ipRpm === null) return null;
  return { msgCap, userRpm, ipRpm };
}

/* ---------- Jetons Firebase ---------- */

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(str.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(str) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(str)));
}

const defaultJwksCache = { keys: null, expiresAt: 0, lastFetch: 0 };

/**
 * Retourne la clé correspondant au kid.
 * - Cache valide et kid connu : utilisé sans appel réseau.
 * - Kid inconnu (rotation des clés) : rechargement, au plus une fois par JWKS_REFRESH_COOLDOWN_MS,
 *   pour éviter qu'un attaquant fasse appeler Google en boucle avec de faux kid.
 */
async function findKey(kid, fetchImpl, nowMs, cache) {
  const fresh = cache.keys !== null && cache.expiresAt > nowMs;
  if (fresh) {
    const hit = cache.keys.find(k => k.kid === kid);
    if (hit) return hit;
  }
  // Cache absent, expiré, ou kid inconnu : on recharge, sauf si le dernier rechargement est trop récent.
  const mayRefetch = cache.keys === null || !fresh || nowMs - cache.lastFetch >= JWKS_REFRESH_COOLDOWN_MS;
  if (!mayRefetch) throw new Error("invalid_token");

  const res = await fetchImpl(JWKS_URL);
  if (!res.ok) throw new Error("jwks_unavailable");
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) throw new Error("jwks_invalid");
  cache.keys = body.keys;
  cache.expiresAt = nowMs + JWKS_TTL_MS;
  cache.lastFetch = nowMs;

  const hit = cache.keys.find(k => k.kid === kid);
  if (!hit) throw new Error("invalid_token");
  return hit;
}

/**
 * Vérifie un ID token Firebase : RS256, signature, émetteur, audience, expiration, sujet.
 * Retourne { uid, email, emailVerified } ou lève une erreur.
 */
export async function verifyIdToken(token, { projectId = DEFAULT_PROJECT_ID, nowMs = Date.now(), fetchImpl = fetch, jwksCache = defaultJwksCache } = {}) {
  if (typeof token !== "string" || token.length > 4096) throw new Error("invalid_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_token");

  const header = b64urlToJson(parts[0]);
  const payload = b64urlToJson(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("invalid_token");

  const jwk = await findKey(header.kid, fetchImpl, nowMs, jwksCache);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const signed = new TextEncoder().encode(parts[0] + "." + parts[1]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), signed);
  if (!valid) throw new Error("invalid_token");

  const nowSec = Math.floor(nowMs / 1000);
  if (payload.iss !== "https://securetoken.google.com/" + projectId) throw new Error("invalid_token");
  if (payload.aud !== projectId) throw new Error("invalid_token");
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) throw new Error("invalid_token");
  if (typeof payload.iat !== "number" || payload.iat > nowSec + CLOCK_SKEW_SECONDS) throw new Error("invalid_token");
  if (payload.auth_time !== undefined && (typeof payload.auth_time !== "number" || payload.auth_time > nowSec + CLOCK_SKEW_SECONDS)) throw new Error("invalid_token");
  if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 128) throw new Error("invalid_token");

  return {
    uid: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
    emailVerified: payload.email_verified === true
  };
}

/* ---------- Formule (lecture seule, KV STATE) ---------- */

async function getPlan(state, uid, nowMs) {
  const raw = await state.get("plan:" + uid);
  if (!raw) return "free";
  try {
    const rec = JSON.parse(raw);
    if (rec && rec.plan === "premium" && typeof rec.until === "string" && Date.parse(rec.until) > nowMs) return "premium";
  } catch (e) { /* enregistrement illisible : formule gratuite */ }
  return "free";
}

function monthKey(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 7);
}

function minuteKey(nowMs) {
  return Math.floor(nowMs / 60000);
}

/* ---------- Durable Object : quotas atomiques ---------- */

/**
 * Un objet par utilisateur (et un par adresse IP). Les appels sont exécutés l'un après l'autre :
 * deux requêtes simultanées ne peuvent plus lire le même état et l'écraser.
 *
 * Stockage :
 *   "month"  : mois en cours (AAAA-MM). Changer de mois efface les compteurs du mois précédent.
 *   "msgs"   : { [caseId]: nombre de messages IA réservés pour ce cas }.
 *              Les cas consommés sont les clés de cet objet ; un cas à 0 message n'est pas compté.
 *   "rate"   : { minute, n } pour la limite de débit.
 */
export class QuotaLimiter {
  constructor(state) {
    this.storage = state.storage;
    this.queue = Promise.resolve();
  }

  run(job) {
    const result = this.queue.then(job, job);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  async takeRateToken(minute, rpm) {
    const cur = await this.storage.get("rate");
    const n = cur && cur.minute === minute ? cur.n : 0;
    if (n >= rpm) return false;
    await this.storage.put("rate", { minute, n: n + 1 });
    return true;
  }

  async rollMonth(month) {
    if ((await this.storage.get("month")) !== month) {
      await this.storage.deleteAll();
      await this.storage.put("month", month);
    }
  }

  /** Limite de débit seule (utilisée pour les adresses IP). */
  rateHit({ minute, rpm }) {
    return this.run(async () => ({ ok: await this.takeRateToken(minute, rpm) }));
  }

  /**
   * Réserve une consultation (un message IA).
   * Refuse si : débit dépassé, quota de cas atteint pour un nouveau cas, ou plafond de messages du cas atteint.
   */
  reserve({ month, caseId, minute, rpm, quotaLimit, msgCap }) {
    return this.run(async () => {
      await this.rollMonth(month);
      if (!(await this.takeRateToken(minute, rpm))) return { ok: false, reason: "rate" };

      const msgs = (await this.storage.get("msgs")) || {};
      const known = Object.prototype.hasOwnProperty.call(msgs, caseId);
      const count = known ? msgs[caseId] : 0;
      const used = Object.keys(msgs).length;

      if (count === 0 && used >= quotaLimit) return { ok: false, reason: "quota", used, msgs: 0 };
      if (count >= msgCap) return { ok: false, reason: "messages", used, msgs: count };

      await this.storage.put("msgs", { ...msgs, [caseId]: count + 1 });
      return { ok: true, used: count === 0 ? used + 1 : used, msgs: count + 1 };
    });
  }

  /** Libère une réservation (l'IA a échoué). Un cas revenu à zéro message n'est plus compté. */
  release({ month, caseId }) {
    return this.run(async () => {
      if ((await this.storage.get("month")) !== month) return { ok: true, skipped: true };
      const msgs = { ...((await this.storage.get("msgs")) || {}) };
      if (!Object.prototype.hasOwnProperty.call(msgs, caseId)) return { ok: true, skipped: true };
      if (msgs[caseId] <= 1) delete msgs[caseId];
      else msgs[caseId] -= 1;
      await this.storage.put("msgs", msgs);
      return { ok: true };
    });
  }
}

/* ---------- Gestionnaire HTTP ---------- */

export async function handleRequest(request, env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const jwksCache = opts.jwksCache ?? defaultJwksCache;
  const projectId = env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID;

  const allowed = (env.ALLOWED_ORIGIN || DEFAULT_ORIGIN).split(",").map(s => s.trim());
  const origin = request.headers.get("Origin") || "";
  const cors = {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return json({ error: "method" }, 405, cors);
  if (!allowed.includes(origin)) return json({ error: "origin" }, 403, cors);

  // Échec fermé : sans stockage des quotas, aucune réponse IA.
  if (!env.STATE || !env.QUOTA) return json({ error: "config" }, 503, cors);
  const cfg = readConfig(env);
  if (!cfg) return json({ error: "config" }, 503, cors);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "json" }, 400, cors); }
  const checked = validateContent(body);
  if (!checked.ok) return json({ error: checked.error }, 400, cors);
  const { caseId, persona, facts, step, hist, message } = checked.value;

  // 1. Limite de débit par adresse IP (avant toute vérification de jeton)
  const ip = request.headers.get("CF-Connecting-IP") || "inconnu";
  try {
    const ipStub = env.QUOTA.get(env.QUOTA.idFromName("ip:" + ip));
    const r = await ipStub.rateHit({ minute: minuteKey(nowMs), rpm: cfg.ipRpm });
    if (!r.ok) return json({ error: "rate" }, 429, cors);
  } catch (e) {
    return json({ error: "unavailable" }, 503, cors);
  }

  // 2. Authentification
  const authz = request.headers.get("Authorization") || "";
  if (!authz.startsWith("Bearer ")) return json({ error: "auth" }, 401, cors);
  let user;
  try {
    user = await verifyIdToken(authz.slice(7).trim(), { projectId, nowMs, fetchImpl, jwksCache });
  } catch (e) {
    return json({ error: "auth" }, 401, cors);
  }
  if (!user.emailVerified) return json({ error: "email_unverified" }, 403, cors);

  // 3. Formule et quotas (réservation atomique)
  let plan;
  try {
    plan = await getPlan(env.STATE, user.uid, nowMs);
  } catch (e) {
    return json({ error: "unavailable" }, 503, cors);
  }
  const limit = plan === "premium" ? PREMIUM_CONSULTATIONS_PER_MONTH : FREE_CONSULTATIONS_PER_MONTH;
  const month = monthKey(nowMs);
  const stub = env.QUOTA.get(env.QUOTA.idFromName("uid:" + user.uid));

  let reservation;
  try {
    reservation = await stub.reserve({
      month, caseId, minute: minuteKey(nowMs), rpm: cfg.userRpm, quotaLimit: limit, msgCap: cfg.msgCap
    });
  } catch (e) {
    return json({ error: "unavailable" }, 503, cors);
  }
  if (!reservation.ok) {
    const status = reservation.reason === "rate" ? 429 : 402;
    return json({
      error: reservation.reason,
      quota: { plan, used: reservation.used, limit, msgs: reservation.msgs, msgCap: cfg.msgCap }
    }, status, cors);
  }

  // 4. Génération. En cas d'échec, la réservation de message est libérée.
  const messages = [
    { role: "system", content: buildSystem(persona, facts, step) },
    ...hist,
    { role: "user", content: message }
  ];
  const release = async () => {
    try { await stub.release({ month, caseId }); } catch (e) { /* journalisé côté Cloudflare */ }
  };

  let text = null;
  try {
    const out = await env.AI.run(MODEL, { messages, temperature: 0.9, max_tokens: 220 });
    text = out && (out.response || out.result && out.result.response);
  } catch (e) {
    text = null;
  }
  if (!text || !String(text).trim()) {
    await release();
    return json({ error: "unavailable" }, 502, cors);
  }

  return json({
    reponse: String(text).trim().slice(0, 800),
    quota: { plan, used: reservation.used, limit, msgs: reservation.msgs, msgCap: cfg.msgCap }
  }, 200, cors);
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};
