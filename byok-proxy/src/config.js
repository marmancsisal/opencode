// Caricamento e validazione della configurazione.
//
// La config descrive: utenti, gruppi, catalogo modelli e regole di limite.
// Può arrivare da un file JSON (CONFIG_PATH) o essere passata come oggetto nei
// test. I token GitHub degli utenti non vanno scritti in chiaro nel file: si
// usa `githubTokenEnv` (nome di una variabile d'ambiente) oppure vengono
// popolati a runtime dal device flow (vedi store.js).

import { readFileSync } from "node:fs";

/** Finestre temporali supportate dai limiti, in millisecondi. */
export const WINDOWS = Object.freeze({
  rpm: 60_000,
  rph: 3_600_000,
  rpd: 86_400_000,
  tokensPerMinute: 60_000,
  tokensPerHour: 3_600_000,
  tokensPerDay: 86_400_000,
});

/** Limiti che contano richieste. */
export const REQUEST_LIMITS = Object.freeze(["rpm", "rph", "rpd"]);
/** Limiti che contano token. */
export const TOKEN_LIMITS = Object.freeze(["tokensPerMinute", "tokensPerHour", "tokensPerDay"]);

/** Granularità del contatore di una regola. */
export const COUNT_BY = Object.freeze(["user", "group", "model", "user+model", "global"]);

function fail(msg) {
  throw new Error(`Config non valida: ${msg}`);
}

function asArray(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) fail(`atteso un array, trovato ${typeof v}`);
  return v;
}

function normalizeUser(raw, index) {
  if (!raw || typeof raw !== "object") fail(`users[${index}] non è un oggetto`);
  const id = raw.id ?? raw.login;
  if (!id || typeof id !== "string") fail(`users[${index}].id mancante`);
  const apiKey = raw.apiKey;
  if (apiKey != null && typeof apiKey !== "string") fail(`users[${index}].apiKey deve essere stringa`);
  const groups = asArray(raw.groups).map(String);
  // Il token GitHub può essere: indiretto (nome di env var) o diretto (sconsigliato).
  let githubToken = null;
  if (raw.githubTokenEnv) {
    githubToken = process.env[raw.githubTokenEnv] ?? null;
  } else if (raw.githubToken) {
    githubToken = String(raw.githubToken);
  }
  return {
    id,
    login: raw.login ?? id,
    apiKey: apiKey ?? null,
    groups,
    githubToken,
    source: "config",
  };
}

function normalizeModel(raw, index) {
  if (typeof raw === "string") return { id: raw, name: raw };
  if (!raw || typeof raw !== "object") fail(`models[${index}] non valido`);
  if (!raw.id || typeof raw.id !== "string") fail(`models[${index}].id mancante`);
  return { id: raw.id, name: raw.name ?? raw.id };
}

function normalizeRule(raw, index) {
  if (!raw || typeof raw !== "object") fail(`rules[${index}] non è un oggetto`);
  const id = raw.id ?? `rule-${index}`;
  const match = raw.match ?? {};
  const rule = {
    id: String(id),
    match: {
      users: asArray(match.users).map(String),
      groups: asArray(match.groups).map(String),
      models: asArray(match.models).map(String),
    },
    countBy: raw.countBy ?? "user",
    limits: {},
    access: raw.access ?? null, // "allow" (whitelist) | "deny" | null
  };
  if (!COUNT_BY.includes(rule.countBy)) {
    fail(`rules[${index}].countBy="${rule.countBy}" non valido (usa ${COUNT_BY.join(", ")})`);
  }
  if (rule.access != null && rule.access !== "allow" && rule.access !== "deny") {
    fail(`rules[${index}].access deve essere "allow", "deny" o assente`);
  }
  const limits = raw.limits ?? {};
  for (const [k, v] of Object.entries(limits)) {
    if (!(k in WINDOWS)) fail(`rules[${index}].limits: chiave "${k}" sconosciuta`);
    if (!Number.isFinite(v) || v < 0) fail(`rules[${index}].limits.${k} deve essere un numero >= 0`);
    rule.limits[k] = v;
  }
  return rule;
}

/**
 * Normalizza un oggetto config grezzo in una forma validata e con default.
 */
export function loadConfig(raw) {
  if (!raw || typeof raw !== "object") fail("root non è un oggetto");

  const users = asArray(raw.users).map(normalizeUser);
  const models = asArray(raw.models).map(normalizeModel);
  const rules = asArray(raw.rules).map(normalizeRule);

  // Default modello scelto quando l'utente non ne specifica uno (o chiede "auto"/"random").
  const defaultModel = raw.defaultModel ?? null;

  const provider = {
    name: raw.provider?.name ?? "github-models",
    baseUrl: raw.provider?.baseUrl ?? "https://models.github.ai/inference/chat/completions",
    timeoutMs: raw.provider?.timeoutMs ?? 120_000,
  };

  const server = {
    host: raw.server?.host ?? process.env.HOST ?? "127.0.0.1",
    port: raw.server?.port ?? Number(process.env.PORT ?? 8787),
  };

  const oauth = {
    clientId: raw.oauth?.clientId ?? process.env.GITHUB_OAUTH_CLIENT_ID ?? null,
    scopes: raw.oauth?.scopes ?? "read:user",
    deviceCodeUrl: raw.oauth?.deviceCodeUrl ?? "https://github.com/login/device/code",
    tokenUrl: raw.oauth?.tokenUrl ?? "https://github.com/login/oauth/access_token",
    userInfoUrl: raw.oauth?.userInfoUrl ?? "https://api.github.com/user",
    // Gruppi assegnati di default agli utenti che si registrano via device flow.
    defaultGroups: asArray(raw.oauth?.defaultGroups).map(String),
  };

  const cfg = { users, models, rules, defaultModel, provider, server, oauth };
  validateCrossRefs(cfg);
  return cfg;
}

function validateCrossRefs(cfg) {
  const modelIds = new Set(cfg.models.map((m) => m.id));
  if (cfg.defaultModel && !modelIds.has(cfg.defaultModel)) {
    fail(`defaultModel="${cfg.defaultModel}" non è nel catalogo models`);
  }
  // Le api key statiche devono essere uniche.
  const seen = new Set();
  for (const u of cfg.users) {
    if (!u.apiKey) continue;
    if (seen.has(u.apiKey)) fail(`apiKey duplicata per più utenti (es. ${u.id})`);
    seen.add(u.apiKey);
  }
}

/** Carica la config da file JSON. */
export function loadConfigFromFile(path) {
  const text = readFileSync(path, "utf8");
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Config JSON non parsabile (${path}): ${e.message}`);
  }
  return loadConfig(raw);
}
