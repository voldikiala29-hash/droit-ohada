// Tests de l'identifiant de requête (1.4-B) : idempotence, concurrence, délais, expiration, quotas et mois.
// Tous les tests passent par la vraie fonction handleRequest et la vraie classe QuotaLimiter (stockage simulé).
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { handleRequest, requestFingerprint, validateContent, REQUEST_RETENTION_MS } from "../patient-worker.js";
import CASE_IDS from "../case-ids.js";
import { makeCtx, bodyFor, reqFor, fakeAI, uuidV7, brokenNamespace, ORIGIN } from "./helpers.mjs";

const T0 = Date.parse("2026-11-10T12:00:00Z");
const H = 3600 * 1000;

/** IA lente : répond après ms millisecondes, et compte ses appels. */
function slowAI(ms, reply = "Oui docteur.") {
  const ai = { calls: 0 };
  ai.run = async () => {
    ai.calls++;
    await new Promise(r => setTimeout(r, ms));
    return { response: reply };
  };
  return ai;
}

/** Envoie une requête avec un identifiant donné, à un instant donné (horloge simulée du Worker). */
function send(c, body, requestId, nowMs, opts = {}) {
  return handleRequest(reqFor(body, { token: c.token, requestId }), c.env, { ...c.opts, nowMs, ...opts });
}

test("même requestId envoyé deux fois : une seule consultation IA, réponse identique rejouée", async () => {
  const c = await makeCtx({ now: T0 });
  const rid = uuidV7(T0);
  const r1 = await send(c, bodyFor(CASE_IDS[0]), rid, T0);
  const d1 = await r1.json();
  const r2 = await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 5000);
  const d2 = await r2.json();
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(d2.reponse, d1.reponse);
  assert.equal(d2.replay, true);
  assert.equal(c.env.AI.calls, 1);
  assert.equal(d2.quota.msgs, 1);
  assert.equal(d2.quota.used, 1);
});

test("double clic : 10 requêtes simultanées avec le même requestId, une seule consultation IA", async () => {
  const c = await makeCtx({ now: T0, latencyMs: 2 });
  c.env.AI = slowAI(40);
  const rid = uuidV7(T0);
  const rs = await Promise.all(Array.from({ length: 10 }, () => send(c, bodyFor(CASE_IDS[0]), rid, T0)));
  assert.equal(c.env.AI.calls, 1);
  assert.ok(rs.filter(r => r.status === 200).length >= 1, "au moins une réponse");
  for (const r of rs) {
    if (r.status !== 200) {
      assert.equal(r.status, 409);
      assert.equal((await r.json()).error, "in_progress");
    }
  }
  // Une seule consommation : le message suivant voit deux messages sur ce cas
  const next = await send(c, bodyFor(CASE_IDS[0], "Autre question"), uuidV7(T0 + 1), T0 + 1);
  assert.equal((await next.json()).quota.msgs, 2);
});

test("requêtes simultanées avec des requestId différents : chacune est comptée (pas de fausse déduplication)", async () => {
  const c = await makeCtx({ now: T0, latencyMs: 2 });
  c.env.AI = slowAI(20);
  const rs = await Promise.all([
    send(c, bodyFor(CASE_IDS[0], "A"), uuidV7(T0, Buffer.from("aaaaaaaaaaaaaaaaaaaa", "hex").subarray(0, 10)), T0),
    send(c, bodyFor(CASE_IDS[0], "B"), uuidV7(T0, Buffer.from("bbbbbbbbbbbbbbbbbbbb", "hex").subarray(0, 10)), T0)
  ]);
  assert.deepEqual(rs.map(r => r.status), [200, 200]);
  assert.equal(c.env.AI.calls, 2);
});

test("même requestId, contenu différent après confirmation : 409 request_conflict, IA non appelée", async () => {
  const c = await makeCtx({ now: T0 });
  const rid = uuidV7(T0);
  await send(c, bodyFor(CASE_IDS[0], "Depuis quand ?"), rid, T0);
  const r = await send(c, bodyFor(CASE_IDS[0], "Un autre texte"), rid, T0 + 1000);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "request_conflict");
  assert.equal(c.env.AI.calls, 1);
});

