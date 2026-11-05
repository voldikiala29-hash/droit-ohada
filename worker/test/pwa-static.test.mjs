// Vérifications statiques de la PWA (phase 0) : manifeste, icônes, service worker, en-tête HTML.
// Ne lance aucun navigateur. Le comportement réel est vérifié séparément (voir docs/pwa-phase-0.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const read = p => readFileSync(resolve(root, p), "utf8");

// Dimensions et type de couleur d'un PNG (lecture de l'en-tête IHDR).
function pngInfo(path) {
  const b = readFileSync(resolve(root, path));
  assert.equal(b.toString("ascii", 1, 4), "PNG", path + " n'est pas un PNG");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
}

const manifest = JSON.parse(read("manifest.webmanifest"));

test("manifeste : identité, affichage et couleurs cohérentes", () => {
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.id, "./");
  assert.equal(manifest.lang, "fr");
  assert.equal(manifest.background_color, "#0A1518", "fond de lancement = fond réel de l'application");
  assert.equal(manifest.theme_color, "#0A1518");
});

test("manifeste : chaque icône déclarée existe et a la taille annoncée", () => {
  for (const icon of manifest.icons) {
    assert.ok(existsSync(resolve(root, icon.src)), "icône absente : " + icon.src);
    const [w, h] = icon.sizes.split("x").map(Number);
    const info = pngInfo(icon.src);
    assert.equal(info.width, w, icon.src + " : largeur");
    assert.equal(info.height, h, icon.src + " : hauteur");
  }
});

test("manifeste : icônes maskable présentes en 192 et 512", () => {
  const maskable = manifest.icons.filter(i => i.purpose === "maskable").map(i => i.sizes).sort();
  assert.deepEqual(maskable, ["192x192", "512x512"]);
});

test("icônes : aucune transparence (iOS affiche le noir à la place)", () => {
  for (const f of ["apple-touch-icon.png", "icon-192-maskable.png", "icon-512-maskable.png"]) {
    assert.equal(pngInfo(f).colorType, 2, f + " doit être en RVB sans canal alpha");
  }
});

test("icône Apple : 180 x 180", () => {
  const info = pngInfo("apple-touch-icon.png");
  assert.equal(info.width, 180);
  assert.equal(info.height, 180);
});

test("service worker : compile et ne met jamais en cache les requêtes non GET", () => {
  const src = read("sw.js");
  assert.doesNotThrow(() => new vm.Script(src, { filename: "sw.js" }));
  assert.match(src, /if \(request\.method !== "GET"\) return;/, "les requêtes non GET ne doivent pas être interceptées");
});

test("service worker : chaque fichier précaché existe", () => {
  const src = read("sw.js");
  const block = src.slice(src.indexOf("var SHELL = ["), src.indexOf("];", src.indexOf("var SHELL = [")));
  const files = [...block.matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(p => p !== "./");
  assert.ok(files.length >= 8, "liste de précache trop courte");
  for (const f of files) assert.ok(existsSync(resolve(root, f)), "précache : fichier absent " + f);
});

test("service worker : jamais d'interception du Worker IA, de Firebase Auth ni de Firestore", () => {
  const src = read("sw.js");
  // Seuls les SDK Firebase versionnés (gstatic /firebasejs/) et les polices sont traités hors origine.
  assert.doesNotMatch(src, /workers\.dev|identitytoolkit|securetoken|firestore\.googleapis|firebaseio/);
  assert.match(src, /function isFirebaseLib\(url\)/);
});

test("service worker : version présente et anciens caches supprimés à l'activation", () => {
  const src = read("sw.js");
  assert.match(src, /var VERSION = "sdg-pwa-[^"]+"/);
  assert.match(src, /key\.indexOf\(VERSION\) !== 0/);
});

test("offline.html : fichier présent, français, sans formulation de quota", () => {
  const html = read("offline.html");
  assert.match(html, /<html lang="fr"/);
  assert.match(html, /name="viewport"/);
  assert.equal(/consultations? IA/i.test(html), false);
});

test("index.html : balises d'installation iOS et icône Apple 180 px", () => {
  const html = read("index.html");
  assert.match(html, /<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon\.png">/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  assert.match(html, /<meta name="apple-mobile-web-app-title" content="Salle de Garde">/);
  assert.match(html, /<meta name="theme-color" content="#0A1518">/);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
});

test("index.html : bandeau hors ligne sans formulation de quota", () => {
  const html = read("index.html");
  assert.match(html, /Hors ligne : mode local actif/);
  assert.equal(/consultations? IA/i.test(html), false);
});
