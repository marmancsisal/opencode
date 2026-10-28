import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { UserStore, safeEqual, hashKey } from "../src/store.js";
import { openDb } from "../src/db.js";
import { readApiKey } from "../src/auth.js";
import { baseConfig, makeDeps } from "./helpers.mjs";

const P = { type: "openai-compatible", baseUrl: "https://x.test/chat/completions" };

test("config: chiavi di limite sconosciute sono rifiutate", () => {
  assert.throws(() => loadConfig({ rules: [{ limits: { rpx: 1 } }] }), /sconosciuta/);
});

test("config: countBy non valido è rifiutato", () => {
  assert.throws(() => loadConfig({ rules: [{ countBy: "team", limits: { rpm: 1 } }] }), /countBy/);
});

test("config: defaultModel deve stare nel catalogo", () => {
  assert.throws(() => loadConfig({ provider: P, models: ["a"], defaultModel: "b" }), /defaultModel/);
});

test("config: api key duplicate sono rifiutate", () => {
  assert.throws(
    () => loadConfig({ provider: P, users: [{ id: "a", apiKey: "x" }, { id: "b", apiKey: "x" }] }),
    /duplicata/
  );
});

test("config: Azure richiede l'endpoint e accetta solo modalità di auth note", () => {
  assert.throws(() => loadConfig({ provider: { type: "azure-foundry" } }), /endpoint/);
  assert.throws(() => loadConfig({ provider: { type: "azure-foundry", endpoint: "https://x", auth: "boh" } }), /auth/);
  assert.throws(() => loadConfig({ provider: { type: "altro" } }), /provider\.type/);
  const cfg = loadConfig({ provider: { type: "azure-foundry", endpoint: "https://r.openai.azure.com" } });
  assert.equal(cfg.provider.auth, "key");
  assert.equal(cfg.provider.apiKeyEnv, "AZURE_FOUNDRY_API_KEY");
  assert.equal(cfg.provider.scope, "https://ai.azure.com/.default");
});

test("config: endpoint, auth e HOST/PORT da variabili d'ambiente vincono sul file", () => {
  const keep = { ...process.env };
  Object.assign(process.env, { AZURE_FOUNDRY_ENDPOINT: "https://env.openai.azure.com", AZURE_AUTH: "entra", HOST: "0.0.0.0", PORT: "9999" });
  try {
    const cfg = loadConfig({ provider: { type: "azure-foundry", endpoint: "https://file" }, server: { host: "127.0.0.1", port: 1 } });
    assert.equal(cfg.provider.endpoint, "https://env.openai.azure.com");
    assert.equal(cfg.provider.auth, "entra");
    assert.deepEqual(cfg.server, { host: "0.0.0.0", port: 9999 });
  } finally {
    for (const k of ["AZURE_FOUNDRY_ENDPOINT", "AZURE_AUTH", "HOST", "PORT"]) {
      if (k in keep) process.env[k] = keep[k];
      else delete process.env[k];
    }
  }
});

test("config: modello con deployment Azure, default = id", () => {
  const cfg = baseConfig({ models: ["a", { id: "b", deployment: "b-prod" }], defaultModel: "a" });
  assert.deepEqual(cfg.models.map((m) => m.deployment), ["a", "b-prod"]);
  assert.throws(() => baseConfig({ models: [{ id: "c", deployment: "" }], defaultModel: null }), /deployment/);
});

test("store: risolve utenti statici per api key", () => {
  const store = new UserStore(baseConfig());
  assert.equal(store.resolveByApiKey("k-alice").id, "alice");
  assert.equal(store.resolveByApiKey("k-bob").id, "bob");
  assert.equal(store.resolveByApiKey("sbagliata"), null);
  assert.equal(store.resolveByApiKey(null), null);
});

test("store: le api key non sono mai salvate in chiaro", () => {
  const db = openDb(":memory:");
  const store = new UserStore(baseConfig(), { db });
  const { apiKey } = store.upsertDeviceUser({ githubId: 42, login: "carol" });
  const dump = JSON.stringify(db.prepare("SELECT * FROM users").all());
  assert.ok(!dump.includes("k-alice"));
  assert.ok(!dump.includes(apiKey));
  assert.ok(dump.includes(hashKey(apiKey)));
});

