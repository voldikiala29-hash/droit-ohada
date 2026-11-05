// Tests de la logique d'envoi du navigateur (patient-client.js) : décisions HTTP, reprise, doubles envois, expiration.
// Le module est chargé tel quel ; le « post » est simulé. Aucune réponse locale n'est jamais produite.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseRequestId } from "../patient-worker.js";

await import("../../patient-client.js");
const SDG = globalThis.SDGPatient;

const T0 = Date.parse("2026-11-10T12:00:00Z");
const HOUR = 3600 * 1000;

beforeEach(() => SDG._reset());

const hdr = (obj = {}) => ({ get: (k) => (k in obj ? obj[k] : null) });
const resp = (status, body = null, headers = {}) => ({ status, body, headers: hdr({ Date: new Date(T0).toUTCString(), ...headers }) });

/** Client d'envoi simulé : une file de réponses, et l'historique des appels (identifiant + contenu). */
function harness(...responses) {
  const calls = [];
  const states = [];
  const built = [];
  const post = async (rid, body) => {
    calls.push({ rid, body });
    const r = responses.shift();
    if (r instanceof Error) throw r;
    if (typeof r === "function") return r();
    return r;
  };
  return {
    calls, states, built,
    opts(extra = {}) {
      return {
        state: null, text: "Depuis quand ?", nowMs: T0, post,
        buildBody: (t) => { built.push(t); return { message: t, question: t, history: [] }; },
        onState: (s) => states.push(s),
        ...extra
      };
    }
  };
}

/* ---------- Identifiants ---------- */

test("identifiant navigateur : UUID version 7, heure encodée exacte, acceptée par le validateur du Worker", () => {
  for (const t of [T0, T0 + 12345, Date.parse("2026-12-31T23:59:59Z")]) {
    const id = SDG.uuidV7(t);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(SDG.requestTime(id), t);
    assert.ok(parseRequestId(id), "le Worker doit accepter cet identifiant");
    assert.equal(parseRequestId(id).ts, t);
  }
});

test("identifiants : deux générations successives ne se ressemblent pas", () => {
  const ids = new Set(Array.from({ length: 200 }, () => SDG.uuidV7(T0)));
  assert.equal(ids.size, 200);
});

test("UUID v4 ou format inconnu : refusé par le client comme par le Worker", () => {
  assert.ok(Number.isNaN(SDG.requestTime(crypto.randomUUID())));
  assert.equal(parseRequestId(crypto.randomUUID()), null);
});

/* ---------- Classement des codes HTTP : aucun cas ne donne de réponse locale ---------- */

test("classement : chaque code a une décision, aucune n'autorise de réponse locale", () => {
  const cases = [
    [200, { reponse: "Oui." }, "answer"],
    [200, {}, "technical"],
    [400, { error: "json" }, "refused"],
    [401, { error: "auth" }, "refused"],
    [402, { error: "quota" }, "refused"],
    [403, { error: "email_unverified" }, "refused"],
    [403, { error: "origin" }, "refused"],
    [409, { error: "messages", quota: { msgCap: 40 } }, "refused"],
    [409, { error: "in_progress" }, "retry_later"],
    [409, { error: "request_conflict" }, "reset"],
    [410, { error: "request_expired" }, "reset"],
    [413, { error: "too_large" }, "refused"],
    [426, { error: "upgrade_required" }, "refused"],
    [429, { error: "rate" }, "refused"],
    [500, null, "technical"],
    [502, { error: "unavailable" }, "technical"],
    [503, { error: "unavailable" }, "technical"],
    [504, null, "technical"]
  ];
  for (const [status, body, kind] of cases) {
    const c = SDG.classify(status, body);
    assert.equal(c.kind, kind, `statut ${status} ${body && body.error || ""}`);
    assert.notEqual(c.kind, "local");
    if (kind !== "answer") assert.ok(c.message && c.message.length > 10, `message pour ${status}`);
  }
});

test("le message de plafond affiche la valeur reçue du Worker", () => {
  assert.match(SDG.classify(409, { error: "messages", quota: { msgCap: 40 } }).message, /40 messages/);
});

/* ---------- Envois ---------- */

test("réponse 200 : texte affiché, question en attente effacée, aucun appel supplémentaire", async () => {
  const h = harness(resp(200, { reponse: "patient : Depuis quatre jours." }));
  const out = await SDG.sendMessage(h.opts());
  assert.equal(out.outcome, "answer");
  assert.equal(out.text, "Depuis quatre jours.");
  assert.equal(h.calls.length, 1);
  assert.equal(h.states.at(-1), null);
});

