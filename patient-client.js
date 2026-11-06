/* Salle de Garde — envoi des questions au patient IA (navigateur, sous-étapes 1.4a et 1.4b).
 *
 * Logique sans interface, testée par worker/test/patient-client.test.mjs.
 *
 * Règles (décisions D-P3 et D-P3-bis) :
 *  - aucun refus du Worker (400, 401, 402, 403, 409, 410, 413, 426, 429) ne donne une réponse locale ;
 *  - une panne (5xx, délai, réseau) ne donne pas non plus de réponse locale : la même question est reprise
 *    avec le MÊME identifiant et le MÊME contenu, et le Worker garantit qu'elle n'est comptée qu'une fois ;
 *  - une question en attente est toujours renvoyée à l'identique ; elle ne peut pas être remplacée silencieusement ;
 *  - l'expiration est décidée par le Worker, jamais par l'horloge de l'appareil (correction B2) : une question en
 *    attente est toujours renvoyée ; si le Worker répond 410, elle devient une demande explicite ;
 *  - une question abandonnée (opts.resume) n'est renvoyée avec le même identifiant que si le texte est identique.
 *
 * Aucune réponse n'est jamais produite ici : ce fichier décide seulement de ce qui est affiché et de ce qui reste en
 * attente. Le texte de la réponse vient du Worker.
 */
