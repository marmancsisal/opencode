import { test } from "node:test";
import assert from "node:assert/strict";
import { baseConfig } from "./helpers.mjs";
import {
  resolveModel,
  allowedModelsForUser,
  isRandomRequest,
  _internal,
} from "../src/models.js";

test("isRandomRequest riconosce auto/random/vuoto", () => {
  for (const v of ["auto", "AUTO", "random", "", null, undefined]) {
    assert.equal(isRandomRequest(v), true, `${v}`);
  }
  assert.equal(isRandomRequest("openai/gpt-4o"), false);
});

test("secureRandomInt resta nel range e copre i valori", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const n = _internal.secureRandomInt(3);
    assert.ok(n >= 0 && n < 3);
    seen.add(n);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2]);
});

test("catalogo intero senza regole d'accesso", () => {
  const cfg = baseConfig();
  const alice = cfg.users.find((u) => u.id === "alice");
  assert.deepEqual(allowedModelsForUser(cfg, alice).sort(), [
    "meta/llama",
    "openai/gpt-4o",
    "openai/gpt-4o-mini",
  ]);
});

test("deny per gruppo rimuove un modello", () => {
  const cfg = baseConfig({
    rules: [{ id: "no-4o-junior", match: { groups: ["junior"], models: ["openai/gpt-4o"] }, access: "deny" }],
  });
  const bob = cfg.users.find((u) => u.id === "bob");
  const alice = cfg.users.find((u) => u.id === "alice");
  assert.ok(!allowedModelsForUser(cfg, bob).includes("openai/gpt-4o"));
  assert.ok(allowedModelsForUser(cfg, alice).includes("openai/gpt-4o"));
});

test("allow come whitelist per utente specifico", () => {
  const cfg = baseConfig({
    rules: [{ id: "alice-solo-mini", match: { users: ["alice"], models: ["openai/gpt-4o-mini"] }, access: "allow" }],
  });
  const alice = cfg.users.find((u) => u.id === "alice");
  const bob = cfg.users.find((u) => u.id === "bob");
  assert.deepEqual(allowedModelsForUser(cfg, alice), ["openai/gpt-4o-mini"]);
  // Bob non è toccato dalla whitelist di alice.
  assert.equal(allowedModelsForUser(cfg, bob).length, 3);
});

test("resolveModel: random sceglie tra i soli consentiti", () => {
  const cfg = baseConfig({
    rules: [{ id: "alice-solo-mini", match: { users: ["alice"], models: ["openai/gpt-4o-mini"] }, access: "allow" }],
  });
  const alice = cfg.users.find((u) => u.id === "alice");
  for (let i = 0; i < 50; i++) {
    const r = resolveModel(cfg, alice, "auto");
    assert.equal(r.ok, true);
    assert.equal(r.model, "openai/gpt-4o-mini");
    assert.equal(r.random, true);
  }
});

test("resolveModel: modello non consentito -> 403", () => {
  const cfg = baseConfig({
    rules: [{ id: "no-4o-junior", match: { groups: ["junior"], models: ["openai/gpt-4o"] }, access: "deny" }],
  });
  const bob = cfg.users.find((u) => u.id === "bob");
  const r = resolveModel(cfg, bob, "openai/gpt-4o");
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("resolveModel: modello valido richiesto esplicitamente", () => {
  const cfg = baseConfig();
  const alice = cfg.users.find((u) => u.id === "alice");
  const r = resolveModel(cfg, alice, "meta/llama");
  assert.deepEqual(r, { ok: true, model: "meta/llama", random: false });
});
