import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { baseConfig, jsonResponse, makeDeps } from "./helpers.mjs";
import { UserStore } from "../src/store.js";
import { RateLimiter } from "../src/limits.js";
import { ModelProvider } from "../src/provider.js";
import { DeviceFlow } from "../src/auth.js";
import { MetricsStore } from "../src/metrics.js";
import { createApp, startServer } from "../src/server.js";
import { maskKey } from "../src/admin.js";

const ADMIN = "tok-admin-123";
let server, baseUrl, store, metrics, cfg;

const modelFetch = async () =>
  jsonResponse({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 7 } });

before(async () => {
  cfg = baseConfig({
    admin: { token: ADMIN },
    rules: [
      { id: "lim", match: {}, limits: { rpm: 50 } },
      { id: "junior-no-4o", match: { groups: ["junior"], models: ["openai/gpt-4o"] }, access: "deny" },
    ],
  });
  ({ store, metrics } = makeDeps(cfg));
  const app = createApp({
    cfg,
    store,
    limiter: new RateLimiter(),
    provider: new ModelProvider(cfg, { fetchImpl: modelFetch }),
    deviceFlow: new DeviceFlow(cfg.oauth, { fetchImpl: async () => jsonResponse({}) }),
    metrics,
  });
  server = await startServer(app, { host: "127.0.0.1", port: 0 });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

const adm = (path, opts = {}) =>
  fetch(`${baseUrl}${path}`, { ...opts, headers: { Authorization: `Bearer ${ADMIN}`, ...(opts.headers || {}) } });

async function chatAs(key, model = "auto") {
  return fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [] }),
  });
}

test("maskKey nasconde il centro", () => {
  assert.equal(maskKey("byok_1234567890abcdef"), "byok_1234…cdef");
  assert.equal(maskKey("corta"), "cor…");
  assert.equal(maskKey(null), null);
});

