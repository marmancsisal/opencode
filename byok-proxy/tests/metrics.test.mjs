import { test } from "node:test";
import assert from "node:assert/strict";
import { baseConfig, fakeClock, makeDeps } from "./helpers.mjs";

const T0 = Date.parse("2026-03-10T12:00:00Z");
const DAY = 86_400_000;

function seed(metrics) {
  metrics.record({ userId: "alice", model: "m1", outcome: "allowed", tokens: 100, status: 200, latencyMs: 300 });
  metrics.record({ userId: "alice", model: "m1", outcome: "blocked", status: 429 });
  metrics.record({ userId: "bob", model: "m2", outcome: "allowed", tokens: 50, status: 200, latencyMs: 100 });
  metrics.record({ userId: "bob", model: "m1", outcome: "error", status: 502 });
}

test("overview aggrega totali, utenti, modelli e latenza media", async () => {
  const { metrics } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  seed(metrics);
  metrics.flush();
  const o = await metrics.overview(30);
  assert.equal(o.requests, 4);
  assert.equal(o.allowed, 2);
  assert.equal(o.blocked, 1);
  assert.equal(o.errors, 1);
  assert.equal(o.tokens, 150);
  assert.equal(o.users, 2);
  assert.equal(o.models, 2);
  assert.equal(o.avgLatencyMs, 200);
});

test("lotto pieno: scritto al giro successivo, non dentro record()", async () => {
  const { metrics } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  metrics.batchSize = 3;
  for (let i = 0; i < 3; i++) metrics.record({ userId: "a", model: "m", outcome: "allowed" });
  assert.equal(metrics.buffer.length, 3, "record() non deve scrivere sul DB");
  await new Promise((r) => setImmediate(r));
  assert.equal(metrics.buffer.length, 0);
  assert.equal((await metrics.overview(1)).requests, 3);
});

test("i quattro riepiloghi restano coerenti tra loro", () => {
  const { metrics, db } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  seed(metrics);
  metrics.flush();
  const sum = (t) => db.prepare(`SELECT SUM(requests) r, SUM(tokens) k FROM ${t}`).get();
  const ref = sum("usage_day");
  for (const t of ["usage_user_day", "usage_model_day", "usage_daily"]) assert.deepEqual(sum(t), ref, t);
  assert.equal(ref.r, 4);
});

test("events: q uguale a un cliente o modello noto diventa filtro esatto", () => {
  const { metrics } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  metrics.record({ userId: "alice", model: "m1", outcome: "allowed" });
  metrics.record({ userId: "alice2", model: "m1", outcome: "allowed" });
  metrics.flush();
  // "alice" è un cliente noto: niente LIKE, quindi "alice2" non compare.
  assert.deepEqual(metrics.events({ q: "alice" }).data.map((e) => e.userId), ["alice"]);
});

test("topUsers ordina per richieste e porta il login", async () => {
  const { metrics } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  seed(metrics);
  metrics.record({ userId: "bob", model: "m2", outcome: "allowed" });
  metrics.flush();
  const top = await metrics.topUsers(30, 10);
  assert.equal(top[0].userId, "bob");
  assert.equal(top[0].requests, 3);
  assert.equal(top[0].login, "bob");
});

test("forUser: periodo, prima/ultima richiesta, ripartizione per modello", () => {
  const clock = fakeClock(T0);
  const { metrics } = makeDeps(baseConfig(), { now: clock });
  metrics.record({ userId: "alice", model: "m1", outcome: "allowed", tokens: 10 });
  clock.advance(DAY);
  metrics.record({ userId: "alice", model: "m2", outcome: "allowed", tokens: 20 });
  metrics.flush();
  const u = metrics.forUser("alice", 30);
  assert.equal(u.requests, 2);
  assert.equal(u.tokens, 30);
  assert.equal(u.firstSeen, T0);
  assert.equal(u.lastSeen, T0 + DAY);
  assert.deepEqual(u.byModel.map((m) => m.model).sort(), ["m1", "m2"]);
  // Solo oggi: un giorno di finestra.
  assert.equal(metrics.forUser("alice", 1).requests, 1);
  assert.equal(metrics.forUser("ignoto", 30).requests, 0);
});

test("byModel per periodo con latenza media", () => {
  const { metrics } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  seed(metrics);
  metrics.flush();
  const m = Object.fromEntries(metrics.byModel(30).map((x) => [x.model, x]));
  assert.equal(m.m1.requests, 3);
  assert.equal(m.m1.tokens, 100);
  assert.equal(m.m1.avgLatencyMs, 300);
  assert.equal(m.m2.requests, 1);
});

