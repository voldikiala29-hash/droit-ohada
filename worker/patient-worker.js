/*
 * Salle de Garde — Worker du patient virtuel, version Workers AI (à coller dans Cloudflare).
 * Liaison requise : AI (Workers AI). Variable optionnelle : ALLOWED_ORIGIN = "https://salledegarde.online".
 * Contrat : POST { persona, facts, step, history, message, question } -> { reponse }.
 */
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
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
    "- Ne propose pas toi-même d'examen ni de traitement.",
    "- Le médecin peut faire des fautes de frappe, écrire en abrégé, ou mêler un peu de mots d'une langue locale africaine à son français : comprends-le toujours et réponds comme si de rien n'était.",
    "- Réponds en français simple et naturel, comme une personne ordinaire d'Afrique francophone. Pas d'accent ni d'expression régionale marquée, pas de phrase entière dans une autre langue, pas de caricature."
  ].join("\n");
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
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

    try {
      const out = await env.AI.run(MODEL, { messages, temperature: 0.9, max_tokens: 220 });
      const text = out && (out.response || out.result && out.result.response);
      if (!text || !String(text).trim()) return json({ error: "unavailable" }, 502, cors);
      return json({ reponse: String(text).trim().slice(0, 800) }, 200, cors);
    } catch (e) {
      return json({ error: "unavailable", details: [String(e && e.message || e).slice(0, 200)] }, 502, cors);
    }
  }
};