test("pagina /admin servita e dashboard.js servito", async () => {
  const page = await fetch(`${baseUrl}/admin`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /Admin proxy/);
  assert.match(html, /dashboard\.js/);
  const js = await fetch(`${baseUrl}/admin/dashboard.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /javascript/);
  const body = await js.text();
  assert.match(body, /renderClients/);
  assert.match(body, /renderCharts/);
});

test("API admin senza token -> 401", async () => {
  const r = await fetch(`${baseUrl}/admin/api/overview`);
  assert.equal(r.status, 401);
});

test("API admin con token errato -> 401", async () => {
  const r = await fetch(`${baseUrl}/admin/api/overview`, { headers: { Authorization: "Bearer sbagliato" } });
  assert.equal(r.status, 401);
});

test("overview riflette clienti e utilizzo", async () => {
  await chatAs("k-alice", "meta/llama");
  const o = await (await adm("/admin/api/overview")).json();
  assert.equal(o.clients.total, 2);
  assert.equal(o.clients.enabled, 2);
  assert.ok(o.usage.requests >= 1);
  assert.ok(o.models.includes("openai/gpt-4o"));
});

test("lista clienti: niente api key o token in chiaro", async () => {
  const { data } = await (await adm("/admin/api/clients")).json();
  const alice = data.find((c) => c.id === "alice");
  assert.equal(alice.apiKeyHint, maskKey("k-alice"));
  assert.ok(!JSON.stringify(data).includes("k-alice"));
  assert.ok(!JSON.stringify(data).includes("gh-alice"));
  assert.equal(alice.hasGithubToken, true);
  assert.ok(Array.isArray(alice.allowedModels));
});

test("dettaglio cliente: limiti e eventi recenti", async () => {
  await chatAs("k-bob", "meta/llama");
  const c = await (await adm("/admin/api/clients/bob")).json();
  assert.equal(c.login, "bob");
  assert.ok(Array.isArray(c.limits));
  assert.ok(c.recent.every((e) => e.userId === "bob"));
});

test("disabilita e riabilita un cliente", async () => {
  const off = await adm("/admin/api/clients/alice/disable", { method: "POST" });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).enabled, false);

  // ora alice non può più usare il proxy
  const blocked = await chatAs("k-alice", "meta/llama");
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.type, "user_disabled");

  const on = await adm("/admin/api/clients/alice/enable", { method: "POST" });
  assert.equal((await on.json()).enabled, true);
  assert.equal((await chatAs("k-alice", "meta/llama")).status, 200);
});

test("modifica gruppi di un cliente", async () => {
  const r = await adm("/admin/api/clients/bob/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groups: ["senior", "senior"] }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).groups, ["senior"]);
  // bob non è più junior: ora può usare gpt-4o (prima vietato)
  const c = await (await adm("/admin/api/clients/bob")).json();
  assert.ok(c.allowedModels.includes("openai/gpt-4o"));
});

test("gruppi non validi -> 400", async () => {
  const r = await adm("/admin/api/clients/bob/groups", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groups: [1, 2] }),
  });
  assert.equal(r.status, 400);
});

test("un cliente da config non si può revocare (DELETE) ma solo disattivare", async () => {
  const r = await adm("/admin/api/clients/alice", { method: "DELETE" });
  assert.equal(r.status, 400);
});

test("usage ritorna serie per giorno/modello/utente", async () => {
  const u = await (await adm("/admin/api/usage?days=7")).json();
  assert.equal(u.byDay.length, 7);
  assert.ok(Array.isArray(u.byModel));
  assert.ok(Array.isArray(u.topUsers));
});

test("events elenca eventi con esito", async () => {
  const { data } = await (await adm("/admin/api/events?limit=10")).json();
  assert.ok(data.length > 0);
  assert.ok(data.every((e) => ["allowed", "blocked", "error"].includes(e.outcome)));
});

test("rules espone regole e gruppi noti", async () => {
  const r = await (await adm("/admin/api/rules")).json();
  assert.ok(r.rules.some((x) => x.id === "lim"));
  assert.ok(Array.isArray(r.groups));
});

test("clients API: paginazione, ricerca, ordinamento lato server", async () => {
  const p = await (await adm("/admin/api/clients?limit=1&offset=0&sort=login&dir=asc")).json();
  assert.equal(p.total, 2);
  assert.equal(p.data.length, 1);
  assert.equal(p.data[0].id, "alice");
  const p2 = await (await adm("/admin/api/clients?limit=1&offset=1&sort=login&dir=asc")).json();
  assert.equal(p2.data[0].id, "bob");
  const q = await (await adm("/admin/api/clients?q=bo")).json();
  assert.deepEqual(q.data.map((c) => c.id), ["bob"]);
  assert.ok(q.data[0].usage.requests >= 0);
});

test("events API: cursore e filtro esito", async () => {
  for (let i = 0; i < 5; i++) await chatAs("k-alice", "meta/llama");
  const p1 = await (await adm("/admin/api/events?limit=2")).json();
  assert.equal(p1.data.length, 2);
  assert.ok(p1.nextBefore);
  const p2 = await (await adm(`/admin/api/events?limit=2&before=${p1.nextBefore}`)).json();
  assert.ok(p2.data[0].id < p1.data[1].id);
  const ok = await (await adm("/admin/api/events?outcome=allowed&limit=50")).json();
  assert.ok(ok.data.every((e) => e.outcome === "allowed"));
});

test("le letture admin vedono subito gli eventi appena registrati", async () => {
  const before = (await (await adm("/admin/api/overview")).json()).usage.requests;
  await chatAs("k-alice", "meta/llama");
  const after = (await (await adm("/admin/api/overview")).json()).usage.requests;
  assert.equal(after, before + 1);
});

test("area admin disattivata se manca il token in config", async () => {
  const cfg2 = baseConfig(); // nessun admin.token
  const deps = makeDeps(cfg2);
  const app = createApp({
    cfg: cfg2,
    store: deps.store,
    limiter: new RateLimiter(),
    provider: new ModelProvider(cfg2, { fetchImpl: modelFetch }),
    deviceFlow: new DeviceFlow(cfg2.oauth, { fetchImpl: async () => jsonResponse({}) }),
    metrics: deps.metrics,
  });
  const s = await startServer(app, { host: "127.0.0.1", port: 0 });
  const r = await fetch(`http://127.0.0.1:${s.address().port}/admin/api/overview`, {
    headers: { Authorization: "Bearer qualsiasi" },
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.type, "admin_disabled");
  await new Promise((res) => s.close(res));
});
