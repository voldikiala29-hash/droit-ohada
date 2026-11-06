// Format de PROTOCOL_CUTOFF (B4) et contrôle automatique avant déploiement, pour la cible test et la cible production.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleRequest, readConfig } from "../patient-worker.js";
import { parseStrictCutoff, checkCutoffForDeploy } from "../protocol-cutoff.js";
import { checkConfig } from "../scripts/check-deploy.mjs";
import CASE_IDS from "../case-ids.js";
import { makeCtx, bodyFor, reqFor, cutoffIso } from "./helpers.mjs";

const NOW = Date.parse("2026-11-06T09:00:00Z");
const WRANGLER = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

test("formats acceptés : ISO 8601 UTC strict uniquement", () => {
  for (const v of ["2099-12-31T23:59:59Z", "2026-11-06T00:00:00Z"]) {
    assert.equal(parseStrictCutoff(v).ok, true, v);
  }
});

test("formats refusés : ambigus, incomplets, avec millisecondes, avec décalage, inexistants, placeholder, vides", () => {
  const refus = [
    "05/12/2026",                       // ambigu : 5 décembre ou 12 mai
    "12/05/2026",
    "2026-12-05",                       // sans heure
    "2026-12-05T00:00:00.000Z",         // millisecondes
    "2026-12-05T00:00:00+01:00",        // décalage
    "2026-12-05T00:00:00z",             // suffixe en minuscule
    "2026-02-31T00:00:00Z",             // date inexistante
    "2026-13-01T00:00:00Z",             // mois inexistant
    " 2026-12-05T00:00:00Z",            // espace
    "REMPLACER_PAR_DATE_DE_DEPLOIEMENT_PLUS_30_JOURS",
    "",
    undefined,
    null
  ];
  for (const v of refus) assert.equal(parseStrictCutoff(v).ok, false, JSON.stringify(v));
});

test("« 05/12/2026 » n'est ni accepté par le Worker ni par le contrôle avant déploiement", () => {
  assert.equal(parseStrictCutoff("05/12/2026").ok, false);
  assert.equal(checkCutoffForDeploy("05/12/2026", NOW).ok, false);
});

test("contrôle avant déploiement : date passée ou égale à maintenant refusée, date future acceptée", () => {
  assert.equal(checkCutoffForDeploy("2026-11-01T00:00:00Z", NOW).reason, "date_passee");
  assert.equal(checkCutoffForDeploy("2026-11-06T09:00:00Z", NOW).reason, "date_passee");
  assert.equal(checkCutoffForDeploy("2026-11-06T09:00:01Z", NOW).ok, true);
});

test("Worker : une date mal formée provoque un échec fermé (503) pour toutes les requêtes, sans réservation", async () => {
  assert.equal(readConfig({ PROTOCOL_CUTOFF: "05/12/2026" }), null);
  const c = await makeCtx({ env: { PROTOCOL_CUTOFF: "05/12/2026" } });
  const r = await handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token: c.token }), c.env, c.opts);
  assert.equal(r.status, 503);
  assert.equal(c.ai.calls, 0);
});

test("Worker : une date passée n'est PAS refusée au démarrage (le refus 426 s'applique seulement aux anciens navigateurs)", async () => {
  const cfg = readConfig({ PROTOCOL_CUTOFF: "2026-01-01T00:00:00Z" });
  assert.ok(cfg, "configuration acceptée");
  assert.equal(cfg.protocolCutoffMs, Date.parse("2026-01-01T00:00:00Z"));
});

/* ---------- Contrôle avant déploiement ---------- */

function withVars(text, vars) {
  let out = text;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp("^" + k + " = \".*\"$", "m"), k + " = \"" + v + "\"");
  }
  return out;
}
function withKvId(text, id) { return text.replace('id = "REMPLACER_PAR_ID_KV_STATE"', 'id = "' + id + '"'); }
const VALID_PROD = withKvId(withVars(WRANGLER, { PROTOCOL_CUTOFF: "2099-12-31T23:59:59Z" }), "kv-prod-0000000000000000");

