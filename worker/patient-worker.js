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
 *   MAX_MESSAGES_PER_CASE  40 (plafond de messages IA par utilisateur, par cas et par mois)
 *   Quotas de cas : gratuit 5, Premium 150 par mois (constantes FREE_/PREMIUM_CONSULTATIONS_PER_MONTH)
 *   USER_REQUESTS_PER_MINUTE  20
 *   IP_REQUESTS_PER_MINUTE    20
 *
 * Contrat :
 *   POST, en-tête "Authorization: Bearer <ID token Firebase>"
 *   body { persona, facts, step, history, message, question, cas: { id } }
 *   -> 200 { reponse, quota: { plan, used, limit, msgs, msgCap } }
 *   -> 400 contenu invalide (validation stricte) | 401 jeton absent ou invalide
 *   -> 402 quota de cas atteint | 409 plafond de messages du cas atteint | 403 origine ou email non vérifié
 *   -> 429 trop de requêtes | 503 configuration ou stockage indisponible (échec fermé)
 *   -> 502 l'IA n'a pas répondu (le décompte est libéré)
 *
 * Limite assumée : tant que C1 n'est pas traité, le persona et les faits viennent encore du navigateur.
 * La validation réduit la surface (format, taille, caractères), mais ne rend pas le patient inviolable.
 */
import CASE_IDS from "./case-ids.js";
import { parseStrictCutoff } from "./protocol-cutoff.js";

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
const MAX_BODY_BYTES = 65536;   // corps de requête maximal, lu avant validation (F5)
export const CLIENT_PROTOCOL = 2;  // version du contrat navigateur ↔ Worker (en-tête X-SDG-Protocol)
export const AI_TIMEOUT_MS = 60000;   // délai maximal de l'IA avant libération
export const PENDING_TTL_MS = 90000;  // au-delà, une réservation non confirmée est libérée (F7)
export const REQUEST_RETENTION_MS = 48 * 60 * 60 * 1000;  // 1.4-B : durée de vie d'un X-SDG-Request-Id (48 h)
export const MAX_REQUEST_FUTURE_MS = 5 * 60 * 1000;      // tolérance d'horloge du navigateur vers le futur

// Politique des quotas (révisée le 4 novembre 2026, voir docs/quotas-politique.md).
// Ne pas modifier sans validation. Un test (test/policy.test.mjs) vérifie que la documentation concorde.
export const FREE_CONSULTATIONS_PER_MONTH = 5;
export const PREMIUM_CONSULTATIONS_PER_MONTH = 150;

export const DEFAULT_MESSAGES_PER_CASE = 40;
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
  // Fin de la période de transition des anciens navigateurs (ISO 8601 UTC strict, voir protocol-cutoff.js).
  // Obligatoire : une valeur absente, placeholder ou mal formée provoque un échec fermé (503) pour toutes les requêtes.
  // Une date passée n'est PAS refusée ici : c'est le contrôle avant déploiement qui la refuse.
  const cutoff = parseStrictCutoff(env.PROTOCOL_CUTOFF);
  if (msgCap === null || userRpm === null || ipRpm === null || !cutoff.ok) return null;
  return { msgCap, userRpm, ipRpm, protocolCutoffMs: cutoff.ms };
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

  let res;
  try {
    res = await fetchImpl(JWKS_URL);
  } catch (e) {
    throw new Error("jwks_unavailable");   // panne réseau : pas une erreur d'authentification
  }
  if (!res.ok) throw new Error("jwks_unavailable");
  let body;
  try { body = await res.json(); } catch (e) { throw new Error("jwks_invalid"); }
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

/** Mois effectif : un mois antérieur au mois stocké est ramené au mois stocké (F6). */
function effectiveMonth(stored, requested) {
  if (!stored) return requested;
  return requested < stored ? stored : requested;
}

/**
 * Identifiant de requête (1.4-B) : UUID version 7 généré par le navigateur. Les 48 premiers bits sont l'heure de
 * création en millisecondes : l'expiration se calcule sans stockage, donc une requête ancienne ne peut jamais
 * être prise pour une nouvelle, même si son enregistrement a disparu.
 */
const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseRequestId(raw) {
  if (typeof raw !== "string") return null;
  const m = UUID_V7.exec(raw);
  if (!m) return null;
  return { id: raw, ts: parseInt(m[1] + m[2], 16) };
}