test("échec de l'IA (502) puis reprise avec le même requestId : libérée, comptée une seule fois", async () => {
  const c = await makeCtx({ now: T0 });
  c.env.AI = fakeAI({ fail: 1 });
  const rid = uuidV7(T0);
  const r1 = await send(c, bodyFor(CASE_IDS[0]), rid, T0);
  assert.equal(r1.status, 502);
  const r2 = await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 2000);
  assert.equal(r2.status, 200);
  const d2 = await r2.json();
  assert.equal(d2.quota.msgs, 1);
  assert.equal(d2.replay, undefined);
  assert.equal(c.env.AI.calls, 2);
});

test("délai côté serveur : la réponse tardive n'est ni livrée ni comptée deux fois, la reprise réserve une fois", async () => {
  const c = await makeCtx({ now: T0 });
  c.env.AI = { calls: 0, run: () => { c.env.AI.calls++; return new Promise(r => setTimeout(() => r({ response: "Tardif." }), 150)); } };
  const rid = uuidV7(T0);
  const r1 = await send(c, bodyFor(CASE_IDS[0]), rid, T0, { aiTimeoutMs: 20 });
  assert.equal(r1.status, 502);
  c.env.AI = fakeAI();
  const r2 = await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 1000);
  const d2 = await r2.json();
  assert.equal(r2.status, 200);
  assert.equal(d2.reponse, "Oui docteur, ça fait quatre jours.");
  assert.equal(d2.quota.msgs, 1);
});

test("réservation orpheline (arrêt entre réservation et confirmation) : en attente pendant 90 s, puis reprise comptée une fois", async () => {
  const c = await makeCtx({ now: T0 });
  const rid = uuidV7(T0);
  const fp = await requestFingerprint(validateContent(bodyFor(CASE_IDS[0])).value);
  const stub = c.env.QUOTA.get(c.env.QUOTA.idFromName("uid:uid-A"));
  const r0 = await stub.reserve({ month: "2026-11", caseId: CASE_IDS[0], minute: 1, rpm: 1000, quotaLimit: 5,
    msgCap: 40, rid: "arret-brutal", nowMs: T0, reqId: rid, reqTs: T0, fp });
  assert.equal(r0.ok, true);
  // Pendant la fenêtre de 90 s : la reprise est « en cours », rien n'est réservé
  const pendant = await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 30_000);
  assert.equal(pendant.status, 409);
  assert.equal((await pendant.json()).error, "in_progress");
  assert.equal(c.env.AI.calls, 0);
  // Après 91 s : la réservation orpheline est libérée, la reprise réserve une fois
  const apres = await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 91_000);
  assert.equal(apres.status, 200);
  assert.equal(c.env.AI.calls, 1);
  assert.equal((await apres.json()).quota.msgs, 1);
});

test("requête expirée (plus de 48 h) : 410, aucune réservation, aucun appel IA, aucun compteur créé", async () => {
  const c = await makeCtx({ now: T0 });
  const rid = uuidV7(T0 - REQUEST_RETENTION_MS - 60_000);
  const r = await send(c, bodyFor(CASE_IDS[0]), rid, T0);
  assert.equal(r.status, 410);
  assert.equal((await r.json()).error, "request_expired");
  assert.equal(c.env.AI.calls, 0);
  assert.equal(c.env.QUOTA.instances.has("uid:uid-A"), false);
});

test("frontière d'expiration : 47 h 59 acceptée, 48 h 01 refusée", async () => {
  const ok = await makeCtx({ now: T0 });
  const r1 = await send(ok, bodyFor(CASE_IDS[0]), uuidV7(T0 - 48 * H + 60_000), T0);
  assert.equal(r1.status, 200);
  const ko = await makeCtx({ now: T0 });
  const r2 = await send(ko, bodyFor(CASE_IDS[0]), uuidV7(T0 - 48 * H - 60_000), T0);
  assert.equal(r2.status, 410);
  assert.equal(ko.env.AI.calls, 0);
});

