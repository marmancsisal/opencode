// Utility condivise dai test.
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { UserStore } from "../src/store.js";
import { MetricsStore } from "../src/metrics.js";

/** Store e metriche sullo stesso DB in memoria, senza timer. */
export function makeDeps(cfg, { now } = {}) {
  const db = openDb(":memory:");
  const store = new UserStore(cfg, { db, ...(now ? { now } : {}) });
  const metrics = new MetricsStore({ db, flushIntervalMs: 0, ...(now ? { now } : {}) });
  return { db, store, metrics };
}

export function baseConfig(overrides = {}) {
  return loadConfig({
    provider: { baseUrl: "https://example.test/chat/completions" },
    models: [
      { id: "openai/gpt-4o-mini" },
      { id: "openai/gpt-4o" },
      { id: "meta/llama" },
    ],
    defaultModel: "openai/gpt-4o-mini",
    users: [
      { id: "alice", apiKey: "k-alice", groups: ["standard"], githubToken: "gh-alice" },
      { id: "bob", apiKey: "k-bob", groups: ["junior"], githubToken: "gh-bob" },
    ],
    ...overrides,
  });
}

/** Sorgente temporale controllabile per i test dei limiti. */
export function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => {
    t += ms;
  };
  return now;
}

/** Una Response web non-streaming finta. */
export function jsonResponse(obj, { status = 200 } = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Una Response web di tipo SSE a partire da righe `data:`. */
export function sseResponse(chunks, { status = 200 } = {}) {
  const body = chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}
