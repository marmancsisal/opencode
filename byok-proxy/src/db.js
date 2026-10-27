// Database SQLite (modulo node:sqlite integrato, nessuna dipendenza).
//
// Tabelle:
//  - users            clienti (config + registrati via login). Le api key sono
//                     salvate solo come hash SHA-256 + un hint mascherato.
//  - events           log di ogni richiesta di chat (anche bloccate/errori).
//  - usage_day        totali per giorno                (grafici, KPI)
//  - usage_user_day   totali per giorno x cliente      (lista clienti, classifiche)
//  - usage_model_day  totali per giorno x modello      (utilizzo per modello)
//  - usage_daily      totali per giorno x cliente x modello (dettaglio cliente)
// I riepiloghi si aggiornano a ogni flush nella stessa transazione degli eventi:
// le letture della dashboard non toccano mai `events` se non per il log paginato,
// quindi restano veloci anche con milioni di richieste.
//
// WAL + synchronous=NORMAL: letture concorrenti alle scritture e fsync ridotti,
// le scritture arrivano a lotti in una transazione (vedi metrics.js).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS = [
  // v1
  `
  CREATE TABLE users (
    id               TEXT PRIMARY KEY,
    login            TEXT NOT NULL,
    source           TEXT NOT NULL CHECK (source IN ('config','device')),
    github_id        TEXT UNIQUE,
    api_key_hash     TEXT UNIQUE,
    api_key_hint     TEXT,
    groups           TEXT NOT NULL DEFAULT '[]',
    enabled          INTEGER NOT NULL DEFAULT 1,
    github_token     TEXT,
    has_github_token INTEGER NOT NULL DEFAULT 0,
    config_hash      TEXT,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  CREATE INDEX users_login ON users(login COLLATE NOCASE);

  CREATE TABLE events (
    id         INTEGER PRIMARY KEY,
    ts         INTEGER NOT NULL,
    user_id    TEXT NOT NULL,
    model      TEXT NOT NULL,
    outcome    TEXT NOT NULL,
    status     INTEGER,
    tokens     INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    reason     TEXT,
    stream     INTEGER NOT NULL DEFAULT 0
  );
  -- ts: retention (inserimenti quasi sempre in ordine, quindi in coda all'indice).
  -- (x, id): filtri del log, che è ordinato per id decrescente.
  CREATE INDEX events_ts ON events(ts);
  CREATE INDEX events_user_id ON events(user_id, id);
  CREATE INDEX events_model_id ON events(model, id);
  CREATE INDEX events_outcome_id ON events(outcome, id);

  -- Riepiloghi a granularità crescente: ogni query legge il più piccolo che le basta.
  CREATE TABLE usage_day (
    day         TEXT PRIMARY KEY,
    requests    INTEGER NOT NULL DEFAULT 0,
    allowed     INTEGER NOT NULL DEFAULT 0,
    blocked     INTEGER NOT NULL DEFAULT 0,
    errors      INTEGER NOT NULL DEFAULT 0,
    tokens      INTEGER NOT NULL DEFAULT 0,
    latency_sum INTEGER NOT NULL DEFAULT 0,
    latency_n   INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;

  CREATE TABLE usage_user_day (
    day         TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    requests    INTEGER NOT NULL DEFAULT 0,
    allowed     INTEGER NOT NULL DEFAULT 0,
    blocked     INTEGER NOT NULL DEFAULT 0,
    errors      INTEGER NOT NULL DEFAULT 0,
    tokens      INTEGER NOT NULL DEFAULT 0,
    latency_sum INTEGER NOT NULL DEFAULT 0,
    latency_n   INTEGER NOT NULL DEFAULT 0,
    first_ts    INTEGER,
    last_ts     INTEGER,
    PRIMARY KEY (day, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX usage_user_day_user ON usage_user_day(user_id, day);

  CREATE TABLE usage_model_day (
    day         TEXT NOT NULL,
    model       TEXT NOT NULL,
    requests    INTEGER NOT NULL DEFAULT 0,
    allowed     INTEGER NOT NULL DEFAULT 0,
    blocked     INTEGER NOT NULL DEFAULT 0,
    errors      INTEGER NOT NULL DEFAULT 0,
    tokens      INTEGER NOT NULL DEFAULT 0,
    latency_sum INTEGER NOT NULL DEFAULT 0,
    latency_n   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, model)
  ) WITHOUT ROWID;

  CREATE TABLE usage_daily (
    day         TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    model       TEXT NOT NULL,
    requests    INTEGER NOT NULL DEFAULT 0,
    allowed     INTEGER NOT NULL DEFAULT 0,
    blocked     INTEGER NOT NULL DEFAULT 0,
    errors      INTEGER NOT NULL DEFAULT 0,
    tokens      INTEGER NOT NULL DEFAULT 0,
    latency_sum INTEGER NOT NULL DEFAULT 0,
    latency_n   INTEGER NOT NULL DEFAULT 0,
    first_ts    INTEGER,
    last_ts     INTEGER,
    PRIMARY KEY (day, user_id, model)
  ) WITHOUT ROWID;
  CREATE INDEX usage_daily_user ON usage_daily(user_id, day);

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
  `,
];

const paths = new WeakMap(); // db -> percorso file (assente per ":memory:")

/** Percorso del file del DB, o null se in memoria. */
export function dbPath(db) {
  return paths.get(db) ?? null;
}

/**
 * Apre (o crea) il database e applica le migrazioni mancanti.
 * @param {string} path percorso file, oppure ":memory:" (test)
 */
export function openDb(path = ":memory:") {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") paths.set(db, path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA cache_size = -16000;
    PRAGMA foreign_keys = ON;
  `);
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migrazione DB v${v + 1} fallita: ${e.message}`);
    }
  }
}

/** Esegue fn dentro una transazione (BEGIN IMMEDIATE), con rollback su errore. */
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Giorno UTC "YYYY-MM-DD" di un timestamp in ms. */
export function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}
