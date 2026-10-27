// Benchmark di scala: crea N clienti e M eventi distribuiti su 90 giorni in un
// DB su file, poi misura le query della dashboard e le API HTTP admin.
//
//   npm run bench                       # 2000 clienti, 500k eventi
//   BENCH_USERS=5000 BENCH_EVENTS=2000000 npm run bench
//
// Il DB viene creato in una cartella temporanea e cancellato alla fine.

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { UserStore } from "../src/store.js";
import { MetricsStore } from "../src/metrics.js";
import { clearUsageCache, closeUsageWorkers } from "../src/usage-cache.js";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RateLimiter } from "../src/limits.js";
import { ModelProvider } from "../src/provider.js";
import { DeviceFlow } from "../src/auth.js";
import { createApp, startServer } from "../src/server.js";

const USERS = Number(process.env.BENCH_USERS) || 2000;
const EVENTS = Number(process.env.BENCH_EVENTS) || 500_000;
const DAYS = 90;
const DAY = 86_400_000;
const MODELS = ["openai/gpt-4o-mini", "openai/gpt-4o", "meta/llama", "mistral/large", "anthropic/sonnet"];
const GROUPS = ["standard", "junior", "senior", "contractor", "ops"];

const dir = mkdtempSync(join(tmpdir(), "byok-bench-"));
const dbPath = join(dir, "proxy.db");
const fmt = (n) => new Intl.NumberFormat("it-IT").format(n);
const ms = (t) => `${t.toFixed(t < 10 ? 2 : 0)} ms`;

function time(label, fn, runs = 20) {
  fn(); // riscaldamento
  const xs = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  const p50 = xs[Math.floor(runs / 2)];
  const p95 = xs[Math.floor(runs * 0.95)] ?? xs.at(-1);
  console.log(`  ${label.padEnd(46)} p50 ${ms(p50).padStart(9)}   p95 ${ms(p95).padStart(9)}`);
}

async function timeA(label, fn, runs = 20) {
  await fn();
  const xs = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  console.log(`  ${label.padEnd(46)} p50 ${ms(xs[Math.floor(runs / 2)]).padStart(9)}   p95 ${ms(xs[Math.floor(runs * 0.95)] ?? xs.at(-1)).padStart(9)}`);
}

async function timeHttp(label, fn, runs = 20) {
  await fn();
  const xs = [];
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    await fn();
    xs.push(performance.now() - t);
  }
  xs.sort((a, b) => a - b);
  console.log(`  ${label.padEnd(46)} p50 ${ms(xs[Math.floor(runs / 2)]).padStart(9)}   p95 ${ms(xs[Math.floor(runs * 0.95)] ?? xs.at(-1)).padStart(9)}`);
}

console.log(`\nbyok-proxy bench: ${fmt(USERS)} clienti, ${fmt(EVENTS)} eventi su ${DAYS} giorni\n`);

const users = Array.from({ length: USERS }, (_, i) => ({
  id: `user${String(i).padStart(5, "0")}`,
  apiKey: `byok_bench_${i}_${"x".repeat(20)}`,
  groups: [GROUPS[i % GROUPS.length]],
  githubToken: "t",
}));
const cfg = loadConfig({
  provider: { baseUrl: "https://bench.local/chat" },
  admin: { token: "bench" },
  models: MODELS,
  users,
  rules: [
    { id: "per-utente", match: {}, limits: { rpm: 60, rpd: 2000 } },
    { id: "junior", match: { groups: ["junior"] }, limits: { rpm: 10 } },
    { id: "no-4o-junior", match: { groups: ["junior"], models: ["openai/gpt-4o"] }, access: "deny" },
  ],
});

let t = performance.now();
const db = openDb(dbPath);
const store = new UserStore(cfg, { db });
console.log(`Setup clienti: ${fmt(USERS)} in ${ms(performance.now() - t)}`);

