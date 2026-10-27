import { test } from "node:test";
import assert from "node:assert/strict";
import { baseConfig } from "./helpers.mjs";
import { ModelProvider, usageFromJson, usageFromSse } from "../src/provider.js";

test("baseUrl non https è rifiutato", () => {
  const cfg = baseConfig({ provider: { baseUrl: "http://insicuro" } });
  assert.throws(() => new ModelProvider(cfg), /https/);
});

test("utente senza token -> errore 401", async () => {
  const cfg = baseConfig();
  const p = new ModelProvider(cfg, { fetchImpl: async () => assert.fail("non deve chiamare") });
  await assert.rejects(
    p.dispatch({ user: { id: "x", groups: [] }, model: "m", body: {}, stream: false }),
    (e) => e.status === 401
  );
});

test("hook di refresh credenziali usato quando il token scade", async () => {
  const cfg = baseConfig();
  let refreshed = 0;
  let seenAuth;
  const p = new ModelProvider(cfg, {
    fetchImpl: async (_url, init) => {
      seenAuth = init.headers.Authorization;
      return new Response("{}");
    },
    getCredential: () => ({ token: "vecchio", expiresAt: Date.now() + 1000 }),
    refreshCredentials: async () => {
      refreshed += 1;
      return { token: "nuovo", expiresAt: Date.now() + 3_600_000 };
    },
  });
  await p.dispatch({ user: { id: "u" }, model: "m", body: {}, stream: false });
  assert.equal(refreshed, 1);
  assert.equal(seenAuth, "Bearer nuovo");
});

test("buildBody forza il modello risolto e preserva i parametri", () => {
  const p = new ModelProvider(baseConfig());
  const b = p.buildBody("risolto", { model: "auto", temperature: 0.2, messages: [1] }, true);
  assert.equal(b.model, "risolto");
  assert.equal(b.temperature, 0.2);
  assert.deepEqual(b.stream_options, { include_usage: true });
});

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
