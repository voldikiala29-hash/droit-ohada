// Génère worker/case-ids.js à partir de cases_202.js.
// Ne contient que les identifiants : aucun contenu médical (diagnostic, corrigé, réponses) n'est copié.
// Usage : node scripts/build-case-ids.mjs          (écrit le fichier)
//         node scripts/build-case-ids.mjs --check  (échoue si le fichier est désynchronisé)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../cases_202.js");
const out = resolve(here, "../case-ids.js");

const text = readFileSync(src, "utf8");
const ids = [...text.matchAll(/^\{id:"([^"]+)"/gm)].map(m => m[1]);
const unique = [...new Set(ids)];
if (ids.length !== 302 || unique.length !== 302) {
  throw new Error(`attendu 302 identifiants uniques, trouvé ${ids.length} (${unique.length} uniques)`);
}

const body =
  "// Généré par scripts/build-case-ids.mjs à partir de cases_202.js. Ne pas éditer à la main.\n" +
  "// Identifiants uniquement : aucun contenu médical.\n" +
  "export default " + JSON.stringify(unique, null, 2) + ";\n";

if (process.argv.includes("--check")) {
  const current = readFileSync(out, "utf8");
  if (current !== body) {
    console.error("worker/case-ids.js est désynchronisé avec cases_202.js : relancer le script.");
    process.exit(1);
  }
  console.log("case-ids.js synchronisé :", unique.length, "identifiants");
} else {
  writeFileSync(out, body);
  console.log("écrit :", unique.length, "identifiants");
}