// Distribuzione realistica: pochi clienti molto attivi, coda lunga.
const now = Date.now();
const metrics = new MetricsStore({ db, flushIntervalMs: 0, batchSize: 2000 });
t = performance.now();
// mulberry32: generatore deterministico con buona distribuzione.
let seed = 42;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};
const start = now - DAYS * DAY;
for (let i = 0; i < EVENTS; i++) {
  const u = Math.floor(USERS * rnd() ** 2.2);
  const r = rnd();
  const outcome = r < 0.88 ? "allowed" : r < 0.97 ? "blocked" : "error";
  metrics.record({
    // In ordine di tempo, come il traffico reale.
    ts: start + Math.floor((i / EVENTS) * DAYS * DAY),
    userId: users[u].id,
    model: MODELS[Math.floor(rnd() * MODELS.length)],
    outcome,
    status: outcome === "allowed" ? 200 : outcome === "blocked" ? 429 : 502,
    tokens: outcome === "allowed" ? 50 + Math.floor(rnd() * 3000) : 0,
    latencyMs: outcome === "allowed" ? 150 + Math.floor(rnd() * 2500) : undefined,
    reason: outcome === "blocked" ? "limit:per-utente" : undefined,
  });
}
metrics.flush();
const ingest = performance.now() - t;
console.log(`Scrittura eventi: ${fmt(EVENTS)} in ${ms(ingest)} (${fmt(Math.round(EVENTS / (ingest / 1000)))} eventi/s)`);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const count = (t) => fmt(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n);
console.log(`Riepiloghi: giorno ${count("usage_day")} · cliente×giorno ${count("usage_user_day")} · modello×giorno ${count("usage_model_day")} · cliente×modello×giorno ${count("usage_daily")}`);
console.log(`Clienti con traffico: ${fmt(db.prepare("SELECT COUNT(DISTINCT user_id) n FROM usage_user_day").get().n)} · DB su disco: ${(statSync(dbPath).size / 1e6).toFixed(1)} MB\n`);

console.log("Percorso della richiesta");
let k = 0;
time("lookup api key -> cliente (x10.000)", () => {
  for (let i = 0; i < 10_000; i++) store.resolveByApiKey(users[(k++ * 7919) % USERS].apiKey);
});
const limiter = new RateLimiter();
time("controllo limiti (x10.000)", () => {
  for (let i = 0; i < 10_000; i++) limiter.tryConsume(cfg, store.byId.get(users[(k++ * 31) % USERS].id), MODELS[i % 5]);
});
metrics.batchSize = Infinity; // misura solo record(), senza scrittura
time("record evento nel buffer (x10.000)", () => {
  for (let i = 0; i < 10_000; i++) metrics.record({ userId: users[i % USERS].id, model: MODELS[i % 5], outcome: "allowed", tokens: 10 });
  metrics.buffer.length = 0;
});
metrics.batchSize = 2000;
const buf = Array.from({ length: 500 }, (_, i) => ({ ts: Date.now(), userId: users[i % USERS].id, model: MODELS[i % 5], outcome: "allowed", tokens: 10, latencyMs: 300 }));
time("flush di un lotto da 500 eventi", () => {
  metrics.buffer = buf.slice();
  metrics.flush();
});

console.log("\nQuery dashboard");
await timeA("overview 30 giorni", () => metrics.overview(30));
await timeA("overview 365 giorni", () => metrics.overview(365));
time("serie giornaliera 90 giorni", () => metrics.byDay(90));
time("utilizzo per modello 30 giorni", () => metrics.byModel(30));
await timeA("top 10 clienti 30 giorni", () => metrics.topUsers(30, 10));
const since = metrics.sinceDay(30);
await timeA("clienti: pag. 1, ordina per richieste", () => store.queryClients({ sinceDay: since }));
await timeA("clienti: pag. 30, ordina per token", () => store.queryClients({ sinceDay: since, sort: "tokens", offset: 1450 }));
await timeA("clienti: ricerca 'user01' + ordina login", () => store.queryClients({ sinceDay: since, q: "user01", sort: "login", dir: "asc" }));
await timeA("clienti: filtro disattivati", () => store.queryClients({ sinceDay: since, status: "disabled" }));