/** Empreinte du contenu validé : une même requête doit toujours avoir la même empreinte. */
export async function requestFingerprint(value) {
  const bytes = new TextEncoder().encode(JSON.stringify([
    value.caseId, value.persona, value.facts, value.step, value.hist, value.message
  ]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- Durable Object : quotas atomiques (stockage SQLite structuré, correction B3) ---------- */

/**
 * Schéma du stockage (un objet par utilisateur, et un par adresse IP). Version 1.
 *
 *   meta    : (k, v). k = "month" (mois effectif, AAAA-MM) et "schema" (version du schéma).
 *   rate    : une seule ligne (id = 1) : minute courante et nombre de jetons utilisés.
 *   ledger  : UNE LIGNE PAR RÉSERVATION (rid). Sert au décompte : seules les lignes du mois en cours comptent.
 *             state "p" = en attente de réponse ; "c" = réponse livrée, message compté.
 *   idem    : UNE LIGNE PAR X-SDG-Request-Id (req_id, clé primaire). Mémorise la réponse confirmée pendant 48 h
 *             à partir de la première réception par le Worker (colonne at). Ne compte pas.
 *
 * Pourquoi des lignes et non une valeur par utilisateur : une valeur SQLite est limitée à 2 Mo et réécrire toute
 * la liste à chaque requête coûte de plus en plus cher. Une ligne par requête, indexée, reste petite et se purge
 * par requête SQL.
 *
 * Migration : aucune donnée de production ne dépend de ce stockage (la classe n'est pas encore déployée). Si une
 * version future modifie le schéma, elle doit ajouter un numéro de version dans "meta" et une migration explicite.
 */
export const SCHEMA_VERSION = 1;
export const STORAGE_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rate (id INTEGER PRIMARY KEY CHECK (id = 1), minute INTEGER NOT NULL, n INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS ledger (rid TEXT PRIMARY KEY, month TEXT NOT NULL, case_id TEXT NOT NULL, " +
    "state TEXT NOT NULL CHECK (state IN ('p', 'c')), at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS ledger_month_case ON ledger (month, case_id)",
  "CREATE INDEX IF NOT EXISTS ledger_state_at ON ledger (state, at)",
  "CREATE TABLE IF NOT EXISTS idem (req_id TEXT PRIMARY KEY, rid TEXT NOT NULL, fp TEXT NOT NULL, " +
    "state TEXT NOT NULL CHECK (state IN ('p', 'c')), case_id TEXT NOT NULL, ts INTEGER NOT NULL, " +
    "at INTEGER NOT NULL, answer TEXT)",
  "CREATE INDEX IF NOT EXISTS idem_state_at ON idem (state, at)",
  "CREATE INDEX IF NOT EXISTS idem_rid ON idem (rid)"
];

/** Marge au-delà des 48 h avant purge d'une réponse : garantit qu'un identifiant purgé est toujours refusé (voir reserveSync). */
export const RETENTION_PURGE_MARGIN_MS = MAX_REQUEST_FUTURE_MS;

/**
 * Un objet par utilisateur (et un par adresse IP). Les appels sont exécutés l'un après l'autre (file "run") et
 * chacun s'exécute dans une transaction SQLite synchrone : une erreur au milieu annule tout (aucun décompte partiel).
 */
export class QuotaLimiter {
  constructor(state) {
    this.state = state;
    this.sql = state.storage.sql;
    this.queue = Promise.resolve();
    for (const stmt of STORAGE_SCHEMA) this.sql.exec(stmt).toArray();
    this.sql.exec("INSERT OR IGNORE INTO meta (k, v) VALUES ('schema', ?)", String(SCHEMA_VERSION)).toArray();
  }

  run(job) {
    const result = this.queue.then(job, job);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  tx(fn) {
    return this.state.storage.transactionSync(fn);
  }

  one(sql, ...args) {
    return this.sql.exec(sql, ...args).toArray()[0];
  }

  exec(sql, ...args) {
    this.sql.exec(sql, ...args).toArray();
  }

  /** Limite de débit : un jeton par requête, dans la minute courante. Synchrone (appelé dans une transaction). */
  takeRate(minute, rpm) {
    const cur = this.one("SELECT minute, n FROM rate WHERE id = 1");
    const n = cur && cur.minute === minute ? cur.n : 0;
    if (n >= rpm) return false;
    this.exec(
      "INSERT INTO rate (id, minute, n) VALUES (1, ?, ?) ON CONFLICT (id) DO UPDATE SET minute = excluded.minute, n = excluded.n",
      minute, n + 1
    );
    return true;
  }

  /** Mois effectif (monotone, F6). Ne supprime que les décomptes des mois passés, jamais une réservation en attente. */
  rollMonth(requested) {
    const row = this.one("SELECT v FROM meta WHERE k = 'month'");
    const stored = row ? row.v : null;
    const month = effectiveMonth(stored, requested);
    if (stored !== month) {
      this.exec("DELETE FROM ledger WHERE month < ? AND state = 'c'", month);
      this.exec("INSERT INTO meta (k, v) VALUES ('month', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", month);
    }
    return month;
  }

  usedCount(month) {
    return this.one("SELECT COUNT(DISTINCT case_id) AS n FROM ledger WHERE month = ?", month).n;
  }

  caseCount(month, caseId) {
    return this.one("SELECT COUNT(*) AS n FROM ledger WHERE month = ? AND case_id = ?", month, caseId).n;
  }

  /**
   * Maintenance, exécutée avant chaque opération.
   *  - libère les réservations non confirmées depuis plus de PENDING_TTL_MS (F7) ;
   *  - supprime les requêtes « en attente » sans réservation (orphelines) ;
   *  - supprime les réponses mémorisées plus anciennes que REQUEST_RETENTION_MS + marge (48 h, heure de réception).
   * Ne supprime jamais une réservation encore active (moins de PENDING_TTL_MS).
   */
  sweepSync(nowMs) {
    this.exec("DELETE FROM ledger WHERE state = 'p' AND at < ?", nowMs - PENDING_TTL_MS);
    this.exec(
      "DELETE FROM idem WHERE state = 'p' AND at < ? AND rid NOT IN (SELECT rid FROM ledger)",
      nowMs - PENDING_TTL_MS
    );
    this.exec("DELETE FROM idem WHERE state = 'c' AND at + ? < ?", REQUEST_RETENTION_MS + RETENTION_PURGE_MARGIN_MS, nowMs);
  }

  /** Limite de débit seule (utilisée pour les adresses IP). */
  rateHit({ minute, rpm }) {
    return this.run(() => this.tx(() => ({ ok: this.takeRate(minute, rpm) })));
  }

  /**
   * Réserve une consultation (un message IA), dans une seule transaction.
   *
   * Ordre des vérifications (correction B2) :
   *  1. Si l'identifiant de requête est connu, son enregistrement est consulté AVANT tout contrôle d'horodatage :
   *     - contenu différent : « conflict » (409) ;
   *     - réponse confirmée encore conservée (moins de 48 h depuis la première réception) : « replay » (200), sans
   *       appel IA et sans décompte ;
   *     - réponse confirmée mais conservation terminée : « expired » (410) ;
   *     - réservation en cours : « in_progress » (409).
   *  2. Identifiant inconnu : trop ancien (plus de 48 h, heure encodée) → « expired » (410) ; trop loin dans le futur
   *     → « future » (400). Aucune trace n'est écrite dans ces deux cas.
   *  3. Débit, quota de cas, plafond de messages, puis réservation (lignes « ledger » et « idem » dans la transaction).
   *
   * Pourquoi l'ordre 2 après 1 : un identifiant est « expiré » pour l'idempotence quand il est inconnu ET trop ancien.
   * Un identifiant connu dont la réponse est encore conservée doit être rejoué, même si son heure encodée est ancienne.
   */
  reserve(a) {
    return this.run(() => this.tx(() => this.reserveSync(a)));
  }

  reserveSync({ month, caseId, minute, rpm, quotaLimit, msgCap, rid, nowMs, reqId, reqTs, fp }) {
    const now = nowMs ?? Date.now();
    const current = this.rollMonth(month);
    this.sweepSync(now);

    if (reqId) {
      const rec = this.one("SELECT rid, fp, state, case_id, at, answer FROM idem WHERE req_id = ?", reqId);
      if (rec) {
        if (rec.fp !== fp) return { ok: false, reason: "conflict" };
        if (rec.state === "c") {
          if (rec.at + REQUEST_RETENTION_MS <= now) return { ok: false, reason: "expired" };
          return {
            ok: true, replay: true, answer: rec.answer,
            used: this.usedCount(current), msgs: this.caseCount(current, rec.case_id), month: current
          };
        }
        return { ok: false, reason: "in_progress" };
      }
      if (reqTs < now - REQUEST_RETENTION_MS) return { ok: false, reason: "expired" };
      if (reqTs > now + MAX_REQUEST_FUTURE_MS) return { ok: false, reason: "future" };
    }

    if (!this.takeRate(minute, rpm)) return { ok: false, reason: "rate" };

    const used = this.usedCount(current);
    const count = this.caseCount(current, caseId);
    if (count === 0 && used >= quotaLimit) return { ok: false, reason: "quota", used, msgs: 0 };
    if (count >= msgCap) return { ok: false, reason: "messages", used, msgs: count };

    const id = rid ?? crypto.randomUUID();
    this.exec("INSERT INTO ledger (rid, month, case_id, state, at) VALUES (?, ?, ?, 'p', ?)", id, current, caseId, now);
    if (reqId) {
      this.exec(
        "INSERT INTO idem (req_id, rid, fp, state, case_id, ts, at, answer) VALUES (?, ?, ?, 'p', ?, ?, ?, NULL)",
        reqId, id, fp, caseId, reqTs, now
      );
    }
    return { ok: true, rid: id, used: count === 0 ? used + 1 : used, msgs: count + 1, month: current };
  }

  /**
   * Confirme une réservation : la réponse est livrée, le message reste compté.
   * Une réservation expirée n'est jamais confirmée : elle est libérée et la réponse doit être refusée.
   */
  confirm({ rid, reqId, answer, nowMs }) {
    return this.run(() => this.tx(() => this.confirmSync({ rid, reqId, answer, nowMs })));
  }

  confirmSync({ rid, reqId, answer, nowMs }) {
    const now = nowMs ?? Date.now();
    const row = this.one("SELECT state, at FROM ledger WHERE rid = ?", rid);
    if (!row || row.state !== "p") return { ok: false, reason: "unknown" };
    if (now - row.at > PENDING_TTL_MS) {
      this.releaseSync(rid, reqId);
      return { ok: false, reason: "expired" };
    }
    this.exec("UPDATE ledger SET state = 'c' WHERE rid = ?", rid);
    // at (première réception) n'est pas modifié : la conservation de 48 h court depuis la première réception.
    if (reqId) this.exec("UPDATE idem SET state = 'c', answer = ? WHERE req_id = ? AND rid = ?", answer, reqId, rid);
    return { ok: true };
  }

  /** Libère une réservation (l'IA a échoué). Idempotent : une seconde libération ne retire rien. */
  release({ rid, reqId }) {
    return this.run(() => this.tx(() => this.releaseSync(rid, reqId)));
  }

  releaseSync(rid, reqId) {
    const row = this.one("SELECT state FROM ledger WHERE rid = ?", rid);
    if (!row || row.state !== "p") return { ok: true, skipped: true };
    this.exec("DELETE FROM ledger WHERE rid = ?", rid);
    // La requête idempotente n'est retirée que si elle attend encore cette réservation : une nouvelle tentative
    // pourra alors réserver de nouveau, sans double décompte puisque la première réservation est annulée.
    if (reqId) this.exec("DELETE FROM idem WHERE req_id = ? AND rid = ? AND state = 'p'", reqId, rid);
    return { ok: true };
  }

  /** Maintenance explicite (tests et capacité). En service, elle est déjà appelée à chaque réservation. */
  sweepAll(nowMs) {
    return this.run(() => this.tx(() => this.sweepSync(nowMs ?? Date.now())));
  }

  /** Taille du stockage (tests de capacité uniquement). */
  stats() {
    return {
      ledger: this.one("SELECT COUNT(*) AS n FROM ledger").n,
      idem: this.one("SELECT COUNT(*) AS n FROM idem").n
    };
  }
}

/** Lit le corps sans dépasser max octets. Retourne null si le corps est trop grand (F5). */
async function readBoundedText(request, max) {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch (e) { /* ignoré */ }
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** Délai maximal d'une promesse : l'IA ne peut pas bloquer une réservation au-delà de AI_TIMEOUT_MS. */
function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("ai_timeout")), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/* ---------- Gestionnaire HTTP ---------- */

export async function handleRequest(request, env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const jwksCache = opts.jwksCache ?? defaultJwksCache;
  const aiTimeoutMs = opts.aiTimeoutMs ?? AI_TIMEOUT_MS;
  const projectId = env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID;

  const allowed = (env.ALLOWED_ORIGIN || DEFAULT_ORIGIN).split(",").map(s => s.trim());
  const origin = request.headers.get("Origin") || "";
  const cors = {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-SDG-Protocol, X-SDG-Request-Id",
    "Access-Control-Expose-Headers": "Date, X-SDG-Upgrade",
    "Vary": "Origin"
  };
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (request.method !== "POST") return json({ error: "method" }, 405, cors);
  if (!allowed.includes(origin)) return json({ error: "origin" }, 403, cors);

  // Observation des anciens navigateurs (migration, voir docs/migration-anciens-clients.md). Ne journalise ni uid ni IP :
  // seulement la présence d'un jeton et l'heure, pour mesurer combien d'anciens clients restent actifs.
  if (request.headers.get("X-SDG-Protocol") === null) {
    console.log(JSON.stringify({ evt: "sans_protocole", avec_jeton: (request.headers.get("Authorization") || "") !== "", at: nowMs }));
  }

  // Échec fermé : sans stockage des quotas, aucune réponse IA.
  if (!env.STATE || !env.QUOTA) return json({ error: "config" }, 503, cors);
  const cfg = readConfig(env);
  if (!cfg) return json({ error: "config" }, 503, cors);

  // 1. Limite de débit par adresse IP, avant toute lecture du corps (F5).
  const ip = request.headers.get("CF-Connecting-IP") || "inconnu";
  try {
    const ipStub = env.QUOTA.get(env.QUOTA.idFromName("ip:" + ip));
    const r = await ipStub.rateHit({ minute: minuteKey(nowMs), rpm: cfg.ipRpm });
    if (!r.ok) return json({ error: "rate" }, 429, cors);
  } catch (e) {
    return json({ error: "unavailable" }, 503, cors);
  }

  // 2. Corps borné, puis validation stricte (F5).
  let text;
  try { text = await readBoundedText(request, MAX_BODY_BYTES); } catch (e) { return json({ error: "json" }, 400, cors); }
  if (text === null) return json({ error: "too_large" }, 413, cors);
  let body;
  try { body = JSON.parse(text); } catch (e) { return json({ error: "json" }, 400, cors); }
  const checked = validateContent(body);
  if (!checked.ok) return json({ error: checked.error }, 400, cors);
  const { caseId, persona, facts, step, hist, message } = checked.value;

  // 3. Authentification. Une panne des clés Google est une erreur technique (503), pas un refus (F4).
  const authz = request.headers.get("Authorization") || "";
  if (!authz.startsWith("Bearer ")) return json({ error: "auth" }, 401, cors);
  let user;
  try {
    user = await verifyIdToken(authz.slice(7).trim(), { projectId, nowMs, fetchImpl, jwksCache });
  } catch (e) {
    if (e && (e.message === "jwks_unavailable" || e.message === "jwks_invalid")) {
      return json({ error: "unavailable" }, 503, cors);
    }
    return json({ error: "auth" }, 401, cors);
  }
  if (!user.emailVerified) return json({ error: "email_unverified" }, 403, cors);

  // 4. Version du contrat navigateur. Période de transition (1.4-C) : avertissement, puis 426 après la date limite.
  // Les quotas et la réservation ne dépendent pas de cet en-tête : ils s'appliquent dans tous les cas.
  const clientProtocol = Number.parseInt(request.headers.get("X-SDG-Protocol") || "0", 10) || 0;
  const compatible = clientProtocol >= CLIENT_PROTOCOL;
  if (!compatible && nowMs >= cfg.protocolCutoffMs) {
    return json({ error: "upgrade_required" }, 426, cors);
  }
  const extra = compatible ? {} : { "X-SDG-Upgrade": "requis" };

  // 5. Identifiant de requête (1.4-B). Absent : comportement de transition, sans idempotence.
  // Présent : seul le FORMAT est vérifié ici. L'expiration n'est jugée qu'après consultation de l'enregistrement
  // (correction B2, voir QuotaLimiter.reserveSync) : une réponse encore conservée se rejoue même si l'heure encodée
  // dans l'identifiant est ancienne.
  let reqId = null;
  let reqTs = null;
  const rawReqId = request.headers.get("X-SDG-Request-Id");
  if (rawReqId !== null) {
    const parsed = parseRequestId(rawReqId);
    if (!parsed) return json({ error: "request_id" }, 400, cors);
    reqId = parsed.id;
    reqTs = parsed.ts;
  }

  // 6. Formule et quotas (réservation atomique, identifiée par rid).
  let plan;
  try {
    plan = await getPlan(env.STATE, user.uid, nowMs);
  } catch (e) {
    return json({ error: "unavailable" }, 503, cors);
  }
  const limit = plan === "premium" ? PREMIUM_CONSULTATIONS_PER_MONTH : FREE_CONSULTATIONS_PER_MONTH;
  const month = monthKey(nowMs);
  const stub = env.QUOTA.get(env.QUOTA.idFromName("uid:" + user.uid));
  const rid = crypto.randomUUID();
  const fp = reqId ? await requestFingerprint(checked.value) : null;

  let reservation;
  try {
    reservation = await stub.reserve({
      month, caseId, minute: minuteKey(nowMs), rpm: cfg.userRpm, quotaLimit: limit, msgCap: cfg.msgCap,
      rid, nowMs, reqId, reqTs, fp
    });
  } catch (e) {
    return json({ error: "unavailable" }, 503, cors);
  }
  const quota = (r) => ({ plan, used: r.used, limit, msgs: r.msgs, msgCap: cfg.msgCap });

  // Requête déjà confirmée : on renvoie la réponse mémorisée, sans appel IA ni nouveau décompte.
  if (reservation.ok && reservation.replay) {
    return json({ reponse: reservation.answer, quota: quota(reservation), replay: true }, 200, { ...cors, ...extra });
  }
  if (!reservation.ok) {
    if (reservation.reason === "conflict") return json({ error: "request_conflict" }, 409, cors);
    if (reservation.reason === "in_progress") return json({ error: "in_progress" }, 409, cors);
    if (reservation.reason === "expired") return json({ error: "request_expired" }, 410, cors);
    if (reservation.reason === "future") return json({ error: "request_id" }, 400, cors);
    const status = reservation.reason === "rate" ? 429 : reservation.reason === "messages" ? 409 : 402;
    return json({ error: reservation.reason, quota: quota(reservation) }, status, cors);
  }

  // 7. Génération. La réservation n'est confirmée qu'au moment où la réponse est livrée.
  // Dans tous les autres cas (IA en échec, délai, exception, confirmation refusée), elle est libérée (F7).
  let confirmed = false;
  try {
    const messages = [
      { role: "system", content: buildSystem(persona, facts, step) },
      ...hist,
      { role: "user", content: message }
    ];
    let reply = null;
    try {
      const out = await withTimeout(env.AI.run(MODEL, { messages, temperature: 0.9, max_tokens: 220 }), aiTimeoutMs);
      reply = out && (out.response || out.result && out.result.response);
    } catch (e) {
      reply = null;
    }
    if (!reply || !String(reply).trim()) return json({ error: "unavailable" }, 502, cors);

    const answer = String(reply).trim().slice(0, 800);
    const done = await stub.confirm({ rid, reqId, fp, reqTs, answer, nowMs });
    if (!done || done.ok !== true) return json({ error: "unavailable" }, 503, cors);
    confirmed = true;
    return json({ reponse: answer, quota: quota(reservation) }, 200, { ...cors, ...extra });
  } catch (e) {
    return json({ error: "unavailable" }, 503, cors);
  } finally {
    if (!confirmed) {
      try { await stub.release({ rid, reqId }); } catch (e) { /* la réservation expirera après PENDING_TTL_MS */ }
    }
  }
}

export default {
  async fetch(request, env) {
    const nowMs = Date.now();
    const res = await handleRequest(request, env, { nowMs });
    // Le navigateur lit l'heure du Worker pour calculer les identifiants de requête (exposée en CORS).
    const headers = new Headers(res.headers);
    headers.set("Date", new Date(nowMs).toUTCString());
    return new Response(res.body, { status: res.status, headers });
  }
};
