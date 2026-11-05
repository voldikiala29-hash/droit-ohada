/* Salle de Garde — service worker (PWA, phase 0).
 *
 * Rôle :
 *  - permettre l'installation ;
 *  - ouvrir l'application hors ligne après une première visite en ligne ;
 *  - réseau d'abord pour la coquille de l'application (une mise à jour est toujours reçue en ligne) ;
 *  - cache d'abord pour les SDK Firebase versionnés et les polices (immuables).
 *
 * Ce qui n'est JAMAIS mis en cache ni intercepté :
 *  - les requêtes autres que GET (appels IA vers le Worker, écritures Firestore) ;
 *  - tous les autres domaines (Firebase Auth, Firestore, publicité, analytics, Worker).
 *
 * À CHAQUE modification de ce fichier ou de la coquille : changer VERSION (sinon les anciens fichiers restent).
 */
var VERSION = "sdg-pwa-2026-11-05b";
var SHELL_CACHE = VERSION + "-shell";
var LIB_CACHE = VERSION + "-lib";
var NET_TIMEOUT_MS = 4000;

// Coquille précachée à l'installation (chemins relatifs à la portée du service worker).
var SHELL = [
  "./",
  "index.html",
  "patient-client.js",
  "cases_202.js",
  "manifest.webmanifest",
  "offline.html",
  "favicon-192.png",
  "logo.png",
  "apple-touch-icon.png",
  "icon-192-maskable.png",
  "icon-512-maskable.png"
];

// SDK Firebase chargés par l'import map de index.html (URLs versionnées : elles ne changent jamais).
var FIREBASE_LIB = [
  "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js",
  "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js",
  "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js"
];

function isFirebaseLib(url) {
  return url.hostname === "www.gstatic.com" && url.pathname.indexOf("/firebasejs/") === 0;
}
function isFont(url) {
  return url.hostname === "fonts.gstatic.com" || url.hostname === "fonts.googleapis.com";
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    Promise.all([
      // Chaque fichier est tenté seul : un échec ne doit pas empêcher l'installation.
      caches.open(SHELL_CACHE).then(function (cache) {
        return Promise.all(SHELL.map(function (path) {
          return fetch(path, { cache: "reload" })
            .then(function (res) { if (res.ok) return cache.put(path, res); })
            .catch(function () {});
        }));
      }),
      caches.open(LIB_CACHE).then(function (cache) {
        return Promise.all(FIREBASE_LIB.map(function (url) {
          return fetch(url, { mode: "cors" })
            .then(function (res) { if (res.ok) return cache.put(url, res); })
            .catch(function () {});
        }));
      })
    ]).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys
          .filter(function (key) { return key.indexOf(VERSION) !== 0; })
          .map(function (key) { return caches.delete(key); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

// Réseau d'abord ; si le réseau ne répond pas dans le délai, ou échoue, on sert la copie locale.
function networkFirst(request) {
  var network = fetch(request).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(SHELL_CACHE).then(function (cache) { cache.put(request, copy); });
    }
    return res;
  });
  var timeout = new Promise(function (_, reject) {
    setTimeout(function () { reject(new Error("délai dépassé")); }, NET_TIMEOUT_MS);
  });
  return Promise.race([network, timeout]).catch(function () {
    return caches.match(request, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      if (request.mode === "navigate") {
        return caches.match("offline.html").then(function (page) {
          return page || new Response("Hors ligne", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        });
      }
      return Response.error();
    });
  });
}

// Cache d'abord, puis réseau (et mise en cache si la réponse est correcte).
function cacheFirst(request) {
  return caches.match(request).then(function (hit) {
    if (hit) return hit;
    return fetch(request).then(function (res) {
      // « opaque » : feuilles de style chargées sans CORS (Google Fonts). Accepté, car sans cela elles ne seraient jamais gardées.
      if (res.ok || res.type === "opaque") {
        var copy = res.clone();
        caches.open(LIB_CACHE).then(function (cache) { cache.put(request, copy); });
      }
      return res;
    });
  });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;               // IA, Firestore : jamais interceptés
  var url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith("/sw.js")) return;      // le service worker lui-même
    event.respondWith(networkFirst(request));
    return;
  }
  if (isFirebaseLib(url) || isFont(url)) {
    event.respondWith(cacheFirst(request));
  }
  // Tout le reste (Worker, Firebase Auth, Firestore, publicité) : réseau direct, non intercepté.
});
