// Tests de charge et de capacité du stockage SQLite (B3). Ils mesurent ce que la simulation peut mesurer :
// nombre de lignes, taille des réponses, temps d'exécution, purge par lot. Les limites réelles du runtime
// Cloudflare (taille de stockage, débit par objet, durée) ne sont PAS validées ici : voir le rapport.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, QuotaLimiter, REQUEST_RETENTION_MS } from "../patient-worker.js";
import CASE_IDS from "../case-ids.js";
import { makeCtx, makeDoState, bodyFor, reqFor, uuidV7, sign, claims } from "./helpers.mjs";

const T0 = Date.parse("2026-11-10T12:00:00Z");
const H = 3600 * 1000;

test("3000 messages confirmés (Premium : 150 cas × 20 messages) : décompte exact, lignes et taille bornées, temps mesuré", async () => {
  const q = new QuotaLimiter(makeDoState());
  const started = Date.now();
  const answer = "x".repeat(800);   // réponse au maximum autorisé par le Worker
  for (let i = 0; i < 3000; i++) {
    const rid = uuidV7(T0 + i, Buffer.alloc(10, i & 0xff));
    const r = await q.reserve({ month: "2026-11", caseId: CASE_IDS[i % 150], minute: i, rpm: 100000, quotaLimit: 150,
      msgCap: 40, rid, nowMs: T0 + i, reqId: rid, reqTs: T0 + i, fp: "fp" + i });
    assert.equal(r.ok, true, "réservation " + i);
    assert.equal((await q.confirm({ rid, reqId: rid, answer, nowMs: T0 + i })).ok, true);
  }
  const elapsed = Date.now() - started;
  assert.deepEqual(q.stats(), { ledger: 3000, idem: 3000 });
  const bytes = q.one("SELECT SUM(LENGTH(answer)) AS n, MAX(LENGTH(answer)) AS max FROM idem");
  assert.equal(bytes.max, 800, "aucune réponse ne dépasse 800 caractères");
  assert.ok(elapsed < 60000, "3000 réservations+confirmations en " + elapsed + " ms");
  // Le 151e cas est refusé : le quota Premium est atteint.
  const refus = await q.reserve({ month: "2026-11", caseId: CASE_IDS[150], minute: 9999, rpm: 100000, quotaLimit: 150, msgCap: 40, rid: uuidV7(T0 + 5000), nowMs: T0 + 5000 });
  assert.equal(refus.ok, false);
  assert.equal(refus.reason, "quota");
  console.log("capacité : 3000 messages en " + elapsed + " ms, " + bytes.n + " caractères de réponses");
});

test("3000 réponses rejouées : aucune ligne ajoutée, aucun appel IA", async () => {
  const q = new QuotaLimiter(makeDoState());
  const rids = [];
  for (let i = 0; i < 300; i++) {
    const rid = uuidV7(T0 + i, Buffer.alloc(10, (i + 1) & 0xff));
    rids.push(rid);
    await q.reserve({ month: "2026-11", caseId: CASE_IDS[i % 150], minute: i, rpm: 100000, quotaLimit: 150, msgCap: 40, rid, nowMs: T0 + i, reqId: rid, reqTs: T0 + i, fp: "f" + i });
    await q.confirm({ rid, reqId: rid, answer: "réponse " + i, nowMs: T0 + i });
  }
  const before = q.stats();
  let replays = 0;
  for (let k = 0; k < 3000; k++) {
    const i = k % 300;
    const r = await q.reserve({ month: "2026-11", caseId: CASE_IDS[i % 150], minute: 99999, rpm: 100000, quotaLimit: 150, msgCap: 40, rid: "nouveau-" + k, nowMs: T0 + 1000, reqId: rids[i], reqTs: T0 + i, fp: "f" + i });
    if (r.ok && r.replay) replays++;
  }
  assert.equal(replays, 3000);
  assert.deepEqual(q.stats(), before);
});

test("purge par lot après 48 h : toutes les réponses conservées sont supprimées, les décomptes du mois restent", async () => {
  const q = new QuotaLimiter(makeDoState());
  for (let i = 0; i < 1000; i++) {
    const rid = uuidV7(T0 + i, Buffer.alloc(10, (i + 7) & 0xff));
    await q.reserve({ month: "2026-11", caseId: CASE_IDS[i % 150], minute: i, rpm: 100000, quotaLimit: 150, msgCap: 40, rid, nowMs: T0 + i, reqId: rid, reqTs: T0 + i, fp: "p" + i });
    await q.confirm({ rid, reqId: rid, answer: "r", nowMs: T0 + i });
  }
  await q.sweepAll(T0 + REQUEST_RETENTION_MS + 10 * 60 * 1000);
  assert.deepEqual(q.stats(), { ledger: 1000, idem: 0 });
});

test("requêtes HTTP complètes : 1200 messages Premium à travers handleRequest, sans appel IA en double", async () => {
  const c = await makeCtx({ now: T0, env: { USER_REQUESTS_PER_MINUTE: "1000", IP_REQUESTS_PER_MINUTE: "1000" } });
  c.token = await sign(c.key, claims(T0, { sub: c.uid, exp: Math.floor(T0 / 1000) + 4 * 86400 }));
  await c.kv.put("plan:uid-A", JSON.stringify({ plan: "premium", until: "2027-06-01T00:00:00Z" }));
  const started = Date.now();
  let ok = 0;
  for (let i = 0; i < 1200; i++) {
    // Une requête par seconde : reste sous la limite de 1000 par minute (plage admise par le Worker).
    const t = T0 + i * 1000;
    const rid = uuidV7(t, Buffer.alloc(10, (i + 3) & 0xff));
    const r = await handleRequest(reqFor(bodyFor(CASE_IDS[i % 150]), { token: c.token, requestId: rid }), c.env, { ...c.opts, nowMs: t });
    if (r.status === 200) ok++;
  }
  assert.equal(ok, 1200);
  assert.equal(c.ai.calls, 1200);
  assert.deepEqual(c.env.QUOTA.get("uid:uid-A").stats(), { ledger: 1200, idem: 1200 });
  console.log("capacité HTTP : 1200 messages en " + (Date.now() - started) + " ms");
});
