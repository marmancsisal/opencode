import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { baseConfig, jsonResponse, sseResponse } from "./helpers.mjs";
import { UserStore } from "../src/store.js";
import { RateLimiter } from "../src/limits.js";
import { ModelProvider } from "../src/provider.js";
import { DeviceFlow } from "../src/auth.js";
import { createApp, startServer } from "../src/server.js";

// Upstream dei modelli simulato: registra le chiamate, risponde per scenario.
const calls = [];
let upstream = () => jsonResponse({});
const modelFetch = async (url, init) => {
  calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  return upstream(url, init);
};

// OAuth GitHub simulato per il device flow.
let polls = 0;
const oauthFetch = async (url) => {
  if (url.endsWith("/login/device/code")) {
    return jsonResponse({
      device_code: "dc-1",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      interval: 1,
      expires_in: 900,
    });
  }
  if (url.endsWith("/login/oauth/access_token")) {
    polls += 1;
    return polls === 1
      ? jsonResponse({ error: "authorization_pending" })
      : jsonResponse({ access_token: "gh-carol" });
  }
  if (url.endsWith("/user")) return jsonResponse({ id: 7, login: "carol" });
  return jsonResponse({}, { status: 404 });
};

let server;
let base;
let cfg;

before(async () => {
  cfg = baseConfig({
    oauth: { clientId: "Iv1.test", defaultGroups: ["junior"] },
    rules: [
      { id: "per-utente", match: {}, limits: { rpm: 3 } },
      { id: "junior-no-4o", match: { groups: ["junior"], models: ["openai/gpt-4o"] }, access: "deny" },
    ],
  });
  const app = createApp({
    cfg,
    store: new UserStore(cfg),
    limiter: new RateLimiter(),
    provider: new ModelProvider(cfg, { fetchImpl: modelFetch }),
    deviceFlow: new DeviceFlow(cfg.oauth, { fetchImpl: oauthFetch }),
  });
  server = await startServer(app, { host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

beforeEach(() => {
  calls.length = 0;
  upstream = () =>
    jsonResponse({
      id: "c1",
      choices: [{ message: { role: "assistant", content: "ciao" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
});

function chat(key, body) {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("healthz", async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, "ok");
});

test("senza api key -> 401 in formato OpenAI", async () => {
  const r = await fetch(`${base}/v1/models`);
  assert.equal(r.status, 401);
  assert.match((await r.json()).error.message, /login/);
});

test("/v1/models elenca auto + modelli consentiti all'utente", async () => {
  const r = await fetch(`${base}/v1/models`, { headers: { Authorization: "Bearer k-bob" } });
  const ids = (await r.json()).data.map((m) => m.id);
  assert.equal(ids[0], "auto");
  assert.ok(!ids.includes("openai/gpt-4o"));
  assert.ok(ids.includes("openai/gpt-4o-mini"));
});

test("chat non-streaming: modello random tra i consentiti, token dell'utente", async () => {
  const r = await chat("k-bob", { model: "auto", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 200);
  const selected = r.headers.get("x-selected-model");
  assert.ok(["openai/gpt-4o-mini", "meta/llama"].includes(selected));
  assert.equal((await r.json()).choices[0].message.content, "ciao");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.test/chat/completions");
  assert.equal(calls[0].headers.Authorization, "Bearer gh-bob");
  assert.equal(calls[0].body.model, selected);
  assert.equal(calls[0].body.stream, false);
});

test("chat: modello vietato al gruppo -> 403 senza chiamare l'upstream", async () => {
  const r = await chat("k-bob", { model: "openai/gpt-4o", messages: [] });
  assert.equal(r.status, 403);
  assert.equal(calls.length, 0);
});

test("chat streaming: passthrough SSE e include_usage richiesto", async () => {
  upstream = () =>
    sseResponse([
      { choices: [{ delta: { content: "ci" } }] },
      { choices: [{ delta: { content: "ao" } }] },
      { choices: [], usage: { total_tokens: 9 } },
      "[DONE]",
    ]);
  const r = await chat("k-alice", { model: "meta/llama", stream: true, messages: [] });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /event-stream/);
  const text = await r.text();
  assert.match(text, /"ci"/);
  assert.match(text, /\[DONE\]/);
  assert.equal(calls[0].body.stream_options.include_usage, true);
  assert.equal(calls[0].headers.Accept, "text/event-stream");
});

test("errore upstream rilanciato con lo stesso status", async () => {
  upstream = () => jsonResponse({ error: { message: "quota" } }, { status: 402 });
  const r = await chat("k-alice", { model: "meta/llama", messages: [] });
  assert.equal(r.status, 402);
  assert.equal((await r.json()).error.message, "quota");
});

test("x-initiator del client inoltrato", async () => {
  await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: "Bearer k-alice", "X-Initiator": "agent" },
    body: JSON.stringify({ model: "meta/llama", messages: [] }),
  });
  assert.equal(calls[0].headers["X-Initiator"], "agent");
});

test("limite rpm -> 429 con Retry-After", async () => {
  const cfg2 = baseConfig({ rules: [{ id: "uno", match: {}, limits: { rpm: 1 } }] });
  const app = createApp({
    cfg: cfg2,
    store: new UserStore(cfg2),
    limiter: new RateLimiter(),
    provider: new ModelProvider(cfg2, { fetchImpl: modelFetch }),
    deviceFlow: new DeviceFlow(cfg2.oauth, { fetchImpl: oauthFetch }),
  });
  const s = await startServer(app, { host: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${s.address().port}/v1/chat/completions`;
  const send = () =>
    fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer k-alice" },
      body: JSON.stringify({ model: "meta/llama", messages: [] }),
    });
  assert.equal((await send()).status, 200);
  const blocked = await send();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  assert.equal((await blocked.json()).error.type, "rate_limit_exceeded");
  await new Promise((r) => s.close(r));
});

test("device flow: start -> pending -> ok, poi l'api key funziona", async () => {
  const start = await (await fetch(`${base}/login/start`, { method: "POST" })).json();
  assert.equal(start.userCode, "ABCD-1234");
  assert.ok(start.handle.startsWith("dev_"));

  const poll = () =>
    fetch(`${base}/login/poll`, {
      method: "POST",
      body: JSON.stringify({ handle: start.handle }),
    }).then((r) => r.json());

  assert.equal((await poll()).status, "pending");
  const done = await poll();
  assert.equal(done.status, "ok");
  assert.equal(done.login, "carol");

  const r = await chat(done.apiKey, { model: "auto", messages: [] });
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1).headers.Authorization, "Bearer gh-carol");
  // carol riceve i gruppi di default (junior): niente gpt-4o.
  assert.equal((await chat(done.apiKey, { model: "openai/gpt-4o", messages: [] })).status, 403);
});

test("utente senza token GitHub: 401 e nessuna quota consumata", async () => {
  const cfg2 = baseConfig({
    users: [{ id: "dan", apiKey: "k-dan", groups: [] }],
    rules: [{ id: "uno", match: {}, limits: { rpm: 1 } }],
  });
  const limiter = new RateLimiter();
  const app = createApp({
    cfg: cfg2,
    store: new UserStore(cfg2),
    limiter,
    provider: new ModelProvider(cfg2, { fetchImpl: modelFetch }),
    deviceFlow: new DeviceFlow(cfg2.oauth, { fetchImpl: oauthFetch }),
  });
  const s = await startServer(app, { host: "127.0.0.1", port: 0 });
  const url = `http://127.0.0.1:${s.address().port}/v1/chat/completions`;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer k-dan" },
      body: JSON.stringify({ model: "meta/llama", messages: [] }),
    });
    assert.equal(r.status, 401);
  }
  assert.equal(limiter.snapshot(cfg2, cfg2.users[0], "meta/llama")[0].used, 0);
  assert.equal(calls.length, 0);
  await new Promise((r) => s.close(r));
});

test("rotta inesistente -> 404", async () => {
  const r = await fetch(`${base}/nope`, { headers: { Authorization: "Bearer k-alice" } });
  assert.equal(r.status, 404);
});
