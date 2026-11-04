// Tests du Durable Object QuotaLimiter : atomicité, plafonds, libération, changement de mois.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QuotaLimiter } from "../patient-worker.js";
import { FakeStorage } from "./helpers.mjs";

function newLimiter() {
  return new QuotaLimiter({ storage: new FakeStorage(1) });
}

const base = { month: "2026-11", minute: 100, rpm: 1000, quotaLimit: 5, msgCap: 40 };

test("100 réservations simultanées, cas distincts : exactement 5 acceptées (quota gratuit)", async () => {
  const q = newLimiter();
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) => q.reserve({ ...base, caseId: "cas_" + i }))
  );
  assert.equal(results.filter(r => r.ok).length, 5);
  assert.equal(results.filter(r => !r.ok && r.reason === "quota").length, 95);
  const after = await q.reserve({ ...base, caseId: "cas_nouveau" }).catch(e => e);
  assert.equal(after.ok, false);
});

test("100 réservations simultanées, même cas : exactement 40 acceptées (plafond de messages)", async () => {
  const q = newLimiter();
  const results = await Promise.all(Array.from({ length: 100 }, () => q.reserve({ ...base, caseId: "cas_1" })));
  assert.equal(results.filter(r => r.ok).length, 40);
  assert.equal(results.filter(r => !r.ok && r.reason === "messages").length, 60);
});

test("limite de débit : 50 requêtes simultanées, 20 acceptées", async () => {
  const q = newLimiter();
  const results = await Promise.all(Array.from({ length: 50 }, () => q.rateHit({ minute: 7, rpm: 20 })));
  assert.equal(results.filter(r => r.ok).length, 20);
});

test("débit : le compteur repart à zéro à la minute suivante", async () => {
  const q = newLimiter();
  for (let i = 0; i < 20; i++) assert.equal((await q.rateHit({ minute: 7, rpm: 20 })).ok, true);
  assert.equal((await q.rateHit({ minute: 7, rpm: 20 })).ok, false);
  assert.equal((await q.rateHit({ minute: 8, rpm: 20 })).ok, true);
});

test("libération : une réservation échouée rend le quota disponible", async () => {
  const q = newLimiter();
  for (let i = 0; i < 5; i++) await q.reserve({ ...base, caseId: "cas_" + i });
  assert.equal((await q.reserve({ ...base, caseId: "cas_6" })).ok, false);
  await q.release({ month: base.month, caseId: "cas_0" });
  assert.equal((await q.reserve({ ...base, caseId: "cas_6" })).ok, true);
});

test("libération : les messages d'un cas déjà compté ne sont pas perdus", async () => {
  const q = newLimiter();
  await q.reserve({ ...base, caseId: "cas_1" });
  await q.reserve({ ...base, caseId: "cas_1" });
  await q.release({ month: base.month, caseId: "cas_1" });
  // Il reste un message : le cas est toujours compté
  const r = await q.reserve({ ...base, caseId: "cas_1" });
  assert.equal(r.ok, true);
  assert.equal(r.msgs, 2);
  assert.equal(r.used, 1);
});

test("libération : sans effet si la réservation n'existe pas ou si le mois a changé", async () => {
  const q = newLimiter();
  await q.reserve({ ...base, caseId: "cas_1" });
  assert.equal((await q.release({ month: base.month, caseId: "cas_inconnu" })).skipped, true);
  assert.equal((await q.release({ month: "2026-10", caseId: "cas_1" })).skipped, true);
});

test("changement de mois : les compteurs du mois précédent ne comptent plus", async () => {
  const q = newLimiter();
  for (let i = 0; i < 5; i++) await q.reserve({ ...base, caseId: "cas_" + i });
  assert.equal((await q.reserve({ ...base, caseId: "cas_x" })).ok, false);
  const next = await q.reserve({ ...base, month: "2026-12", caseId: "cas_x" });
  assert.equal(next.ok, true);
  assert.equal(next.used, 1);
});

test("un refus de quota ne consomme pas de message", async () => {
  const q = newLimiter();
  for (let i = 0; i < 5; i++) await q.reserve({ ...base, caseId: "cas_" + i });
  const refused = await q.reserve({ ...base, caseId: "cas_refuse" });
  assert.equal(refused.reason, "quota");
  // Le cas refusé n'a enregistré aucun message
  await q.release({ month: base.month, caseId: "cas_refuse" });
  const again = await q.reserve({ ...base, caseId: "cas_0" });
  assert.equal(again.msgs, 2);
});
