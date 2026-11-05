// Garanties vérifiées sur le code du navigateur (index.html) : adresse du Worker figée, pas de mode debug,
// jeton envoyé à un seul endroit, et scripts classiques syntaxiquement valides.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const WORKER = "https://muddy-shadow-c8d5.voldikiala29.workers.dev";

test("adresse du Worker figée : aucune surcharge par variable globale", () => {
  assert.ok(html.includes(`var WORKER_URL="${WORKER}";`));
  assert.ok(html.includes("var LLM_URL=WORKER_URL;"));
  assert.equal(html.includes("SDG_LLM_URL"), false, "SDG_LLM_URL ne doit plus être lu");
});

test("mode debug supprimé : aucun point d'accès _sdgDbg ni déclenchement par ?debug=1", () => {
  assert.equal(html.includes("_sdgDbg"), false);
  assert.equal(html.includes("debug=1"), false);
});

test("jeton Firebase : ajouté une seule fois, uniquement dans la requête vers LLM_URL", () => {
  assert.equal(html.split('hdrs["Authorization"]').length - 1, 1, "un seul endroit ajoute l'en-tête");
  assert.equal(html.split("fetch(LLM_URL").length - 1, 1, "une seule requête vers le Worker");
  assert.equal(html.includes("fetch(WORKER_URL"), false);
});

test("scripts classiques de index.html : syntaxe valide", () => {
  const scripts = [];
  let i = 0;
  while (true) {
    const a = html.indexOf("<script", i);
    if (a < 0) break;
    const gt = html.indexOf(">", a);
    const end = html.indexOf("</script>", gt);
    const attrs = html.slice(a + 7, gt);
    i = end + 9;
    if (/\bsrc=|module|importmap|application\/|text\//.test(attrs)) continue;
    scripts.push(html.slice(gt + 1, end));
  }
  assert.ok(scripts.length >= 1);
  scripts.forEach((body, n) => {
    assert.doesNotThrow(() => new vm.Script(body, { filename: "inline-" + n + ".js" }), "script " + n);
  });
});

test("worker/case-ids.js reste synchronisé avec cases_202.js", () => {
  const out = execFileSync(process.execPath, [resolve(root, "worker/scripts/build-case-ids.mjs"), "--check"], { encoding: "utf8" });
  assert.match(out, /302 identifiants/);
});

/* ---------- 1.4a : aucun chemin de réponse locale après un refus ou une panne ---------- */

function functionBody(src, name) {
  const start = src.indexOf("function " + name + "(");
  assert.ok(start >= 0, "fonction introuvable : " + name);
  const open = src.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error("accolade non fermée : " + name);
}

test("ancien chemin de secours supprimé : answerPatient et smartPatientReply n'existent plus", () => {
  assert.equal(html.includes("answerPatient"), false);
  assert.equal(html.includes("smartPatientReply"), false);
});

test("moteur de règles : appelé seulement quand aucun Worker n'est configuré (développement)", () => {
  const body = functionBody(html, "askPatientWorker");
  const calls = body.split("patientReply(").length - 1;
  assert.equal(calls, 1, "patientReply ne doit apparaître qu'une fois, dans la branche !LLM_URL");
  assert.ok(body.indexOf("if(!LLM_URL)") < body.indexOf("patientReply("));
  assert.ok(body.indexOf("if(!LLM_URL)") < body.indexOf("SDGPatient.sendMessage"));
});

test("aucun appel à patientReply dans l'envoi, la reprise ou l'affichage des issues", () => {
  for (const name of ["postPatient", "runChatTurn", "sendChat", "retryChat"]) {
    assert.equal(functionBody(html, name).includes("patientReply("), false, name);
  }
});

test("en-têtes du contrat : X-SDG-Protocol et X-SDG-Request-Id posés à chaque envoi", () => {
  const body = functionBody(html, "postPatient");
  assert.ok(body.includes('"X-SDG-Protocol":"2"'));
  assert.ok(body.includes('"X-SDG-Request-Id":rid'));
  assert.equal((html.match(/hdrs\["Authorization"\]=/g) || []).length, 1, "un seul ajout du jeton");
});

test("le module de décision est chargé avant le script principal", () => {
  const moduleAt = html.indexOf('<script src="patient-client.js"></script>');
  const mainAt = html.indexOf("/* ===== Patient autonome (IA)");
  assert.ok(moduleAt > 0 && mainAt > moduleAt);
  const between = html.slice(moduleAt, mainAt);
  assert.equal(between.includes("</script>") && !between.includes("<script>"), false, "balises bien ordonnées");
});

test("service worker : le module est précaché et la version a changé", () => {
  const sw = readFileSync(resolve(root, "sw.js"), "utf8");
  assert.match(sw, /"patient-client\.js"/);
  assert.match(sw, /var VERSION = "sdg-pwa-2026-11-05b"/);
});

test("patient-client.js : aucune réponse de secours ni texte de moteur local", () => {
  const src = readFileSync(resolve(root, "patient-client.js"), "utf8");
  assert.equal(/patientReply|moteur local/.test(src), false);
});
