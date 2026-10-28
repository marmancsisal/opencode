import { test } from "node:test";
import assert from "node:assert/strict";
import { baseConfig, jsonResponse } from "./helpers.mjs";
import { loadConfig } from "../src/config.js";
import { ModelProvider, chatCompletionsUrl, usageFromJson, usageFromSse } from "../src/provider.js";
import {
  ClientSecretCredential,
  ManagedIdentityCredential,
  ApiKeyCredential,
  createCredential,
} from "../src/azure-credential.js";

function azureCfg(provider = {}, extra = {}) {
  return loadConfig({
    provider: { type: "azure-foundry", endpoint: "https://res.openai.azure.com", ...provider },
    models: [{ id: "gpt-4.1-mini", deployment: "mini-prod" }, { id: "DeepSeek-R1" }],
    ...extra,
  });
}

/** fetch simulato che registra le chiamate. */
function recorder(respond = () => jsonResponse({ choices: [], usage: { total_tokens: 3 } })) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body && typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body });
    return respond(String(url), init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

// ---------- URL e corpo ----------

test("URL Azure v1: con o senza /openai/v1 finale, anche services.ai.azure.com", () => {
  const u = (endpoint) => chatCompletionsUrl({ type: "azure-foundry", endpoint });
  assert.equal(u("https://res.openai.azure.com"), "https://res.openai.azure.com/openai/v1/chat/completions");
  assert.equal(u("https://res.openai.azure.com/"), "https://res.openai.azure.com/openai/v1/chat/completions");
  assert.equal(u("https://res.openai.azure.com/openai/v1/"), "https://res.openai.azure.com/openai/v1/chat/completions");
  assert.equal(u("https://res.services.ai.azure.com"), "https://res.services.ai.azure.com/openai/v1/chat/completions");
});

test("endpoint non https rifiutato, salvo allowHttp esplicito (solo test)", () => {
  const env = { AZURE_FOUNDRY_API_KEY: "k" };
  assert.throws(() => new ModelProvider(azureCfg({ endpoint: "http://insicuro" }), { env }), /https/);
  assert.doesNotThrow(() => new ModelProvider(azureCfg({ endpoint: "http://127.0.0.1:1", allowHttp: true }), { env }));
});

test("Azure con chiave: header api-key, modello -> nome del deployment", async () => {
  const f = recorder();
  const p = new ModelProvider(azureCfg(), { fetchImpl: f, env: { AZURE_FOUNDRY_API_KEY: "az-key" } });
  await p.dispatch({ model: "gpt-4.1-mini", body: { messages: [{ role: "user", content: "x" }], temperature: 0.1 }, stream: false });
  const c = f.calls[0];
  assert.equal(c.url, "https://res.openai.azure.com/openai/v1/chat/completions");
  assert.equal(c.init.headers["api-key"], "az-key");
  assert.ok(!c.init.headers.Authorization);
  assert.equal(c.body.model, "mini-prod");
  assert.equal(c.body.temperature, 0.1);
  // Senza deployment esplicito si usa l'id.
  await p.dispatch({ model: "DeepSeek-R1", body: {}, stream: true });
  assert.equal(f.calls[1].body.model, "DeepSeek-R1");
  assert.deepEqual(f.calls[1].body.stream_options, { include_usage: true });
  assert.equal(f.calls[1].init.headers.Accept, "text/event-stream");
});

test("chiave mancante: errore chiaro alla creazione", () => {
  assert.throws(() => new ModelProvider(azureCfg(), { env: {} }), /chiave API mancante/);
});

test("openai-compatible: Authorization Bearer", async () => {
  const f = recorder();
  const p = new ModelProvider(baseConfig(), { fetchImpl: f });
  await p.dispatch({ model: "meta/llama", body: {}, stream: false });
  assert.equal(f.calls[0].init.headers.Authorization, "Bearer test-key");
});

// ---------- Entra ID ----------

test("Entra: client credentials, token in cache e riusato", async () => {
  let now = 1_000_000;
  const f = recorder((url) =>
    url.includes("/oauth2/v2.0/token") ? jsonResponse({ access_token: "tok-1", expires_in: 3600 }) : jsonResponse({})
  );
  const cred = new ClientSecretCredential({
    tenantId: "tenant", clientId: "cid", clientSecret: "secret", authorityHost: "https://login.example", fetchImpl: f, now: () => now,
  });
  assert.deepEqual(await cred.headers(), { Authorization: "Bearer tok-1" });
  await cred.headers();
  await cred.headers();
  assert.equal(f.calls.length, 1, "un solo token per più richieste");
  const c = f.calls[0];
  assert.equal(c.url, "https://login.example/tenant/oauth2/v2.0/token");
  const form = new URLSearchParams(c.init.body);
  assert.equal(form.get("grant_type"), "client_credentials");
  assert.equal(form.get("scope"), "https://ai.azure.com/.default");
  // A 4 minuti dalla scadenza (margine 5) si rinnova.
  now += (3600 - 240) * 1000;
  await cred.headers();
  assert.equal(f.calls.length, 2);
});

test("Entra: richieste concorrenti condividono un solo rinnovo", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const f = recorder(async () => {
    await gate;
    return jsonResponse({ access_token: "tok", expires_in: 3600 });
  });
  const cred = new ClientSecretCredential({ tenantId: "t", clientId: "c", clientSecret: "s", fetchImpl: f });
  const all = Promise.all(Array.from({ length: 20 }, () => cred.getToken()));
  release();
  assert.deepEqual(new Set(await all), new Set(["tok"]));
  assert.equal(f.calls.length, 1);
});

