/*
 * Salle de Garde — Worker du patient virtuel (Phase 1 : sécurisation).
 *
 * Liaisons requises :
 *   - AI     : Workers AI (génération des réponses du patient)
 *   - STATE  : Workers KV (plans, quotas mensuels, limite de débit par utilisateur)
 *
 * Variables optionnelles :
 *   - ALLOWED_ORIGIN       : "https://salledegarde.online" (défaut)
 *   - FIREBASE_PROJECT_ID  : "salledegarde-89dae" (défaut)
 *   - RATE                 : KV optionnel, limite par IP (20 requêtes / minute)
 *
 * Contrat :
 *   POST, en-tête "Authorization: Bearer <ID token Firebase>"
 *   body { persona, facts, step, history, message, question, cas: { id, ... } }
 *   -> 200 { reponse, quota: { plan, used, limit } }
 *   -> 401 jeton absent ou invalide | 402 quota mensuel atteint | 403 origine ou email non vérifié
 *   -> 429 trop de requêtes | 503 stockage non configuré (échec fermé)
 *
 * Sécurité :
 *   - Le jeton Firebase est vérifié (signature RS256, émetteur, audience, expiration).
 *   - Le quota est appliqué côté serveur ; le navigateur ne peut pas le modifier.
 *   - Sans liaison STATE, le Worker refuse de répondre plutôt que de laisser passer.
 *
 * Limite connue (Phase 1) : le Worker ne connaît pas encore le contenu des cas.
 * L'identifiant de cas est fourni par le client et sert au décompte des consultations.
 */

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_MSG = 600, MAX_HIST = 12, MAX_FACTS = 6000, MAX_PERSONA = 600, MAX_CASE_ID = 80;

// Quotas mensuels de consultations IA (nombre de cas distincts par mois, UTC).
// Valeur Premium indicative : à valider avec la politique d'usage équitable.
const FREE_CONSULTATIONS_PER_MONTH = 5;
const PREMIUM_CONSULTATIONS_PER_MONTH = 60;

const USER_REQUESTS_PER_MINUTE = 20;
const IP_REQUESTS_PER_MINUTE = 20;
const CLOCK_SKEW_SECONDS = 300;
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const JWKS_TTL_MS = 60 * 60 * 1000;
const DEFAULT_PROJECT_ID = "salledegarde-89dae";
const DEFAULT_ORIGIN = "https://salledegarde.online";

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

/* ---------- Vérification des jetons Firebase ---------- */

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

const defaultJwksCache = { keys: null, expiresAt: 0 };

async function getJwks(fetchImpl, nowMs, cache) {
  if (cache.keys && cache.expiresAt > nowMs) return cache.keys;
  const res = await fetchImpl(JWKS_URL);
  if (!res.ok) throw new Error("jwks_unavailable");
  const body = await res.json();
  if (!body || !Array.isArray(body.keys)) throw new Error("jwks_invalid");
  cache.keys = body.keys;
  cache.expiresAt = nowMs + JWKS_TTL_MS;
  return cache.keys;
}

/**
 * Vérifie un ID token Firebase. Lève une erreur si le jeton n'est pas valide.
 * Retourne { uid, email, emailVerified }.
 */