test("en-tête X-SDG-Upgrade sur une réponse 200 : signalé à l'interface", async () => {
  const h = harness(resp(200, { reponse: "Oui." }, { "X-SDG-Upgrade": "requis" }));
  const out = await SDG.sendMessage(h.opts());
  assert.equal(out.outcome, "answer");
  assert.equal(out.upgrade, true);
});

test("panne réseau : technique, question conservée, aucune réponse locale", async () => {
  const h = harness(new TypeError("Failed to fetch"));
  const out = await SDG.sendMessage(h.opts());
  assert.equal(out.outcome, "technical");
  assert.equal(out.state.text, "Depuis quand ?");
  assert.equal(h.states.length, 1, "seule la mémorisation avant envoi");
  assert.notEqual(h.states.at(-1), null);
});

test("panne 5xx et réponse vide : technique, question conservée", async () => {
  for (const r of [resp(502, { error: "unavailable" }), resp(503, { error: "unavailable" }), resp(200, {})]) {
    SDG._reset();
    const h = harness(r);
    const out = await SDG.sendMessage(h.opts());
    assert.equal(out.outcome, "technical");
    assert.ok(out.state, "question conservée");
  }
});

test("reprise : même identifiant, même contenu sérialisé, contenu construit une seule fois", async () => {
  const h = harness(new Error("timeout"), resp(200, { reponse: "Oui." }));
  const first = await SDG.sendMessage(h.opts());
  assert.equal(first.outcome, "technical");
  const second = await SDG.sendMessage(h.opts({ state: first.state, text: null }));
  assert.equal(second.outcome, "answer");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].rid, h.calls[1].rid, "même identifiant");
  assert.equal(h.calls[0].body, h.calls[1].body, "même contenu, octet pour octet");
  assert.equal(h.built.length, 1, "le contenu n'est pas reconstruit à la reprise");
  assert.equal(h.states.at(-1), null);
});

test("reprise après délai puis réponse rejouée : toujours une seule question en attente", async () => {
  const h = harness(new Error("aborted"), resp(409, { error: "in_progress" }), resp(200, { reponse: "Oui.", replay: true }));
  const a = await SDG.sendMessage(h.opts());
  const b = await SDG.sendMessage(h.opts({ state: a.state, text: null }));
  assert.equal(b.outcome, "retry_later");
  const c = await SDG.sendMessage(h.opts({ state: b.state, text: null }));
  assert.equal(c.outcome, "answer");
  assert.equal(new Set(h.calls.map(x => x.rid)).size, 1);
});

test("une panne ne fait jamais partir une seconde requête toute seule (une seule tentative par action)", async () => {
  const h = harness(new Error("x"));
  await SDG.sendMessage(h.opts());
  assert.equal(h.calls.length, 1);
});

/* ---------- Refus : rien compté, pas de reprise, texte restitué ---------- */

test("refus 400, 401, 402, 403, 409 (plafond), 413, 426, 429 : une seule requête, question retirée, texte restitué", async () => {
  const refus = [
    resp(400, { error: "json" }),
    resp(401, { error: "auth" }),
    resp(402, { error: "quota" }),
    resp(403, { error: "email_unverified" }),
    resp(409, { error: "messages", quota: { msgCap: 40 } }),
    resp(413, { error: "too_large" }),
    resp(426, { error: "upgrade_required" }),
    resp(429, { error: "rate" })
  ];
  for (const r of refus) {
    SDG._reset();
    const h = harness(r);
    const out = await SDG.sendMessage(h.opts());
    assert.equal(out.outcome, "refused", `statut ${r.status}`);
    assert.equal(out.restoreDraft, true);
    assert.equal(out.text, "Depuis quand ?");
    assert.equal(h.calls.length, 1, `pas de reprise après ${r.status}`);
    assert.equal(h.states.at(-1), null);
  }
});

test("409 request_conflict : question non reprise, texte restitué pour une nouvelle saisie", async () => {
  const h = harness(resp(409, { error: "request_conflict" }));
  const out = await SDG.sendMessage(h.opts());
  assert.equal(out.outcome, "reset");
  assert.equal(out.restoreDraft, true);
});

/* ---------- Expiration ---------- */

test("question en attente de plus de 48 h : jamais renvoyée, devient une demande explicite", async () => {
  const vieille = { rid: SDG.uuidV7(T0 - 48 * HOUR - 60_000), body: "{}", text: "Ancienne question" };
  const h = harness();
  const out = await SDG.sendMessage(h.opts({ state: vieille, text: null, nowMs: T0 }));
  assert.equal(out.outcome, "reset");
  assert.equal(h.calls.length, 0, "aucun envoi");
  assert.equal(out.text, "Ancienne question");
  assert.equal(h.states.at(-1), null);
});