test("Entra: errore senza esporre il corpo della risposta", async () => {
  const f = recorder(() => jsonResponse({ error: "invalid_client", error_description: "SEGRETO nel messaggio" }, { status: 401 }));
  const cred = new ClientSecretCredential({ tenantId: "t", clientId: "c", clientSecret: "s", fetchImpl: f });
  await assert.rejects(cred.getToken(), (e) => /HTTP 401 \(invalid_client\)/.test(e.message) && !/SEGRETO/.test(e.message) && e.status === 502);
  // Dopo un errore si riprova (niente promessa fallita in cache).
  await assert.rejects(cred.getToken());
  assert.equal(f.calls.length, 2);
});

test("Entra: variabili mancanti -> errore chiaro", () => {
  assert.throws(() => createCredential({ auth: "entra" }, {}), /AZURE_TENANT_ID/);
});

// ---------- Managed Identity ----------

test("Managed Identity su Container Apps: IDENTITY_ENDPOINT + X-IDENTITY-HEADER", async () => {
  const f = recorder(() => jsonResponse({ access_token: "mi-tok", expires_on: String(Math.floor(Date.now() / 1000) + 3600) }));
  const cred = createCredential(
    { auth: "managed-identity", scope: "https://ai.azure.com/.default" },
    { IDENTITY_ENDPOINT: "http://localhost:42356/msi/token", IDENTITY_HEADER: "hdr", AZURE_CLIENT_ID: "uami" },
    { fetchImpl: f }
  );
  assert.deepEqual(await cred.headers(), { Authorization: "Bearer mi-tok" });
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, "http://localhost:42356/msi/token");
  assert.equal(u.searchParams.get("api-version"), "2019-08-01");
  assert.equal(u.searchParams.get("resource"), "https://ai.azure.com");
  assert.equal(u.searchParams.get("client_id"), "uami");
  assert.equal(f.calls[0].init.headers["X-IDENTITY-HEADER"], "hdr");
});

test("Managed Identity via IMDS (VM/AKS) quando non c'è IDENTITY_ENDPOINT", async () => {
  const f = recorder(() => jsonResponse({ access_token: "imds-tok", expires_in: "3600" }));
  const cred = new ManagedIdentityCredential({ fetchImpl: f });
  assert.equal(await cred.getToken(), "imds-tok");
  const u = new URL(f.calls[0].url);
  assert.equal(u.host, "169.254.169.254");
  assert.equal(u.searchParams.get("api-version"), "2018-02-01");
  assert.equal(f.calls[0].init.headers.Metadata, "true");
});

test("Provider Azure con Entra: il token arriva nell'header Authorization", async () => {
  const f = recorder((url) =>
    url.includes("oauth2") ? jsonResponse({ access_token: "e-tok", expires_in: 3600 }) : jsonResponse({ usage: { total_tokens: 1 } })
  );
  const p = new ModelProvider(azureCfg({ auth: "entra" }), {
    fetchImpl: f,
    env: { AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c", AZURE_CLIENT_SECRET: "s", AZURE_AUTHORITY_HOST: "https://login.example" },
  });
  await p.check();
  await p.dispatch({ model: "gpt-4.1-mini", body: {}, stream: false });
  await p.dispatch({ model: "gpt-4.1-mini", body: {}, stream: false });
  const chats = f.calls.filter((c) => c.url.includes("/chat/completions"));
  assert.equal(chats.length, 2);
  assert.ok(chats.every((c) => c.init.headers.Authorization === "Bearer e-tok"));
  assert.equal(f.calls.filter((c) => c.url.includes("oauth2")).length, 1);
});

test("ApiKeyCredential vuota rifiutata", () => {
  assert.throws(() => new ApiKeyCredential(""), /mancante/);
});

// ---------- Conteggio token ----------

test("usageFromJson", () => {
  assert.equal(usageFromJson({ usage: { total_tokens: 12 } }), 12);
  assert.equal(usageFromJson({ usage: { prompt_tokens: 3, completion_tokens: 4 } }), 7);
  assert.equal(usageFromJson({}), 0);
});

test("usageFromSse prende l'ultimo usage e ignora chunk rotti", () => {
  const sse = [
    'data: {"choices":[]}',
    "data: {rotto",
    'data: {"usage":{"total_tokens":4}}',
    'data: {"usage":{"total_tokens":11}}',
    "data: [DONE]",
  ].join("\n");
  assert.equal(usageFromSse(sse), 11);
});