export async function verifyIdToken(token, { projectId = DEFAULT_PROJECT_ID, nowMs = Date.now(), fetchImpl = fetch, jwksCache = defaultJwksCache } = {}) {
  if (typeof token !== "string" || token.length > 4096) throw new Error("invalid_token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_token");

  const header = b64urlToJson(parts[0]);
  const payload = b64urlToJson(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("invalid_token");

  const keys = await getJwks(fetchImpl, nowMs, jwksCache);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error("invalid_token");

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

/* ---------- Plans, quotas et limites de débit (KV STATE) ---------- */

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

async function getUsedCases(state, uid, nowMs) {
  const raw = await state.get("usage:" + uid + ":" + monthKey(nowMs));
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(x => typeof x === "string") : [];
  } catch (e) { return []; }
}

async function recordCase(state, uid, caseId, usedCases, nowMs) {
  const next = [...usedCases, caseId];
  await state.put("usage:" + uid + ":" + monthKey(nowMs), JSON.stringify(next), { expirationTtl: 60 * 60 * 24 * 40 });
  return next;
}

async function hitMinuteLimit(kv, key, limit) {
  const n = parseInt((await kv.get(key)) || "0", 10);
  if (n >= limit) return true;
  await kv.put(key, String(n + 1), { expirationTtl: 120 });
  return false;
}

/* ---------- Gestionnaire HTTP ---------- */

export async function handleRequest(request, env, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
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

  // Échec fermé : sans stockage, pas de quota possible, donc pas de réponse.
  if (!env.STATE) return json({ error: "config" }, 503, cors);

  if (env.RATE) {
    const ip = request.headers.get("CF-Connecting-IP") || "inconnu";
    if (await hitMinuteLimit(env.RATE, "rl:" + ip + ":" + Math.floor(nowMs / 60000), IP_REQUESTS_PER_MINUTE)) {
      return json({ error: "rate" }, 429, cors);
    }
  }

  // 1. Authentification
  const authz = request.headers.get("Authorization") || "";
  if (!authz.startsWith("Bearer ")) return json({ error: "auth" }, 401, cors);
  let user;
  try {
    user = await verifyIdToken(authz.slice(7).trim(), { projectId, nowMs, fetchImpl, jwksCache: opts.jwksCache ?? defaultJwksCache });
  } catch (e) {
    return json({ error: "auth" }, 401, cors);
  }
  if (!user.emailVerified) return json({ error: "email_unverified" }, 403, cors);

  // 2. Limite de débit par utilisateur
  if (await hitMinuteLimit(env.STATE, "urate:" + user.uid + ":" + Math.floor(nowMs / 60000), USER_REQUESTS_PER_MINUTE)) {
    return json({ error: "rate" }, 429, cors);
  }

  // 3. Validation du contenu
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "json" }, 400, cors); }
  const { persona, facts, step, history, message, cas } = body || {};
  if (typeof message !== "string" || !message.trim() || message.length > MAX_MSG) return json({ error: "message" }, 400, cors);
  if (typeof facts !== "string" || facts.length > MAX_FACTS) return json({ error: "facts" }, 400, cors);
  if (typeof persona !== "string" || persona.length > MAX_PERSONA) return json({ error: "persona" }, 400, cors);
  const caseId = cas && typeof cas.id === "string" ? cas.id : "";
  if (!caseId || caseId.length > MAX_CASE_ID) return json({ error: "cas" }, 400, cors);

  // 4. Quota mensuel : un cas distinct compte pour une consultation
  const plan = await getPlan(env.STATE, user.uid, nowMs);
  const limit = plan === "premium" ? PREMIUM_CONSULTATIONS_PER_MONTH : FREE_CONSULTATIONS_PER_MONTH;
  const usedCases = await getUsedCases(env.STATE, user.uid, nowMs);
  const alreadyCounted = usedCases.includes(caseId);
  if (!alreadyCounted && usedCases.length >= limit) {
    return json({ error: "quota", quota: { plan, used: usedCases.length, limit } }, 402, cors);
  }

  const hist = Array.isArray(history) ? history.slice(-MAX_HIST)
    .filter(m => m && typeof m.t === "string")
    .map(m => ({ role: m.r === "d" ? "user" : "assistant", content: m.t.slice(0, MAX_MSG) })) : [];

  const messages = [
    { role: "system", content: buildSystem(persona, facts, String(step || "Anamnèse").slice(0, 40)) },
    ...hist,
    { role: "user", content: message.trim() }
  ];

  // 5. Génération. Le quota n'est décompté qu'après une réponse réussie.
  try {
    const out = await env.AI.run(MODEL, { messages, temperature: 0.9, max_tokens: 220 });
    const text = out && (out.response || out.result && out.result.response);
    if (!text || !String(text).trim()) return json({ error: "unavailable" }, 502, cors);

    let counted = usedCases;
    if (!alreadyCounted) counted = await recordCase(env.STATE, user.uid, caseId, usedCases, nowMs);
    return json({
      reponse: String(text).trim().slice(0, 800),
      quota: { plan, used: counted.length, limit }
    }, 200, cors);
  } catch (e) {
    return json({ error: "unavailable" }, 502, cors);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  }
};