// Cache fredda: il ricalcolo gira nel worker. Misuriamo il tempo di attesa
// della dashboard e quanto resta bloccato il thread principale (che serve le chat).
const sql = `SELECT user_id, SUM(requests) r FROM usage_user_day WHERE day >= ? GROUP BY user_id`;
time("  (stesso aggregato nel thread principale)", () => db.prepare(sql).all(since), 5);
const eld = monitorEventLoopDelay({ resolution: 1 });
eld.enable();
await timeA("clienti: pag. 1 a cache fredda (worker)", async () => {
  clearUsageCache(db);
  await store.queryClients({ sinceDay: since });
}, 5);
eld.disable();
console.log(`  ${"blocco max del thread principale nel frattempo".padEnd(46)}     ${ms(eld.max / 1e6).padStart(9)}`);
time("eventi: prima pagina (100)", () => metrics.events({ limit: 100 }));
const deep = metrics.events({ limit: 500 }).nextBefore;
time("eventi: pagina profonda (cursore)", () => metrics.events({ limit: 100, before: Math.floor(deep / 2) }));
time("eventi: solo bloccati", () => metrics.events({ outcome: "blocked", limit: 100 }));
time("eventi: di un cliente", () => metrics.events({ userId: users[3].id, limit: 100 }));
time("eventi: ricerca testo 'mistral'", () => metrics.events({ q: "mistral", limit: 100 }));
time("eventi: ricerca rara (caso peggiore)", () => metrics.events({ q: "nessuna-corrispondenza", limit: 100 }), 5);
time("eventi: q = id cliente (filtro esatto)", () => metrics.events({ q: users[1500].id, limit: 100 }));
time("dettaglio cliente (utilizzo + ultimi 50)", () => {
  metrics.forUser(users[0].id, 30);
  metrics.recentForUser(users[0].id, 50);
});

console.log("\nAPI HTTP admin (end-to-end, JSON incluso)");
const app = createApp({
  cfg,
  store,
  limiter,
  provider: new ModelProvider(cfg, { fetchImpl: async () => new Response("{}") }),
  deviceFlow: new DeviceFlow(cfg.oauth),
  metrics,
});
const server = await startServer(app, { host: "127.0.0.1", port: 0 });
const base = `http://127.0.0.1:${server.address().port}/admin/api`;
const get = (p) => fetch(base + p, { headers: { Authorization: "Bearer bench" } }).then((r) => r.json());
await timeHttp("GET /overview?days=30", () => get("/overview?days=30"));
await timeHttp("GET /usage?days=90", () => get("/usage?days=90"));
await timeHttp("GET /clients (50 righe)", () => get("/clients?limit=50&days=30"));
await timeHttp("GET /clients?q=user0&sort=tokens", () => get("/clients?q=user0&sort=tokens&days=30"));
await timeHttp("GET /events (100 righe)", () => get("/events?limit=100"));
await timeHttp(`GET /clients/${users[0].id}`, () => get(`/clients/${users[0].id}?days=30`));
const sizes = {
  clients: JSON.stringify(await get("/clients?limit=50")).length,
  events: JSON.stringify(await get("/events?limit=100")).length,
  usage: JSON.stringify(await get("/usage?days=90")).length,
};
console.log(`\nDimensione risposte: clienti ${(sizes.clients / 1024).toFixed(1)} KB · eventi ${(sizes.events / 1024).toFixed(1)} KB · usage ${(sizes.usage / 1024).toFixed(1)} KB`);
console.log(`Memoria del processo di benchmark (picco, include i dati generati): ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB RSS`);

await new Promise((r) => server.close(r));
metrics.close();
await closeUsageWorkers();
db.close();

// Memoria a regime: un processo nuovo che apre il DB come il proxy e serve la dashboard.
const src = fileURLToPath(new URL("../src/", import.meta.url));
const probe = `
  const { loadConfig } = await import(${JSON.stringify(src + "config.js")});
  const { openDb } = await import(${JSON.stringify(src + "db.js")});
  const { UserStore } = await import(${JSON.stringify(src + "store.js")});
  const { MetricsStore } = await import(${JSON.stringify(src + "metrics.js")});
  const { closeUsageWorkers } = await import(${JSON.stringify(src + "usage-cache.js")});
  const users = Array.from({ length: ${USERS} }, (_, i) => ({ id: "user" + String(i).padStart(5, "0"), apiKey: "k" + i, githubToken: "t" }));
  const cfg = loadConfig({ provider: { baseUrl: "https://x.local" }, models: ${JSON.stringify(MODELS)}, users });
  const db = openDb(${JSON.stringify(dbPath)});
  const store = new UserStore(cfg, { db });
  const m = new MetricsStore({ db, flushIntervalMs: 0 });
  for (const d of [7, 30, 90, 365]) { await m.overview(d); await store.queryClients({ sinceDay: m.sinceDay(d) }); m.byDay(d); m.byModel(d); }
  m.events({ limit: 100 });
  console.log(Math.round(process.memoryUsage().rss / 1e6));
  await closeUsageWorkers();
`;
const probeFile = join(dir, "probe.mjs");
writeFileSync(probeFile, probe);
const rss = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", probeFile]).toString().trim();
console.log(`Memoria a regime (processo nuovo, ${fmt(USERS)} clienti, dashboard usata): ${rss} MB RSS`);
rmSync(dir, { recursive: true, force: true });
