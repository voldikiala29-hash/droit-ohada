// Corrections B2 (ordre des vérifications d'idempotence) et B3 (stockage SQLite par requête) :
// rejeu après expiration apparente, conservation de 48 h depuis la première réception, purge sans effet sur une
// réservation active, concurrence, pannes de stockage atomiques, changement de mois, perte de réseau.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, QuotaLimiter, REQUEST_RETENTION_MS, PENDING_TTL_MS, MAX_REQUEST_FUTURE_MS, SCHEMA_VERSION } from "../patient-worker.js";
import CASE_IDS from "../case-ids.js";
import { makeCtx, bodyFor, reqFor, uuidV7, makeDoState, sign, claims } from "./helpers.mjs";

const T0 = Date.parse("2026-11-10T12:00:00Z");
const H = 3600 * 1000;
const MIN = 60 * 1000;

async function send(c, body, rid, nowMs) {
  return handleRequest(reqFor(body, { token: c.token, requestId: rid }), c.env, { ...c.opts, nowMs });
}
/** Contexte dont le jeton reste valable 4 jours : les scénarios couvrent jusqu'à 49 h. */
async function longCtx(now = T0) {
  const c = await makeCtx({ now });
  c.token = await sign(c.key, claims(now, { sub: c.uid, exp: Math.floor(now / 1000) + 4 * 86400 }));
  return c;
}
const stats = (c) => c.env.QUOTA.get("uid:uid-A").stats();

/* ---------- B2 : ordre des vérifications ---------- */

test("rejeu après expiration apparente : identifiant reçu à 47 h, rejoué à 49 h → même réponse, aucun appel IA, aucun décompte", async () => {
  const c = await longCtx();
  const rid = uuidV7(T0 - 47 * H);
  const first = await send(c, bodyFor(CASE_IDS[0]), rid, T0);
  assert.equal(first.status, 200);
  const answer = (await first.json()).reponse;
  const replay = await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 2 * H);
  assert.equal(replay.status, 200);
  const body = await replay.json();
  assert.equal(body.replay, true);
  assert.equal(body.reponse, answer);
  assert.equal(c.env.AI.calls, 1);
  assert.deepEqual(await stats(c), { ledger: 1, idem: 1 });
});

test("conservation de 48 h depuis la première réception : 47 h 59 après réception, rejeu OK ; 48 h 01, refus 410 sans décompte", async () => {
  const c = await longCtx();
  const rid = uuidV7(T0 - 47 * H - 59 * MIN);
  assert.equal((await send(c, bodyFor(CASE_IDS[0]), rid, T0)).status, 200);
  assert.equal((await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 47 * H + 59 * MIN)).status, 200);
  const late = await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 48 * H + MIN);
  assert.equal(late.status, 410);
  assert.equal((await late.json()).error, "request_expired");
  assert.equal(c.env.AI.calls, 1);
  assert.deepEqual(await stats(c), { ledger: 1, idem: 1 });
});

test("identifiant purgé : toujours refusé (410), même à la limite de la purge", async () => {
  // Réponse reçue à T0, identifiant encodé à T0 + 5 min (la tolérance maximale vers le futur).
  const c = await longCtx();
  const rid = uuidV7(T0 + MAX_REQUEST_FUTURE_MS);
  assert.equal((await send(c, bodyFor(CASE_IDS[0]), rid, T0)).status, 200);
  // Juste avant la purge (48 h + 4 min) : connu et expiré.
  assert.equal((await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 48 * H + 4 * MIN)).status, 410);
  // Après la purge (48 h + 6 min) : inconnu, et son heure encodée est déjà trop ancienne. Refus, pas de nouveau comptage.
  const purged = await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 48 * H + 6 * MIN);
  assert.equal(purged.status, 410);
  assert.equal(c.env.AI.calls, 1);
  assert.equal((await stats(c)).ledger, 1);
});

test("contenu différent sous un identifiant connu : 409, même après expiration apparente", async () => {
  const c = await longCtx();
  const rid = uuidV7(T0 - 47 * H);
  await send(c, bodyFor(CASE_IDS[0], "Depuis quand ?"), rid, T0);
  const r = await send(c, bodyFor(CASE_IDS[0], "Autre question"), rid, T0 + 2 * H);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).error, "request_conflict");
  assert.equal(c.env.AI.calls, 1);
});

