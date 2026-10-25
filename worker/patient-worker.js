/*
 * Salle de Garde — Worker du patient virtuel (Cloudflare Worker, module).
 * Les clés API restent ICI, dans les secrets du Worker : elles ne doivent jamais
 * figurer dans index.html ni dans le dépôt.
 *
 * Fournisseurs (essayés dans l'ordre ci-dessous ; au premier échec, on passe au suivant) :
 *   gemini      -> secret GEMINI_KEY       (modèle : variable GEMINI_MODEL)
 *   groq        -> secret GROQ_KEY         (modèle : variable GROQ_MODEL)
 *   huggingface -> secret HF_KEY           (modèle : variable HF_MODEL)
 * Un fournisseur sans clé est simplement ignoré.
 *
 * Déploiement :
 *   wrangler secret put GEMINI_KEY
 *   wrangler secret put GROQ_KEY
 *   wrangler secret put HF_KEY
 *   wrangler deploy   (variables dans wrangler.toml : GEMINI_MODEL, GROQ_MODEL, HF_MODEL,
 *                      ALLOWED_ORIGIN = "https://salledegarde.online")
 * Puis mets l'URL du Worker dans index.html : window.SDG_LLM_URL.
 */
const MAX_MSG = 600, MAX_HIST = 12, MAX_FACTS = 6000, MAX_PERSONA = 600;

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
    "- Ne propose pas toi-même d'examen ni de traitement."
  ].join("\n");
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

function providers(env) {
  const list = [];
  if (env.GEMINI_KEY) list.push({ name: "gemini", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key: env.GEMINI_KEY, model: env.GEMINI_MODEL || "gemini-2.0-flash" });
  if (env.GROQ_KEY) list.push({ name: "groq", url: "https://api.groq.com/openai/v1/chat/completions", key: env.GROQ_KEY, model: env.GROQ_MODEL || "llama-3.3-70b-versatile" });
  if (env.HF_KEY) list.push({ name: "huggingface", url: "https://router.huggingface.co/v1/chat/completions", key: env.HF_KEY, model: env.HF_MODEL || "meta-llama/Llama-3.1-8B-Instruct" });
  return list;
}

export default {
  async fetch(request, env) {
    const allowed = (env.ALLOWED_ORIGIN || "https://salledegarde.online").split(",").map(s => s.trim());
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "method" }, 405, cors);
    if (!allowed.includes(origin)) return json({ error: "origin" }, 403, cors);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "json" }, 400, cors); }
    const { persona, facts, step, history, message } = body || {};
    if (typeof message !== "string" || !message.trim() || message.length > MAX_MSG) return json({ error: "message" }, 400, cors);
    if (typeof facts !== "string" || facts.length > MAX_FACTS) return json({ error: "facts" }, 400, cors);
    if (typeof persona !== "string" || persona.length > MAX_PERSONA) return json({ error: "persona" }, 400, cors);
    const hist = Array.isArray(history) ? history.slice(-MAX_HIST)
      .filter(m => m && typeof m.t === "string")
      .map(m => ({ role: m.r === "d" ? "user" : "assistant", content: m.t.slice(0, MAX_MSG) })) : [];

    const messages = [
      { role: "system", content: buildSystem(persona, facts, String(step || "Anamnèse").slice(0, 40)) },
      ...hist,
      { role: "user", content: message.trim() }
    ];
    let text = null, used = null;
    for (const pr of providers(env)) {
      try {
        const upstream = await fetch(pr.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + pr.key },
          body: JSON.stringify({ model: pr.model, messages, temperature: 0.9, max_tokens: 220 }),
          signal: AbortSignal.timeout(10000)
        });
        if (!upstream.ok) continue;
        const data = await upstream.json();
        const t = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (t && String(t).trim()) { text = String(t).trim(); used = pr.name; break; }
      } catch (e) { /* fournisseur suivant */ }
    }
    if (!text) return json({ error: "unavailable" }, 502, cors);
    return json({ reponse: text.slice(0, 800) }, 200, cors);
  }
};