test("frontière côté navigateur : 47 h 59 reprise possible, 48 h 01 refusée sans envoi", async () => {
  const ok = { rid: SDG.uuidV7(T0 - 48 * HOUR + 60_000), body: "{}", text: "a" };
  const h1 = harness(resp(200, { reponse: "Oui." }));
  assert.equal((await SDG.sendMessage(h1.opts({ state: ok, text: null, nowMs: T0 }))).outcome, "answer");
  const ko = { rid: SDG.uuidV7(T0 - 48 * HOUR - 60_000), body: "{}", text: "b" };
  const h2 = harness();
  assert.equal((await SDG.sendMessage(h2.opts({ state: ko, text: null, nowMs: T0 }))).outcome, "reset");
  assert.equal(h2.calls.length, 0);
});

test("410 sur une demande créée à l'instant (horloge de l'appareil en retard) : recréée une seule fois, sans double décompte", async () => {
  const h = harness(
    resp(410, { error: "request_expired" }, { Date: new Date(T0 + 3 * HOUR).toUTCString() }),
    resp(200, { reponse: "Oui." }, { Date: new Date(T0 + 3 * HOUR).toUTCString() })
  );
  const out = await SDG.sendMessage(h.opts());
  assert.equal(out.outcome, "answer");
  assert.equal(h.calls.length, 2);
  assert.notEqual(h.calls[0].rid, h.calls[1].rid, "nouvel identifiant, la première n'a jamais été acceptée");
  assert.equal(h.calls[0].body, h.calls[1].body, "même question");
  assert.equal(SDG._offsetMs(), 3 * HOUR);
});

test("410 répété après recalage : pas de troisième tentative", async () => {
  const h = harness(
    resp(410, { error: "request_expired" }),
    resp(410, { error: "request_expired" })
  );
  const out = await SDG.sendMessage(h.opts());
  assert.equal(out.outcome, "reset");
  assert.equal(h.calls.length, 2);
});

/* ---------- Doubles envois et hors ligne ---------- */

test("double envoi simultané avec la même question : une seule requête part", async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const h = harness(() => gate.then(() => resp(200, { reponse: "Oui." })));
  const pendingState = { rid: SDG.uuidV7(T0), body: "{}", text: "Q" };
  const first = SDG.sendMessage(h.opts({ state: pendingState, text: null }));
  const second = await SDG.sendMessage(h.opts({ state: pendingState, text: null }));
  assert.equal(second.outcome, "busy");
  release();
  assert.equal((await first).outcome, "answer");
  assert.equal(h.calls.length, 1);
});

test("hors ligne : aucune requête, question conservée pour une reprise", async () => {
  const h = harness();
  const out = await SDG.sendMessage(h.opts({ online: false }));
  assert.equal(out.outcome, "technical");
  assert.equal(h.calls.length, 0);
  assert.ok(out.state);
});

test("après un refus, un nouvel envoi crée une nouvelle question (pas de réutilisation d'identifiant)", async () => {
  const h = harness(resp(402, { error: "quota" }), resp(200, { reponse: "Oui." }));
  await SDG.sendMessage(h.opts());
  const second = await SDG.sendMessage(h.opts({ text: "Depuis quand ?" }));
  assert.equal(second.outcome, "answer");
  assert.notEqual(h.calls[0].rid, h.calls[1].rid);
});

/* ---------- Horloge ---------- */

test("en-tête Date : recalage de l'horloge ; en-tête absent ou invalide : aucun effet", () => {
  SDG.learnServerTime(new Date(T0 + HOUR).toUTCString(), T0);
  assert.equal(SDG._offsetMs(), HOUR);
  SDG.learnServerTime("n'importe quoi", T0);
  assert.equal(SDG._offsetMs(), HOUR);
  SDG.learnServerTime(null, T0);
  assert.equal(SDG._offsetMs(), HOUR);
});

/* ---------- Fichier navigateur : pas de chemin local dans l'envoi ---------- */

test("le module ne contient aucun appel à un moteur local ni à une réponse de secours", () => {
  const src = readFileSync(fileURLToPath(new URL("../../patient-client.js", import.meta.url)), "utf8");
  assert.doesNotMatch(src, /patientReply|moteur local|fallback|localStorage\.getItem\("sdg_auto_state/);
  assert.doesNotMatch(src, /"local"/);
});