/* ---------- Concurrence ---------- */

test("50 requêtes simultanées avec le même identifiant : un seul appel IA, un seul décompte", async () => {
  const c = await longCtx();
  const rid = uuidV7(T0);
  const results = await Promise.all(Array.from({ length: 50 }, () => send(c, bodyFor(CASE_IDS[0]), rid, T0)));
  const statuses = results.map(r => r.status);
  assert.ok(statuses.every(s => s === 200 || s === 409), "statuts : " + statuses.join(","));
  assert.ok(statuses.includes(200));
  assert.equal(c.env.AI.calls, 1);
  assert.equal((await stats(c)).ledger, 1);
});

test("100 identifiants distincts simultanés, quota gratuit : 5 réussis, 5 appels IA, 5 lignes de décompte", async () => {
  const c = await longCtx();
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    send(c, bodyFor(CASE_IDS[i]), uuidV7(T0 + i), T0 + i)));
  assert.equal(results.filter(r => r.status === 200).length, 5);
  assert.equal(c.env.AI.calls, 5);
  assert.equal((await stats(c)).ledger, 5);
});

/* ---------- Perte de réseau côté serveur ---------- */

test("perte de réseau après la réponse de l'IA : le Worker termine, la reprise reçoit la réponse sans nouveau comptage", async () => {
  const c = await longCtx();
  const rid = uuidV7(T0);
  // Le navigateur disparaît : la réponse n'est jamais lue. Le Worker a pourtant confirmé la réservation.
  await send(c, bodyFor(CASE_IDS[0]), rid, T0);
  const reprise = await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 30 * 1000);
  assert.equal(reprise.status, 200);
  assert.equal((await reprise.json()).replay, true);
  assert.equal(c.env.AI.calls, 1);
  assert.equal((await stats(c)).ledger, 1);
});

/* ---------- Pannes de stockage (atomicité) ---------- */

test("panne pendant la réservation : 503, aucune ligne écrite, aucun appel IA", async () => {
  const c = await longCtx();
  c.env.QUOTA.get("uid:uid-A");
  c.env.QUOTA.sqlOf("uid:uid-A").failNext = /INSERT INTO idem/;
  const r = await send(c, bodyFor(CASE_IDS[0]), uuidV7(T0), T0);
  assert.equal(r.status, 503);
  assert.equal(c.env.AI.calls, 0);
  assert.deepEqual(await stats(c), { ledger: 0, idem: 0 });
});

test("panne pendant la confirmation : 503, réservation libérée ; la reprise compte une seule fois", async () => {
  const c = await longCtx();
  const rid = uuidV7(T0);
  c.env.QUOTA.get("uid:uid-A");
  c.env.QUOTA.sqlOf("uid:uid-A").failNext = /UPDATE ledger SET state/;
  const first = await send(c, bodyFor(CASE_IDS[0]), rid, T0);
  assert.equal(first.status, 503);
  assert.equal(c.env.AI.calls, 1, "l'IA a répondu, mais la réponse n'a pas pu être confirmée");
  assert.deepEqual(await stats(c), { ledger: 0, idem: 0 });
  const retry = await send(c, bodyFor(CASE_IDS[0]), rid, T0 + 1000);
  assert.equal(retry.status, 200);
  assert.equal(c.env.AI.calls, 2);
  assert.equal((await stats(c)).ledger, 1);
});

/* ---------- Purge et réservations actives ---------- */

test("réservation active pendant une purge : conservée à 60 s, libérée après 90 s", async () => {
  const c = await longCtx();
  const q = c.env.QUOTA.get("uid:uid-A");
  const r = await q.reserve({ month: "2026-11", caseId: CASE_IDS[0], minute: 1, rpm: 1000, quotaLimit: 5, msgCap: 40, rid: "active-1", nowMs: T0 });
  assert.equal(r.ok, true);
  await q.sweepAll(T0 + 60 * 1000);
  assert.equal((await stats(c)).ledger, 1, "réservation encore active : conservée");
  await q.sweepAll(T0 + PENDING_TTL_MS + 1000);
  assert.equal((await stats(c)).ledger, 0, "réservation expirée : libérée");
});

