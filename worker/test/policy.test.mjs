// Cohérence de la politique des quotas entre le code, la configuration et la documentation.
// Si une valeur change, ce test échoue tant que toutes les sources ne sont pas mises à jour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FREE_CONSULTATIONS_PER_MONTH, PREMIUM_CONSULTATIONS_PER_MONTH, DEFAULT_MESSAGES_PER_CASE } from "../patient-worker.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = p => readFileSync(resolve(root, p), "utf8");

// Valeurs de la politique révisée (4 novembre 2026)
const POLICY = { free: 5, premium: 150, messagesPerCase: 40 };

test("constantes du code conformes à la politique", () => {
  assert.equal(FREE_CONSULTATIONS_PER_MONTH, POLICY.free);
  assert.equal(PREMIUM_CONSULTATIONS_PER_MONTH, POLICY.premium);
  assert.equal(DEFAULT_MESSAGES_PER_CASE, POLICY.messagesPerCase);
});

test("wrangler.toml conforme : plafond de messages identique au défaut du code", () => {
  const toml = read("worker/wrangler.toml");
  assert.match(toml, new RegExp('MAX_MESSAGES_PER_CASE = "' + POLICY.messagesPerCase + '"'));
});

test("documentation des quotas : valeurs à jour", () => {
  const doc = read("docs/quotas-politique.md");
  assert.match(doc, new RegExp("\\*\\*" + POLICY.premium + "\\*\\*"), "Premium doit valoir " + POLICY.premium);
  assert.match(doc, new RegExp("\\*\\*" + POLICY.free + "\\*\\*"));
  assert.match(doc, new RegExp("\\*\\*" + POLICY.messagesPerCase + "\\*\\*"));
});

test("aucune valeur obsolète de Premium (60) dans la documentation et le README du Worker", () => {
  const files = [
    "worker/README.md",
    ...readdirSync(resolve(root, "docs")).filter(f => f.endsWith(".md")).map(f => "docs/" + f)
  ];
  // Motifs obsolètes : « 60 cas », « 60 en Premium », « 5 / 60 », « 5, 60 et 40 », « 60 cas distincts »
  const stale = /\b60 (cas|en Premium|cas distincts)|5 \/ 60\b|5, 60 et 40|Premium[^\n]{0,30}\b60\b/i;
  const offenders = [];
  for (const f of files) {
    read(f).split("\n").forEach((line, i) => {
      if (stale.test(line)) offenders.push(f + ":" + (i + 1) + " " + line.trim().slice(0, 120));
    });
  }
  assert.deepEqual(offenders, [], "valeurs obsolètes trouvées");
});

test("aucune valeur de quota en dur dans le frontend (le serveur fait foi)", () => {
  const html = read("index.html");
  assert.equal(/consultations? IA/i.test(html), false, "le frontend ne doit pas afficher de quota en dur");
});