(function (root) {
  "use strict";

  var REQUEST_RETENTION_MS = 48 * 3600 * 1000;   // identique au Worker (1.4-B)
  var CLIENT_TIMEOUT_MS = 90000;                 // supérieur au délai de l'IA côté Worker (60 s)

  var offsetMs = 0;    // écart entre l'horloge du Worker et celle de l'appareil (lu dans l'en-tête Date)
  var inFlight = {};   // identifiants en cours d'envoi (protection contre les doubles envois)

  var MSG_TECHNICAL = "Le patient n'a pas répondu. Ta question est conservée : « Réessayer » la renverra, sans la compter deux fois.";
  var MSG_EXPIRED = "La question en attente a expiré (plus de 48 heures). Repose-la si tu veux une réponse.";

  /* ---------- Identifiants de requête (UUID version 7 : 48 bits d'heure en millisecondes) ---------- */

  function uuidV7(serverMs) {
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    var ms = Math.floor(serverMs);
    var hi = Math.floor(ms / 0x100000000);
    var lo = ms % 0x100000000;
    b[0] = (hi >>> 8) & 0xff; b[1] = hi & 0xff;
    b[2] = (lo >>> 24) & 0xff; b[3] = (lo >>> 16) & 0xff; b[4] = (lo >>> 8) & 0xff; b[5] = lo & 0xff;
    b[6] = (b[6] & 0x0f) | 0x70;   // version 7
    b[8] = (b[8] & 0x3f) | 0x80;   // variante RFC 4122
    var h = [];
    for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
    return h.slice(0, 4).join("") + "-" + h.slice(4, 6).join("") + "-" + h.slice(6, 8).join("") + "-" +
      h.slice(8, 10).join("") + "-" + h.slice(10, 16).join("");
  }

  /** Heure (ms) encodée dans un identifiant, ou NaN si le format n'est pas celui attendu. */
  function requestTime(id) {
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) return NaN;
    return parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
  }

  function serverNow(localNow) { return localNow + offsetMs; }

  /** Vrai si la requête est plus vieille que 48 heures, selon l'horloge du Worker estimée. */
  function isExpired(id, localNow) {
    var t = requestTime(id);
    return !(t >= serverNow(localNow) - REQUEST_RETENTION_MS);
  }

  /** Recale l'horloge estimée sur l'en-tête Date renvoyé par le Worker. */
  function learnServerTime(dateHeader, localNow) {
    if (!dateHeader) return;
    var t = Date.parse(dateHeader);
    if (!isNaN(t)) offsetMs = t - localNow;
  }

  /* ---------- Classement des réponses ---------- */

  /**
   * Transforme une réponse HTTP en décision. Aucune décision ne prévoit de réponse locale.
   * kind : answer (réponse reçue) | refused (refus, rien compté) | reset (requête à ne pas reprendre) |
   *        retry_later (en cours côté Worker) | technical (panne, reprise possible avec le même identifiant)
   */
  function classify(status, body) {
    var err = body && body.error;
    if (status === 200) {
      if (body && typeof body.reponse === "string" && body.reponse.trim()) return { kind: "answer" };
      return { kind: "technical", message: MSG_TECHNICAL };
    }
    if (status === 400) return { kind: "refused", message: "Question non envoyée : son contenu a été refusé. Recharge la page si le problème continue." };
    if (status === 401) return { kind: "refused", message: "Connecte-toi pour consulter le patient." };
    if (status === 402) return { kind: "refused", message: "Ton quota de cas pour ce mois est atteint. Il est renouvelé le 1er du mois (UTC)." };
    if (status === 403) {
      return { kind: "refused", message: err === "email_unverified"
        ? "Vérifie ton adresse e-mail pour utiliser le patient IA."
        : "Accès refusé depuis cette adresse." };
    }
    if (status === 409) {
      if (err === "in_progress") return { kind: "retry_later", message: "Le patient répond encore à ta question précédente. Réessaie dans un instant." };
      if (err === "request_conflict") return { kind: "reset", message: "Cette question ne peut pas être reprise telle quelle. Repose-la." };
      var cap = body && body.quota && body.quota.msgCap;
      return { kind: "refused", message: "Le plafond de " + (cap || 40) + " messages pour ce cas est atteint." };
    }
    if (status === 410) return { kind: "reset", message: MSG_EXPIRED };
    if (status === 413) return { kind: "refused", message: "Question trop longue. Raccourcis-la." };
    if (status === 426) return { kind: "refused", message: "Mets l'application à jour : recharge la page pour continuer." };
    if (status === 429) return { kind: "refused", message: "Trop de demandes. Attends une minute avant de réessayer." };
    return { kind: "technical", message: MSG_TECHNICAL };
  }

  /* ---------- Envoi ---------- */

  /**
   * Envoie une question (ou reprend la question en attente).
   * opts :
   *  - state : question en attente { rid, body, text } ou null ;
   *  - resume : question abandonnée { rid, body, text } ou null (reprise seulement si le texte est identique) ;
   *  - text : la question, si nouvelle ;
   *  - buildBody(text) : construit le contenu (appelé seulement pour une nouvelle question) ;
   *  - post(rid, bodyString) : envoie la requête, renvoie { status, headers, body } ou lève une exception ;
   *  - onState(state|null) : mémorise la question en attente (persistée par l'appelant avant l'envoi) ;
   *  - online : false si l'appareil est hors ligne (aucun envoi).
   *  - nowMs : heure locale (pour les tests).
   * Renvoie { outcome, text?, message?, upgrade?, quota?, state, restoreDraft? }.
   * outcome : answer | refused | reset | retry_later | technical | busy.
   */
  async function sendMessage(opts) {
    var now = opts.nowMs != null ? opts.nowMs : Date.now();
    var pending = opts.state || null;
    var created = false;

    if (!pending && opts.resume && opts.text && opts.resume.text === opts.text) {
      // Question abandonnée puis renvoyée à l'identique : même identifiant et même contenu. Le Worker ne la recompte pas.
      pending = { rid: opts.resume.rid, body: opts.resume.body, text: opts.resume.text };
      opts.onState(pending);
    } else if (!pending) {
      pending = { rid: uuidV7(serverNow(now)), body: JSON.stringify(opts.buildBody(opts.text)), text: opts.text };
      created = true;
      opts.onState(pending);   // avant tout envoi : une fermeture de page ne fait pas perdre la question
    }
    if (inFlight[pending.rid]) return { outcome: "busy", state: pending };
    // Correction B2 : l'horloge de l'appareil ne décide PAS de l'expiration d'une question en attente. Le Worker
    // consulte sa réponse mémorisée (48 h à partir de la première réception) avant de refuser l'identifiant ;
    // une réponse encore conservée est donc rejouée, même si l'heure encodée paraît ancienne.
    if (opts.online === false) {
      return { outcome: "technical", message: MSG_TECHNICAL, state: pending };
    }

    var retried = false;
    for (;;) {
      inFlight[pending.rid] = true;
      var res = null, thrown = false;
      try {
        res = await opts.post(pending.rid, pending.body);
      } catch (e) {
        thrown = true;
      } finally {
        delete inFlight[pending.rid];
      }
      if (thrown || !res) return { outcome: "technical", message: MSG_TECHNICAL, state: pending };

      var dateHeader = res.headers && res.headers.get ? res.headers.get("Date") : null;
      learnServerTime(dateHeader, now);

      // Une requête créée à l'instant est rejetée parce que l'horloge de l'appareil est décalée : elle n'a jamais
      // été acceptée, donc elle n'a rien consommé. On la recrée une seule fois avec l'heure corrigée.
      var clockRejected = res.status === 410 || (res.status === 400 && res.body && res.body.error === "request_id");
      if (created && clockRejected && !retried) {
        retried = true;
        var fresh = { rid: uuidV7(serverNow(now)), body: pending.body, text: pending.text };
        opts.onState(fresh);
        pending = fresh;
        continue;
      }

      var c = classify(res.status, res.body);
      var upgrade = !!(res.headers && res.headers.get && res.headers.get("X-SDG-Upgrade"));
      if (c.kind === "answer") {
        opts.onState(null);
        return { outcome: "answer", text: String(res.body.reponse).replace(/^\s*(patient|patiente|mère|mere)\s*:\s*/i, "").trim(),
          upgrade: upgrade, quota: res.body.quota, state: null };
      }
      if (c.kind === "refused" || c.kind === "reset") {
        opts.onState(null);
        return { outcome: c.kind, message: c.message, restoreDraft: true, text: pending.text, state: null };
      }
      return { outcome: c.kind, message: c.message, state: pending };
    }
  }

  root.SDGPatient = {
    REQUEST_RETENTION_MS: REQUEST_RETENTION_MS,
    CLIENT_TIMEOUT_MS: CLIENT_TIMEOUT_MS,
    uuidV7: uuidV7,
    requestTime: requestTime,
    isExpired: isExpired,
    learnServerTime: learnServerTime,
    classify: classify,
    sendMessage: sendMessage,
    _offsetMs: function () { return offsetMs; },
    _reset: function () { offsetMs = 0; inFlight = {}; }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.SDGPatient;
})(typeof window !== "undefined" ? window : globalThis);