test("byDay: serie completa con giorni vuoti a zero", () => {
  const clock = fakeClock(T0);
  const { metrics } = makeDeps(baseConfig(), { now: clock });
  metrics.record({ userId: "a", model: "m", outcome: "allowed", tokens: 10 });
  clock.advance(2 * DAY);
  metrics.record({ userId: "a", model: "m", outcome: "allowed", tokens: 20 });
  metrics.flush();
  const days = metrics.byDay(7);
  assert.equal(days.length, 7);
  assert.equal(days.at(-1).day, "2026-03-12");
  assert.equal(days.at(-1).tokens, 20);
  assert.equal(days.at(-2).requests, 0);
  assert.equal(days.at(-3).day, "2026-03-10");
  assert.equal(days.at(-3).tokens, 10);
});

test("events: paginazione a cursore dal più recente, con filtri", () => {
  const { metrics } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  for (let i = 0; i < 25; i++) {
    metrics.record({ userId: i % 2 ? "alice" : "bob", model: `m${i % 3}`, outcome: i % 5 ? "allowed" : "blocked" });
  }
  metrics.flush();
  const p1 = metrics.events({ limit: 10 });
  assert.equal(p1.data.length, 10);
  assert.ok(p1.nextBefore);
  assert.ok(p1.data[0].id > p1.data[9].id);
  const p2 = metrics.events({ limit: 10, before: p1.nextBefore });
  assert.ok(p2.data[0].id < p1.data[9].id);
  const p3 = metrics.events({ limit: 10, before: p2.nextBefore });
  assert.equal(p3.data.length, 5);
  assert.equal(p3.nextBefore, null);

  const blocked = metrics.events({ outcome: "blocked", limit: 100 });
  assert.equal(blocked.data.length, 5);
  assert.ok(blocked.data.every((e) => e.outcome === "blocked"));
  assert.ok(metrics.events({ userId: "alice" }).data.every((e) => e.userId === "alice"));
  assert.ok(metrics.events({ q: "m2" }).data.every((e) => e.model === "m2"));
  // Login dalla tabella utenti.
  assert.equal(metrics.events({ userId: "alice", limit: 1 }).data[0].login, "alice");
});

test("ricerca eventi: i caratteri jolly di LIKE sono letterali", () => {
  const { metrics } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  metrics.record({ userId: "a", model: "m_1", outcome: "allowed" });
  metrics.record({ userId: "a", model: "mx1", outcome: "allowed" });
  metrics.flush();
  assert.deepEqual(metrics.events({ q: "m_1" }).data.map((e) => e.model), ["m_1"]);
  assert.equal(metrics.events({ q: "%" }).data.length, 0);
});

test("recentForUser: ultimi eventi di un solo cliente", () => {
  const { metrics } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  seed(metrics);
  metrics.flush();
  const r = metrics.recentForUser("bob", 10);
  assert.equal(r.length, 2);
  assert.ok(r.every((e) => e.userId === "bob"));
});

test("prune: eventi oltre la retention cancellati, riepiloghi conservati più a lungo", async () => {
  const clock = fakeClock(T0);
  const { metrics } = makeDeps(baseConfig(), { now: clock });
  metrics.retentionDays = 5;
  metrics.rollupRetentionDays = 30;
  metrics.record({ userId: "a", model: "m", outcome: "allowed", tokens: 7 });
  metrics.flush();
  clock.advance(10 * DAY);
  metrics.record({ userId: "a", model: "m", outcome: "allowed" });
  metrics.flush();
  assert.equal(metrics.prune(), 1);
  assert.equal(metrics.events({}).data.length, 1);
  // Il riepilogo del primo giorno c'è ancora: i totali non cambiano.
  assert.equal((await metrics.overview(30)).tokens, 7);
});

test("i dati sopravvivono al riavvio (stesso file DB)", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb } = await import("../src/db.js");
  const { MetricsStore } = await import("../src/metrics.js");
  const path = join(mkdtempSync(join(tmpdir(), "byok-db-")), "proxy.db");

  const db1 = openDb(path);
  const m1 = new MetricsStore({ db: db1, flushIntervalMs: 0 });
  m1.record({ userId: "a", model: "m", outcome: "allowed", tokens: 5 });
  m1.close();
  db1.close();

  const db2 = openDb(path);
  const m2 = new MetricsStore({ db: db2, flushIntervalMs: 0 });
  assert.equal((await m2.overview(1)).tokens, 5);
  db2.close();
});

