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
