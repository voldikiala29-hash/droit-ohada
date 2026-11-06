// Tests du Durable Object QuotaLimiter : atomicité, plafonds, libération, changement de mois.
import { test } from "node:test";
import assert from "node:assert/strict";
import { QuotaLimiter } from "../patient-worker.js";
import { makeDoState } from "./helpers.mjs";

function newLimiter() {
  return new QuotaLimiter(makeDoState());
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

const T0 = Date.parse("2026-11-10T12:00:00Z");

test("libération par identifiant : une réservation échouée rend le quota disponible", async () => {
  const q = newLimiter();
  const first = await q.reserve({ ...base, caseId: "cas_0", nowMs: T0 });
  for (let i = 1; i < 5; i++) await q.reserve({ ...base, caseId: "cas_" + i, nowMs: T0 });
  assert.equal((await q.reserve({ ...base, caseId: "cas_6", nowMs: T0 })).ok, false);
  assert.equal((await q.release({ rid: first.rid })).ok, true);
  assert.equal((await q.reserve({ ...base, caseId: "cas_6", nowMs: T0 })).ok, true);
});

test("libération : les messages d'un cas déjà compté ne sont pas perdus", async () => {
  const q = newLimiter();
  const a = await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 });
  await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 });
  await q.release({ rid: a.rid });
  const r = await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 });
  assert.equal(r.ok, true);
  assert.equal(r.msgs, 2);
  assert.equal(r.used, 1);
});

test("libération idempotente : une seconde libération du même identifiant ne retire rien", async () => {
  const q = newLimiter();
  const a = await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 });
  await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 });
  assert.equal((await q.release({ rid: a.rid })).skipped, undefined);
  assert.equal((await q.release({ rid: a.rid })).skipped, true);
  const r = await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 });
  assert.equal(r.msgs, 2);
});

test("libération : identifiant inconnu sans effet", async () => {
  const q = newLimiter();
  await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 });
  assert.equal((await q.release({ rid: "inconnu" })).skipped, true);
});

test("confirmation : une réservation confirmée ne expire pas", async () => {
  const q = newLimiter();
  const a = await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 });
  assert.equal((await q.confirm({ rid: a.rid, nowMs: T0 + 10_000 })).ok, true);
  await q.reserve({ ...base, caseId: "cas_2", nowMs: T0 + 200_000 }); // déclenche le balayage
  const r = await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 + 200_000 });
  assert.equal(r.msgs, 2);
});

test("expiration : une réservation non confirmée depuis plus de 90 s est libérée", async () => {
  const q = newLimiter();
  await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 });
  await q.reserve({ ...base, caseId: "cas_2", nowMs: T0 + 91_000 }); // balayage
  const r = await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 + 91_000 });
  assert.equal(r.msgs, 1);
  assert.equal(r.used, 2);
});

test("confirmation tardive : refusée, réservation libérée", async () => {
  const q = newLimiter();
  const a = await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 });
  const late = await q.confirm({ rid: a.rid, nowMs: T0 + 91_000 });
  assert.equal(late.ok, false);
  assert.equal(late.reason, "expired");
  const r = await q.reserve({ ...base, caseId: "cas_1", nowMs: T0 + 91_000 });
  assert.equal(r.msgs, 1);
});

test("confirmation d'un identifiant inconnu : refusée", async () => {
  const q = newLimiter();
  assert.equal((await q.confirm({ rid: "inconnu", nowMs: T0 })).reason, "unknown");
});

test("mois monotone : une requête datée d'un mois antérieur ne remet pas les compteurs à zéro", async () => {
  const q = newLimiter();
  await q.reserve({ ...base, month: "2026-11", caseId: "cas_1", nowMs: T0 });
  const late = await q.reserve({ ...base, month: "2026-10", caseId: "cas_1", nowMs: T0 });
  assert.equal(late.month, "2026-11");
  assert.equal(late.msgs, 2);
  assert.equal(late.used, 1);
});

test("mois suivant : les compteurs repartent à zéro", async () => {
  const q = newLimiter();
  await q.reserve({ ...base, month: "2026-11", caseId: "cas_1", nowMs: T0 });
  const next = await q.reserve({ ...base, month: "2026-12", caseId: "cas_1", nowMs: T0 });
  assert.equal(next.month, "2026-12");
  assert.equal(next.msgs, 1);
  assert.equal(next.used, 1);
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
  const again = await q.reserve({ ...base, caseId: "cas_0" });
  assert.equal(again.msgs, 2);
});
