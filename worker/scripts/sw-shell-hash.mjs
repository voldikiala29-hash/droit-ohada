#!/usr/bin/env node
/*
 * Empreinte de la coquille du service worker (mises à jour du PWA).
 *
 * Une modification de index.html, de patient-client.js ou d'un autre fichier de SHELL sans changement de VERSION
 * laisserait les navigateurs garder l'ancienne coquille. Le test worker/test/sw-update.test.mjs compare donc
 * l'empreinte actuelle à celle enregistrée dans worker/test/sw-shell.json.
 *
 * Usage : node scripts/sw-shell-hash.mjs --write   (après avoir augmenté VERSION dans sw.js)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** Extrait VERSION et la liste SHELL du source de sw.js (sans l'exécuter). */
export function readSwConfig(source) {
  const v = /var VERSION = "([^"]+)";/.exec(source);
  const block = /var SHELL = \[([\s\S]*?)\];/.exec(source);
  if (!v || !block) throw new Error("VERSION ou SHELL introuvable dans sw.js");
  const shell = [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(p => p !== "./");
  return { version: v[1], shell };
}

/** Empreinte SHA-256 de tous les fichiers de la coquille, dans l'ordre de SHELL. */
export function shellHash(root, shell) {
  const h = createHash("sha256");
  for (const rel of shell) {
    const path = root + "/" + rel;
    if (!existsSync(path)) throw new Error("fichier de la coquille absent : " + rel);
    h.update(rel + "\n");
    h.update(readFileSync(path));
    h.update("\n");
  }
  return h.digest("hex");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { version, shell } = readSwConfig(readFileSync(ROOT + "/sw.js", "utf8"));
  const sha256 = shellHash(ROOT, shell);
  if (process.argv.includes("--write")) {
    writeFileSync(ROOT + "/worker/test/sw-shell.json", JSON.stringify({ version, sha256 }, null, 2) + "\n");
    console.log("Écrit : version " + version + ", empreinte " + sha256);
  } else {
    console.log(JSON.stringify({ version, sha256 }, null, 2));
  }
}