test("fichier réel : le contrôle échoue pour la production (placeholders, aucune valeur réelle configurée)", () => {
  const r = checkConfig(WRANGLER, "production", NOW);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some(p => /PROTOCOL_CUTOFF contient encore le placeholder/.test(p)));
  assert.ok(r.problems.some(p => /KV « STATE »/.test(p)));
});

test("production valide (fixture) : conforme", () => {
  assert.deepEqual(checkConfig(VALID_PROD, "production", NOW).problems, []);
});

test("production : date ambiguë, passée, ou projet de test refusés", () => {
  assert.equal(checkConfig(withVars(VALID_PROD, { PROTOCOL_CUTOFF: "05/12/2026" }), "production", NOW).ok, false);
  assert.equal(checkConfig(withVars(VALID_PROD, { PROTOCOL_CUTOFF: "2026-11-01T00:00:00Z" }), "production", NOW).ok, false);
  const autreProjet = checkConfig(withVars(VALID_PROD, { FIREBASE_PROJECT_ID: "projet-test-x" }), "production", NOW);
  assert.ok(autreProjet.problems.some(p => /Cible production : FIREBASE_PROJECT_ID/.test(p)));
});

test("production : origine « * » refusée, origine de test refusée", () => {
  assert.equal(checkConfig(withVars(VALID_PROD, { ALLOWED_ORIGIN: "*" }), "production", NOW).ok, false);
  assert.equal(checkConfig(withVars(VALID_PROD, { ALLOWED_ORIGIN: "http://localhost:8080" }), "production", NOW).ok, false);
});

test("cible test : valide avec un projet et une origine distincts de la production", () => {
  const test1 = withVars(withKvId(WRANGLER, "kv-test-0000000000000000"), {
    PROTOCOL_CUTOFF: "2099-12-31T23:59:59Z",
    FIREBASE_PROJECT_ID: "salledegarde-test-1",
    ALLOWED_ORIGIN: "http://localhost:8080",
    name: "patient-staging"
  }).replace(/^name = ".*"$/m, 'name = "patient-staging"');
  assert.deepEqual(checkConfig(test1, "test", NOW).problems, []);
});

test("cible test : le projet ou l'origine de production, ou le nom de production, sont refusés", () => {
  const base = withKvId(WRANGLER, "kv-test-0000000000000000");
  const cut = { PROTOCOL_CUTOFF: "2099-12-31T23:59:59Z" };
  const prodProject = checkConfig(withVars(base, { ...cut, FIREBASE_PROJECT_ID: "salledegarde-89dae", ALLOWED_ORIGIN: "http://localhost:8080" }), "test", NOW);
  assert.ok(prodProject.problems.some(p => /projet Firebase de production est interdit/.test(p)));
  const prodOrigin = checkConfig(withVars(base, { ...cut, FIREBASE_PROJECT_ID: "salledegarde-test-1", ALLOWED_ORIGIN: "https://salledegarde.online" }), "test", NOW);
  assert.ok(prodOrigin.problems.some(p => /origine de production est interdite/.test(p)));
  const prodName = checkConfig(base.replace(/^name = ".*"$/m, 'name = "muddy-shadow-c8d5"') , "test", NOW);
  assert.ok(prodName.problems.some(p => /nom du Worker de production/.test(p)));
});

test("liaisons : Durable Object et migration SQLite obligatoires", () => {
  const sansMigration = VALID_PROD.replace('new_sqlite_classes = ["QuotaLimiter"]', 'new_classes = ["QuotaLimiter"]');
  assert.ok(checkConfig(sansMigration, "production", NOW).problems.some(p => /new_sqlite_classes/.test(p)));
  const sansDo = VALID_PROD.replace('class_name = "QuotaLimiter"', 'class_name = "Autre"');
  assert.ok(checkConfig(sansDo, "production", NOW).problems.some(p => /Durable Object QUOTA/.test(p)));
});

test("cible inconnue : refusée", () => {
  assert.equal(checkConfig(VALID_PROD, "staging", NOW).ok, false);
});