test("requestId trop loin dans le futur : 400 ; format invalide ou UUID v4 : 400 ; aucune réservation", async () => {
  const c = await makeCtx({ now: T0 });
  const futur = await send(c, bodyFor(CASE_IDS[0]), uuidV7(T0 + 10 * 60_000), T0);
  assert.equal(futur.status, 400);
  assert.equal((await futur.json()).error, "request_id");
  const invalide = await send(c, bodyFor(CASE_IDS[0]), "pas-un-identifiant", T0);
  assert.equal(invalide.status, 400);
  const v4 = await send(c, bodyFor(CASE_IDS[0]), crypto.randomUUID(), T0);
  assert.equal(v4.status, 400);
  assert.equal(c.env.AI.calls, 0);
  assert.equal(c.env.QUOTA.instances.has("uid:uid-A"), false);
});

test("requête refusée pour quota : rien n'est mémorisé ; la même requête refusée de nouveau reste refusée", async () => {
  const c = await makeCtx({ now: T0 });
  for (let i = 0; i < 5; i++) assert.equal((await send(c, bodyFor(CASE_IDS[i]), uuidV7(T0 + i), T0 + i)).status, 200);
  const rid = uuidV7(T0 + 10);
  const r1 = await send(c, bodyFor(CASE_IDS[5]), rid, T0 + 10);
  assert.equal(r1.status, 402);
  const r2 = await send(c, bodyFor(CASE_IDS[5]), rid, T0 + 20);
  assert.equal(r2.status, 402);
  assert.equal(c.env.AI.calls, 5);
});

test("Premium : une requête idempotente est acceptée au-delà de 5 cas (plafond de 150)", async () => {
  const c = await makeCtx({ now: T0 });
  c.kv.put("plan:uid-A", JSON.stringify({ plan: "premium", until: new Date(T0 + 86_400_000).toISOString() }));
  for (let i = 0; i < 6; i++) {
    const r = await send(c, bodyFor(CASE_IDS[i]), uuidV7(T0 + i), T0 + i);
    assert.equal(r.status, 200, "cas " + i);
  }
  const d = await (await send(c, bodyFor(CASE_IDS[5]), uuidV7(T0 + 50), T0 + 50)).json();
  assert.equal(d.quota.plan, "premium");
  assert.equal(d.quota.limit, 150);
});

test("renouvellement mensuel : nouveau mois, quota gratuit à nouveau disponible", async () => {
  const c = await makeCtx({ now: Date.parse("2026-11-30T23:58:00Z") });
  const fin = Date.parse("2026-11-30T23:59:00Z");
  for (let i = 0; i < 5; i++) assert.equal((await send(c, bodyFor(CASE_IDS[i]), uuidV7(fin - 1000 + i), fin + i)).status, 200);
  const premier = Date.parse("2026-12-01T00:01:00Z");
  const r = await send(c, bodyFor(CASE_IDS[5]), uuidV7(premier), premier);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).quota.used, 1);
});

test("renouvellement mensuel : une requête datée de novembre arrivée après le changement ne remet pas les compteurs à zéro", async () => {
  const c = await makeCtx({ now: Date.parse("2026-11-30T23:58:00Z") });
  const premier = Date.parse("2026-12-01T00:00:01Z");
  await send(c, bodyFor(CASE_IDS[0]), uuidV7(premier), premier);
  const tardive = Date.parse("2026-11-30T23:59:59Z");
  const r = await send(c, bodyFor(CASE_IDS[1]), uuidV7(tardive), tardive);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).quota.used, 2);
});