test("ricerca parziale su più clienti: unione ordinata per id e paginabile", () => {
  const users = ["team-a1", "team-a2", "team-b1", "solo"].map((id) => ({ id, apiKey: `k-${id}` }));
  const { metrics } = makeDeps(baseConfig({ users }), { now: fakeClock(T0) });
  for (let i = 0; i < 30; i++) metrics.record({ userId: users[i % 4].id, model: "m", outcome: "allowed" });
  metrics.flush();
  const all = [];
  let before = null;
  do {
    const p = metrics.events({ q: "team-a", limit: 4, before });
    all.push(...p.data);
    before = p.nextBefore;
  } while (before);
  assert.ok(all.every((e) => e.userId.startsWith("team-a")));
  assert.equal(all.length, 16); // i % 4 in {0,1} su 30 eventi
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].id > all[i].id, "ordine decrescente, senza doppioni");
});

test("ricerca senza corrispondenze: risposta vuota", () => {
  const { metrics } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  seed(metrics);
  metrics.flush();
  assert.deepEqual(metrics.events({ q: "inesistente" }), { data: [], nextBefore: null });
});

test("ricerca per modello parziale e combinata con l'esito", () => {
  const { metrics } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  metrics.record({ userId: "alice", model: "openai/gpt-4o", outcome: "allowed" });
  metrics.record({ userId: "alice", model: "openai/gpt-4o-mini", outcome: "blocked" });
  metrics.record({ userId: "bob", model: "meta/llama", outcome: "blocked" });
  metrics.flush();
  assert.equal(metrics.events({ q: "openai" }).data.length, 2);
  assert.deepEqual(metrics.events({ q: "openai", outcome: "blocked" }).data.map((e) => e.model), ["openai/gpt-4o-mini"]);
});

test("termine generico (oltre la soglia di fan-out): stessi risultati via scansione", () => {
  const users = Array.from({ length: 60 }, (_, i) => ({ id: `cliente${i}`, apiKey: `k${i}` }));
  const { metrics } = makeDeps(baseConfig({ users }), { now: fakeClock(T0) });
  for (let i = 0; i < 120; i++) metrics.record({ userId: users[i % 60].id, model: "m", outcome: "allowed" });
  metrics.record({ userId: "altro", model: "m", outcome: "allowed" });
  metrics.flush();
  const r = metrics.events({ q: "cliente", limit: 500 });
  assert.equal(r.data.length, 120);
  assert.ok(r.data.every((e) => e.userId.startsWith("cliente")));
});

test("cache utilizzo: alla scadenza restituisce subito il dato precedente e si aggiorna in background", async () => {
  const { usageByUser, clearUsageCache } = await import("../src/usage-cache.js");
  const { metrics, db } = makeDeps(baseConfig(), { now: fakeClock(T0) });
  const since = metrics.sinceDay(30);
  metrics.record({ userId: "alice", model: "m", outcome: "allowed" });
  metrics.flush();
  assert.equal((await usageByUser(db, since, 0)).get("alice").requests, 1);
  metrics.record({ userId: "alice", model: "m", outcome: "allowed" });
  metrics.flush();
  // TTL scaduto: risposta immediata con il valore precedente...
  assert.equal((await usageByUser(db, since, 0)).get("alice").requests, 1);
  await new Promise((r) => setImmediate(r));
  // ...e al giro dopo il valore aggiornato.
  assert.equal((await usageByUser(db, since, 0)).get("alice").requests, 2);
  clearUsageCache(db);
});

test("cache utilizzo: con DB su file il calcolo gira nel worker", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb } = await import("../src/db.js");
  const { MetricsStore } = await import("../src/metrics.js");
  const { usageByUser } = await import("../src/usage-cache.js");
  const db = openDb(join(mkdtempSync(join(tmpdir(), "byok-w-")), "proxy.db"));
  const m = new MetricsStore({ db, flushIntervalMs: 0 });
  for (let i = 0; i < 3; i++) m.record({ userId: `u${i}`, model: "m", outcome: "allowed", tokens: i });
  m.flush();
  const map = await usageByUser(db, m.sinceDay(1), 0);
  assert.equal(map.size, 3);
  assert.equal(map.get("u2").tokens, 2);
  assert.deepEqual((await m.topUsers(1, 2)).map((u) => u.requests), [1, 1]);
  db.close();
});
