import { test } from "node:test";
import assert from "node:assert/strict";
import { MetricsStore } from "../src/metrics.js";
import { fakeClock } from "./helpers.mjs";

function seed(m) {
  m.record({ userId: "alice", login: "alice", model: "m1", outcome: "allowed", tokens: 100, status: 200 });
  m.record({ userId: "alice", login: "alice", model: "m1", outcome: "blocked", status: 429 });
  m.record({ userId: "bob", login: "bob", model: "m2", outcome: "allowed", tokens: 50, status: 200 });
  m.record({ userId: "bob", login: "bob", model: "m1", outcome: "error", status: 502 });
}

test("overview aggrega totali, utenti e modelli", () => {
  const m = new MetricsStore();
  seed(m);
  const o = m.overview();
  assert.equal(o.requests, 4);
  assert.equal(o.allowed, 2);
  assert.equal(o.blocked, 1);
  assert.equal(o.errors, 1);
  assert.equal(o.tokens, 150);
  assert.equal(o.users, 2);
  assert.equal(o.models, 2);
});

test("per utente: ordinati per richieste, con login e lastSeen", () => {
  const m = new MetricsStore();
  seed(m);
  const users = m.users();
  assert.equal(users[0].userId, "alice");
  assert.equal(users[0].requests, 2);
  assert.equal(users[0].tokens, 100);
  assert.ok(users[0].lastSeen >= users[0].firstSeen);
  assert.equal(m.forUser("bob").errors, 1);
  assert.equal(m.forUser("ignoto").requests, 0);
});

test("per modello aggrega tutti gli utenti", () => {
  const m = new MetricsStore();
  seed(m);
  const byModel = Object.fromEntries(m.byModel().map((x) => [x.model, x]));
  assert.equal(byModel.m1.requests, 3);
  assert.equal(byModel.m1.tokens, 100);
  assert.equal(byModel.m2.requests, 1);
});

test("byDay copre il numero di giorni richiesto e colloca gli eventi nel giorno giusto", () => {
  const clock = fakeClock(Date.parse("2026-03-10T12:00:00Z"));
  const m = new MetricsStore({ now: clock });
  m.record({ userId: "a", model: "m", outcome: "allowed", tokens: 10 });
  clock.advance(2 * 86_400_000);
  m.record({ userId: "a", model: "m", outcome: "allowed", tokens: 20 });
  const days = m.byDay(7);
  assert.equal(days.length, 7);
  assert.equal(days.at(-1).day, "2026-03-12");
  assert.equal(days.at(-1).tokens, 20);
  assert.equal(days.at(-3).day, "2026-03-10");
  assert.equal(days.at(-3).tokens, 10);
});

test("recentEvents: più recenti in testa e rispetta il limite dell'anello", () => {
  const m = new MetricsStore({ recentLimit: 3 });
  for (let i = 0; i < 5; i++) m.record({ userId: "u", model: `m${i}`, outcome: "allowed" });
  const r = m.recentEvents(10);
  assert.equal(r.length, 3);
  assert.equal(r[0].model, "m4");
  assert.equal(r[2].model, "m2");
});

test("prune: i giorni oltre la retention vengono scartati", () => {
  const clock = fakeClock(Date.parse("2026-01-01T00:00:00Z"));
  const m = new MetricsStore({ now: clock, retentionDays: 5 });
  m.record({ userId: "a", model: "m", outcome: "allowed" });
  clock.advance(10 * 86_400_000);
  m.record({ userId: "a", model: "m", outcome: "allowed" });
  assert.ok(!m.perDay.has("2026-01-01"));
  assert.ok(m.perDay.has("2026-01-11"));
});