test("store: device user persistito nel DB, re-login ruota l'api key", () => {
  const path = join(mkdtempSync(join(tmpdir(), "byok-")), "proxy.db");
  const db = openDb(path);
  const store = new UserStore(baseConfig(), { db });
  const first = store.upsertDeviceUser({ githubId: 42, login: "carol", groups: ["standard"] });
  assert.match(first.apiKey, /^byok_[0-9a-f]{48}$/);
  store.setGroups(first.user.id, ["senior"]);

  const again = store.upsertDeviceUser({ githubId: 42, login: "carol-new", groups: ["standard"] });
  assert.notEqual(again.apiKey, first.apiKey);
  assert.equal(store.resolveByApiKey(first.apiKey), null, "la chiave vecchia non vale più");
  assert.equal(store.resolveByApiKey(again.apiKey).login, "carol-new", "login aggiornato, stesso cliente");
  assert.equal(store.resolveByApiKey(again.apiKey).id, first.user.id);
  // I gruppi impostati dall'admin non vengono sovrascritti dal re-login.
  assert.deepEqual(store.resolveByApiKey(again.apiKey).groups, ["senior"]);
  db.close();

  const reloaded = new UserStore(baseConfig(), { db: openDb(path) });
  assert.equal(reloaded.resolveByApiKey(again.apiKey).login, "carol-new");
});

test("store: un login GitHub uguale a un id da config non collide", () => {
  const store = new UserStore(baseConfig());
  const { user } = store.upsertDeviceUser({ githubId: 9, login: "alice" });
  assert.notEqual(user.id, "alice");
  assert.equal(store.findById("alice").source, "config");
});

test("store: utenti rimossi dalla config non entrano più; modifiche admin persistono", () => {
  const db = openDb(":memory:");
  const s1 = new UserStore(baseConfig(), { db });
  s1.setEnabled("alice", false);
  const s2 = new UserStore(baseConfig({ users: [{ id: "alice", apiKey: "k-alice", groups: ["standard"] }] }), { db });
  assert.equal(s2.resolveByApiKey("k-bob"), null);
  // La voce di alice in config non è cambiata (login, api key, gruppi, enabled
  // uguali): resta disattivata come deciso dall'admin.
  assert.equal(s2.findById("alice").enabled, false);
  // Cambiando la voce in config, la config torna a comandare.
  const s3 = new UserStore(baseConfig({ users: [{ id: "alice", apiKey: "k-alice2", groups: ["standard"] }] }), { db });
  assert.equal(s3.findById("alice").enabled, true);
  assert.equal(s3.resolveByApiKey("k-alice"), null);
  assert.equal(s3.resolveByApiKey("k-alice2").id, "alice");
});

test("store: importa una volta il vecchio users.json mantenendo valide le chiavi", () => {
  const dir = mkdtempSync(join(tmpdir(), "byok-legacy-"));
  const legacy = join(dir, "users.json");
  writeFileSync(legacy, JSON.stringify({ users: [{ apiKey: "byok_old", login: "dave", githubId: 5, groups: ["g"] }] }));
  const db = openDb(":memory:");
  const store = new UserStore(baseConfig(), { db, legacyJsonPath: legacy });
  assert.equal(store.resolveByApiKey("byok_old").login, "dave");
  // Seconda apertura: nessun doppione.
  new UserStore(baseConfig(), { db, legacyJsonPath: legacy });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE login = 'dave'").get().n, 1);
});

test("store: queryClients pagina, filtra, ordina per utilizzo", async () => {
  const users = Array.from({ length: 30 }, (_, i) => ({
    id: `u${String(i).padStart(2, "0")}`, apiKey: `key-${i}`, groups: [i % 2 ? "odd" : "even"],
  }));
  const { store, metrics } = makeDeps(baseConfig({ users }));
  for (let i = 0; i < 30; i++) for (let j = 0; j < i; j++) metrics.record({ userId: users[i].id, model: "m", outcome: "allowed", tokens: 1 });
  metrics.flush();

  const p1 = await store.queryClients({ limit: 10, sort: "requests", dir: "desc" });
  assert.equal(p1.total, 30);
  assert.equal(p1.rows.length, 10);
  assert.equal(p1.rows[0].user.id, "u29");
  assert.equal(p1.rows[0].usage.requests, 29);
  const p3 = await store.queryClients({ limit: 10, offset: 20, sort: "requests", dir: "desc" });
  assert.equal(p3.rows.at(-1).user.id, "u00");

  assert.equal((await store.queryClients({ q: "odd" })).total, 15);
  assert.equal((await store.queryClients({ q: "u1" })).total, 10);
  store.setEnabled("u05", false);
  assert.equal((await store.queryClients({ status: "disabled" })).rows[0].user.id, "u05");
  const byLogin = await store.queryClients({ sort: "login", dir: "asc", limit: 2 });
  assert.deepEqual(byLogin.rows.map((r) => r.user.id), ["u00", "u01"]);
  assert.equal(store.counts().total, 30);
  assert.deepEqual(store.allGroups(), ["even", "odd"]);
});

test("safeEqual", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
});

test("readApiKey: Bearer, x-api-key, api-key", () => {
  assert.equal(readApiKey({ authorization: "Bearer xyz" }), "xyz");
  assert.equal(readApiKey({ authorization: "bearer   xyz " }), "xyz");
  assert.equal(readApiKey({ "x-api-key": "k1" }), "k1");
  assert.equal(readApiKey({ "api-key": "k2" }), "k2");
  assert.equal(readApiKey({}), null);
});
