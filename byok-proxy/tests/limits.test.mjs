import { test } from "node:test";
import assert from "node:assert/strict";
import { baseConfig, fakeClock } from "./helpers.mjs";
import { RateLimiter } from "../src/limits.js";

const M = "openai/gpt-4o-mini";
const BIG = "openai/gpt-4o";

function users(cfg) {
  return Object.fromEntries(cfg.users.map((u) => [u.id, u]));
}

test("rpm per utente: blocca oltre il limite e si resetta al minuto successivo", () => {
  const cfg = baseConfig({ rules: [{ id: "r", match: {}, limits: { rpm: 2 } }] });
  const { alice } = users(cfg);
  const clock = fakeClock(0);
  const lim = new RateLimiter(clock);

  assert.equal(lim.tryConsume(cfg, alice, M).ok, true);
  assert.equal(lim.tryConsume(cfg, alice, M).ok, true);
  const third = lim.tryConsume(cfg, alice, M);
  assert.equal(third.ok, false);
  assert.equal(third.status, 429);
  assert.equal(third.ruleId, "r");
  assert.equal(third.limit, "rpm");
  assert.equal(third.retryAfterSec, 60);

  clock.advance(60_000);
  assert.equal(lim.tryConsume(cfg, alice, M).ok, true);
});

test("countBy user: utenti diversi hanno contatori separati", () => {
  const cfg = baseConfig({ rules: [{ id: "r", match: {}, limits: { rpm: 1 } }] });
  const { alice, bob } = users(cfg);
  const lim = new RateLimiter(fakeClock());
  assert.equal(lim.tryConsume(cfg, alice, M).ok, true);
  assert.equal(lim.tryConsume(cfg, bob, M).ok, true);
  assert.equal(lim.tryConsume(cfg, alice, M).ok, false);
});

test("limite per gruppo si applica solo ai membri", () => {
  const cfg = baseConfig({ rules: [{ id: "junior", match: { groups: ["junior"] }, limits: { rpm: 1 } }] });
  const { alice, bob } = users(cfg);
  const lim = new RateLimiter(fakeClock());
  assert.equal(lim.tryConsume(cfg, bob, M).ok, true);
  assert.equal(lim.tryConsume(cfg, bob, M).ok, false);
  for (let i = 0; i < 10; i++) assert.equal(lim.tryConsume(cfg, alice, M).ok, true);
});

test("countBy group: il gruppo condivide un unico contatore", () => {
  const cfg = baseConfig({
    users: [
      { id: "b1", apiKey: "k1", groups: ["junior"] },
      { id: "b2", apiKey: "k2", groups: ["junior"] },
    ],
    rules: [{ id: "g", match: { groups: ["junior"] }, countBy: "group", limits: { rpm: 2 } }],
  });
  const { b1, b2 } = users(cfg);
  const lim = new RateLimiter(fakeClock());
  assert.equal(lim.tryConsume(cfg, b1, M).ok, true);
  assert.equal(lim.tryConsume(cfg, b2, M).ok, true);
  assert.equal(lim.tryConsume(cfg, b1, M).ok, false);
});

test("limite per modello: vale solo per quel modello", () => {
  const cfg = baseConfig({ rules: [{ id: "big", match: { models: [BIG] }, limits: { rpm: 1 } }] });
  const { alice } = users(cfg);
  const lim = new RateLimiter(fakeClock());
  assert.equal(lim.tryConsume(cfg, alice, BIG).ok, true);
  assert.equal(lim.tryConsume(cfg, alice, BIG).ok, false);
  assert.equal(lim.tryConsume(cfg, alice, M).ok, true);
});

test("limite per modello + gruppo specifico", () => {
  const cfg = baseConfig({
    rules: [{ id: "junior-big", match: { groups: ["junior"], models: [BIG] }, limits: { rpd: 1 } }],
  });
  const { alice, bob } = users(cfg);
  const lim = new RateLimiter(fakeClock());
  assert.equal(lim.tryConsume(cfg, bob, BIG).ok, true);
  assert.equal(lim.tryConsume(cfg, bob, BIG).ok, false);
  assert.equal(lim.tryConsume(cfg, bob, M).ok, true);
  assert.equal(lim.tryConsume(cfg, alice, BIG).ok, true);
  assert.equal(lim.tryConsume(cfg, alice, BIG).ok, true);
});

test("countBy model: contatore globale per modello condiviso tra utenti", () => {
  const cfg = baseConfig({ rules: [{ id: "shared", match: { models: [BIG] }, countBy: "model", limits: { rph: 2 } }] });
  const { alice, bob } = users(cfg);
  const lim = new RateLimiter(fakeClock());
  assert.equal(lim.tryConsume(cfg, alice, BIG).ok, true);
  assert.equal(lim.tryConsume(cfg, bob, BIG).ok, true);
  assert.equal(lim.tryConsume(cfg, alice, BIG).ok, false);
});

test("vince la regola più restrittiva", () => {
  const cfg = baseConfig({
    rules: [
      { id: "largo", match: {}, limits: { rpm: 100 } },
      { id: "stretto", match: { users: ["alice"] }, limits: { rpm: 1 } },
    ],
  });
  const { alice } = users(cfg);
  const lim = new RateLimiter(fakeClock());
  assert.equal(lim.tryConsume(cfg, alice, M).ok, true);
  const r = lim.tryConsume(cfg, alice, M);
  assert.equal(r.ok, false);
  assert.equal(r.ruleId, "stretto");
});

test("una richiesta bloccata non consuma quota delle altre regole", () => {
  const cfg = baseConfig({
    rules: [
      { id: "a", match: {}, limits: { rpm: 5 } },
      { id: "b", match: { users: ["alice"] }, limits: { rpm: 1 } },
    ],
  });
  const { alice } = users(cfg);
  const lim = new RateLimiter(fakeClock());
  lim.tryConsume(cfg, alice, M);
  lim.tryConsume(cfg, alice, M); // bloccata da "b"
  lim.tryConsume(cfg, alice, M); // bloccata da "b"
  const snap = lim.snapshot(cfg, alice, M).find((s) => s.rule === "a");
  assert.equal(snap.used, 1);
});

test("limite token: blocca quando la finestra è già satura", () => {
  const cfg = baseConfig({ rules: [{ id: "tok", match: {}, limits: { tokensPerMinute: 100 } }] });
  const { alice } = users(cfg);
  const clock = fakeClock(0);
  const lim = new RateLimiter(clock);
  assert.equal(lim.tryConsume(cfg, alice, M).ok, true);
  lim.addTokens(cfg, alice, M, 60);
  assert.equal(lim.tryConsume(cfg, alice, M).ok, true);
  lim.addTokens(cfg, alice, M, 50);
  const r = lim.tryConsume(cfg, alice, M);
  assert.equal(r.ok, false);
  assert.equal(r.limit, "tokensPerMinute");
  clock.advance(60_000);
  assert.equal(lim.tryConsume(cfg, alice, M).ok, true);
});

test("regola solo d'accesso non partecipa ai limiti", () => {
  const cfg = baseConfig({ rules: [{ id: "deny", match: { models: [BIG] }, access: "deny" }] });
  const { alice } = users(cfg);
  const lim = new RateLimiter(fakeClock());
  for (let i = 0; i < 100; i++) assert.equal(lim.tryConsume(cfg, alice, M).ok, true);
});