test("renouvellement mensuel : une réponse confirmée en novembre est rejouée après le changement de mois, sans nouveau décompte", async () => {
  const c = await makeCtx({ now: Date.parse("2026-11-30T23:58:00Z") });
  const fin = Date.parse("2026-11-30T23:59:50Z");
  const rid = uuidV7(fin);
  const r1 = await send(c, bodyFor(CASE_IDS[0]), rid, fin);
  const d1 = await r1.json();
  const apres = Date.parse("2026-12-01T00:00:10Z");
  const r2 = await send(c, bodyFor(CASE_IDS[0]), rid, apres);
  const d2 = await r2.json();
  assert.equal(r2.status, 200);
  assert.equal(d2.replay, true);
  assert.equal(d2.reponse, d1.reponse);
  assert.equal(c.env.AI.calls, 1);
});

test("codes de refus : 401, 402, 409 (messages), 429 — aucune IA appelée pour un refus", async () => {
  const sans = await makeCtx({ now: T0 });
  const r401 = await handleRequest(reqFor(bodyFor(CASE_IDS[0]), {}), sans.env, { ...sans.opts, nowMs: T0 });
  assert.equal(r401.status, 401);
  assert.equal(sans.env.AI.calls, 0);

  const quota = await makeCtx({ now: T0 });
  for (let i = 0; i < 5; i++) await send(quota, bodyFor(CASE_IDS[i]), uuidV7(T0 + i), T0 + i);
  const r402 = await send(quota, bodyFor(CASE_IDS[5]), uuidV7(T0 + 9), T0 + 9);
  assert.equal(r402.status, 402);
  assert.equal(quota.env.AI.calls, 5);

  const messages = await makeCtx({ now: T0 });
  for (let i = 0; i < 40; i++) await send(messages, bodyFor(CASE_IDS[0], "m" + i), uuidV7(T0 + i), T0 + i);
  const r409 = await send(messages, bodyFor(CASE_IDS[0], "m40"), uuidV7(T0 + 40), T0 + 40);
  assert.equal(r409.status, 409);
  assert.equal((await r409.json()).error, "messages");
  assert.equal(messages.env.AI.calls, 40);

  const rate = await makeCtx({ now: T0, env: { USER_REQUESTS_PER_MINUTE: "2" } });
  await send(rate, bodyFor(CASE_IDS[0]), uuidV7(T0), T0);
  await send(rate, bodyFor(CASE_IDS[1]), uuidV7(T0 + 1), T0 + 1);
  const r429 = await send(rate, bodyFor(CASE_IDS[2]), uuidV7(T0 + 2), T0 + 2);
  assert.equal(r429.status, 429);
  assert.equal(rate.env.AI.calls, 2);
});

test("erreur de stockage : 503, aucune IA appelée, même avec un requestId", async () => {
  const c = await makeCtx({ now: T0, env: {} });
  c.env.QUOTA = brokenNamespace();
  const r = await send(c, bodyFor(CASE_IDS[0]), uuidV7(T0), T0);
  assert.equal(r.status, 503);
  assert.equal(c.env.AI.calls, 0);
});

test("transition : sans X-SDG-Request-Id, il n'y a pas d'idempotence (limite documentée)", async () => {
  const c = await makeCtx({ now: T0, latencyMs: 2 });
  c.env.AI = slowAI(20);
  const rs = await Promise.all([
    handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token: c.token }), c.env, { ...c.opts, nowMs: T0 }),
    handleRequest(reqFor(bodyFor(CASE_IDS[0]), { token: c.token }), c.env, { ...c.opts, nowMs: T0 })
  ]);
  assert.deepEqual(rs.map(r => r.status), [200, 200]);
  assert.equal(c.env.AI.calls, 2);
});

test("réponses HTTP : en-tête Date présent et exposé en CORS (lecture de l'heure du Worker par le navigateur)", async () => {
  const c = await makeCtx();
  const r = await worker.fetch(reqFor(bodyFor(CASE_IDS[0]), { token: c.token, requestId: uuidV7(Date.now()) }), c.env);
  assert.ok(r.headers.get("Date"));
  assert.match(r.headers.get("Access-Control-Expose-Headers"), /Date/);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});
