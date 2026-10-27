import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { UserStore, safeEqual } from "../src/store.js";
import { readApiKey } from "../src/auth.js";
import { baseConfig } from "./helpers.mjs";

test("config: chiavi di limite sconosciute sono rifiutate", () => {
  assert.throws(() => loadConfig({ rules: [{ limits: { rpx: 1 } }] }), /sconosciuta/);
});

test("config: countBy non valido è rifiutato", () => {
  assert.throws(() => loadConfig({ rules: [{ countBy: "team", limits: { rpm: 1 } }] }), /countBy/);
});

test("config: defaultModel deve stare nel catalogo", () => {
  assert.throws(() => loadConfig({ models: ["a"], defaultModel: "b" }), /defaultModel/);
});

test("config: api key duplicate sono rifiutate", () => {
  assert.throws(
    () => loadConfig({ users: [{ id: "a", apiKey: "x" }, { id: "b", apiKey: "x" }] }),
    /duplicata/
  );
});

test("config: token GitHub letto da variabile d'ambiente", () => {
  process.env.TEST_GH_TOKEN = "gh-from-env";
  const cfg = loadConfig({ users: [{ id: "a", apiKey: "k", githubTokenEnv: "TEST_GH_TOKEN" }] });
  assert.equal(cfg.users[0].githubToken, "gh-from-env");
  delete process.env.TEST_GH_TOKEN;
});

test("store: risolve utenti statici per api key", () => {
  const store = new UserStore(baseConfig());
  assert.equal(store.resolveByApiKey("k-alice").id, "alice");
  assert.equal(store.resolveByApiKey("k-bob").id, "bob");
  assert.equal(store.resolveByApiKey("sbagliata"), null);
  assert.equal(store.resolveByApiKey(null), null);
});

test("store: device user persistito e api key riusata al re-login", () => {
  const dir = mkdtempSync(join(tmpdir(), "byok-"));
  const path = join(dir, "users.json");
  const store = new UserStore(baseConfig(), { path });
  const first = store.upsertDeviceUser({ githubId: 42, login: "carol", githubToken: "t1", groups: ["standard"] });
  assert.match(first.apiKey, /^byok_[0-9a-f]{48}$/);
  const again = store.upsertDeviceUser({ githubId: 42, login: "carol", githubToken: "t2" });
  assert.equal(again.apiKey, first.apiKey);
  assert.equal(store.resolveByApiKey(first.apiKey).githubToken, "t2");

  const reloaded = new UserStore(baseConfig(), { path });
  assert.equal(reloaded.resolveByApiKey(first.apiKey).login, "carol");
  assert.ok(readFileSync(path, "utf8").includes("carol"));
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
