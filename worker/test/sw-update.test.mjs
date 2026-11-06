// Mises à jour du service worker : version, empreinte de la coquille, et comportement réel de sw.js
// (installation, activation, réseau d'abord, repli hors ligne, exclusions) exécuté dans un contexte isolé.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { ROOT, readSwConfig, shellHash } from "../scripts/sw-shell-hash.mjs";

const SW_SOURCE = readFileSync(ROOT + "/sw.js", "utf8");
const { version, shell } = readSwConfig(SW_SOURCE);
const recorded = JSON.parse(readFileSync(new URL("./sw-shell.json", import.meta.url), "utf8"));
const ORIGIN = "https://salledegarde.online";

test("version : sw.js et l'empreinte enregistrée annoncent la même version", () => {
  assert.equal(recorded.version, version);
});

test("coquille : toute modification de index.html ou de patient-client.js exige une nouvelle VERSION", () => {
  const actual = shellHash(ROOT, shell);
  assert.equal(actual, recorded.sha256,
    "La coquille a changé sans nouvelle VERSION dans sw.js. Augmenter VERSION, puis lancer : " +
    "node scripts/sw-shell-hash.mjs --write");
});

test("coquille : patient-client.js et index.html sont précachés (le client ne peut pas être absent hors ligne)", () => {
  assert.ok(shell.includes("index.html"));
  assert.ok(shell.includes("patient-client.js"));
});

/* ---------- Exécution réelle de sw.js ---------- */

function makeWorld({ network = null, networkDelay = null } = {}) {
  const listeners = {};
  const caches = new Map();
  const deleted = [];
  const claimed = { n: 0 };
  const skip = { n: 0 };
  const netCalls = [];
  const fetchFn = async (req) => {
    netCalls.push(typeof req === "string" ? req : req.url);
    if (network === "down") throw new Error("offline");
    if (network === "never") return new Promise(() => {});
    const url = typeof req === "string" ? req : req.url;
    return new Response("nouvelle coquille " + url, { status: 200 });
  };
  const cacheApi = (name) => {
    if (!caches.has(name)) caches.set(name, new Map());
    const store = caches.get(name);
    return {
      put: async (req, res) => { store.set(typeof req === "string" ? req : req.url, await res.text()); },
      add: async () => {}
    };
  };
  const cachesApi = {
    open: async (name) => cacheApi(name),
    match: async (req) => {
      const url = typeof req === "string" ? req : req.url;
      for (const store of caches.values()) {
        if (store.has(url)) return new Response(store.get(url), { status: 200 });
      }
      return undefined;
    },
    keys: async () => [...caches.keys()],
    delete: async (name) => { deleted.push(name); return caches.delete(name); }
  };
  const ctx = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: async () => { skip.n++; },
      clients: { claim: async () => { claimed.n++; } }
    },
    caches: cachesApi,
    fetch: fetchFn,
    Response, URL, Promise, console,
    // Le délai réseau de sw.js : désactivé, sauf si on le demande explicitement.
    setTimeout: networkDelay === "immediate" ? (fn) => { fn(); return 0; } : () => 0
  };
  vm.createContext(ctx);
  vm.runInContext(SW_SOURCE, ctx);
  return { listeners, caches, deleted, claimed, skip, netCalls, cachesApi };
}

/** Lance un événement fetch et renvoie la réponse (ou null si sw.js ne l'intercepte pas). */
async function fetchEvent(world, url, { method = "GET", mode = "cors" } = {}) {
  let responded = null;
  const event = {
    request: { url, method, mode },
    respondWith: (p) => { responded = p; }
  };
  world.listeners.fetch(event);
  return responded ? await responded : null;
}

test("installation : la coquille est précachée et la nouvelle version prend le contrôle sans attendre", async () => {
  const w = makeWorld();
  const waits = [];
  w.listeners.install({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  const store = w.caches.get(version + "-shell");
  assert.ok(store, "cache de la version courante créé");
  assert.ok(store.has(ORIGIN + "/index.html") || [...store.keys()].some(k => k.endsWith("index.html")));
  assert.equal(w.skip.n, 1);
});

test("activation : les caches d'anciennes versions sont supprimés, ceux de la version courante conservés", async () => {
  const w = makeWorld();
  await w.cachesApi.open("sdg-pwa-2026-11-05b-shell");
  await w.cachesApi.open(version + "-shell");
  const waits = [];
  w.listeners.activate({ waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(w.deleted, ["sdg-pwa-2026-11-05b-shell"]);
  assert.equal(w.claimed.n, 1);
});

test("réseau d'abord : une mise à jour en ligne est reçue, et remplace la copie locale", async () => {
  const w = makeWorld({ network: "up" });
  const res = await fetchEvent(w, ORIGIN + "/index.html", { mode: "navigate" });
  assert.match(await res.text(), /nouvelle coquille/);
});

test("hors ligne : la dernière copie locale est servie", async () => {
  const w = makeWorld({ network: "down" });
  await w.cachesApi.open(version + "-shell");
  const store = w.caches.get(version + "-shell");
  store.set(ORIGIN + "/index.html", "ancienne coquille");
  const res = await fetchEvent(w, ORIGIN + "/index.html", { mode: "navigate" });
  assert.equal(await res.text(), "ancienne coquille");
});

test("réseau trop lent : la copie locale est servie après le délai (4 s)", async () => {
  const w = makeWorld({ network: "never", networkDelay: "immediate" });
  await w.cachesApi.open(version + "-shell");
  w.caches.get(version + "-shell").set(ORIGIN + "/patient-client.js", "copie locale");
  const res = await fetchEvent(w, ORIGIN + "/patient-client.js");
  assert.equal(await res.text(), "copie locale");
});

test("sw.js n'est jamais intercepté (une mise à jour du service worker reste visible)", async () => {
  const w = makeWorld({ network: "up" });
  assert.equal(await fetchEvent(w, ORIGIN + "/sw.js"), null);
});

test("requêtes autres que GET (Worker IA, Firestore) : jamais interceptées", async () => {
  const w = makeWorld({ network: "up" });
  assert.equal(await fetchEvent(w, ORIGIN + "/index.html", { method: "POST" }), null);
});

test("autre origine (Worker IA, Firebase Auth) : jamais interceptée", async () => {
  const w = makeWorld({ network: "up" });
  assert.equal(await fetchEvent(w, "https://muddy-shadow-c8d5.workers.dev/"), null);
});