test("purge : une réponse confirmée du mois en cours n'est jamais retirée avant 48 h", async () => {
  const c = await longCtx();
  const q = c.env.QUOTA.get("uid:uid-A");
  const rid = uuidV7(T0);
  await send(c, bodyFor(CASE_IDS[0]), rid, T0);
  await q.sweepAll(T0 + 10 * H);
  assert.deepEqual(await stats(c), { ledger: 1, idem: 1 });
  await q.sweepAll(T0 + 49 * H);
  assert.deepEqual(await stats(c), { ledger: 1, idem: 0 }, "réponse purgée, décompte du mois conservé");
});

test("purge : une réservation en attente sans sa requête idempotente n'est jamais confirmée après expiration", async () => {
  const c = await longCtx();
  const q = c.env.QUOTA.get("uid:uid-A");
  const rid = uuidV7(T0);
  await q.reserve({ month: "2026-11", caseId: CASE_IDS[0], minute: 1, rpm: 1000, quotaLimit: 5, msgCap: 40, rid: "orph-1", nowMs: T0, reqId: rid, reqTs: T0, fp: "f" });
  await q.sweepAll(T0 + PENDING_TTL_MS + 1000);
  assert.deepEqual(await stats(c), { ledger: 0, idem: 0 });
  // La reprise avec le même identifiant est une réservation neuve (rien n'a été consommé).
  const retry = await send(c, bodyFor(CASE_IDS[0]), rid, T0 + PENDING_TTL_MS + 2000);
  assert.equal(retry.status, 200);
  assert.equal((await stats(c)).ledger, 1);
});

/* ---------- Changement de mois ---------- */

test("réservation commencée fin de mois, confirmée au mois suivant : livrée, et sans effet sur le quota du nouveau mois", async () => {
  const q = new QuotaLimiter(makeDoState());
  const fin = Date.parse("2026-11-30T23:59:50Z");
  const debut = Date.parse("2026-12-01T00:00:30Z");
  const base = { minute: 1, rpm: 1000, quotaLimit: 5, msgCap: 40 };
  const nov = await q.reserve({ ...base, month: "2026-11", caseId: "cas_nov", nowMs: fin, rid: "nov-1", reqId: null });
  assert.equal(nov.ok, true);
  for (let i = 0; i < 5; i++) {
    const r = await q.reserve({ ...base, month: "2026-12", caseId: "cas_dec_" + i, nowMs: debut, rid: "dec-" + i });
    assert.equal(r.ok, true, "les cinq cas de décembre sont disponibles");
  }
  const done = await q.confirm({ rid: "nov-1", reqId: null, answer: "Réponse de novembre", nowMs: debut + 10 * 1000 });
  assert.equal(done.ok, true);
});

/* ---------- Schéma ---------- */

test("schéma : rouvrir un stockage existant conserve les décomptes (création idempotente)", async () => {
  const state = makeDoState();
  const q1 = new QuotaLimiter(state);
  await q1.reserve({ month: "2026-11", caseId: "cas_a", minute: 1, rpm: 1000, quotaLimit: 5, msgCap: 40, rid: "k1", nowMs: T0 });
  const q2 = new QuotaLimiter(state);
  assert.equal(q2.stats().ledger, 1);
  const row = state.sql.exec("SELECT v FROM meta WHERE k = 'schema'").toArray()[0];
  assert.equal(row.v, String(SCHEMA_VERSION));
});

test("expiration de la réservation : une réponse confirmée après 90 s est refusée et libérée", async () => {
  const q = new QuotaLimiter(makeDoState());
  await q.reserve({ month: "2026-11", caseId: "cas_a", minute: 1, rpm: 1000, quotaLimit: 5, msgCap: 40, rid: "late-1", nowMs: T0 });
  const r = await q.confirm({ rid: "late-1", reqId: null, answer: "trop tard", nowMs: T0 + PENDING_TTL_MS + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "expired");
  assert.equal(q.stats().ledger, 0);
});
