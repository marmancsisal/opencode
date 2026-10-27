// Totali per cliente su un periodo: calcolati fuori dal thread principale e
// tenuti in cache.
//
// Lista clienti, classifica e conteggio dei clienti attivi usano lo stesso
// aggregato (usage_user_day raggruppato per cliente dal giorno X). Con migliaia
// di clienti costa da decine a centinaia di ms, quindi:
//  - con un DB su file lo calcola un worker thread con una sua connessione in
//    sola lettura (usage-worker.js): il thread principale, che serve le chat,
//    non si blocca mai;
//  - il risultato resta valido `ttlMs`; quando scade si restituisce subito il
//    valore precedente e lo si ricalcola in background (stale-while-revalidate).
// Con un DB in memoria (test) il calcolo avviene in linea.

import { Worker } from "node:worker_threads";
import { dbPath } from "./db.js";

export const DEFAULT_USAGE_TTL_MS = 5000;

const SQL = `SELECT user_id, SUM(requests) AS requests, SUM(allowed) AS allowed, SUM(blocked) AS blocked,
  SUM(errors) AS errors, SUM(tokens) AS tokens, MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts
  FROM usage_user_day WHERE day >= ? GROUP BY user_id`;

const caches = new WeakMap(); // db -> Map(sinceDay -> { at, map, refreshing })
const workers = new Map(); // path -> { worker, pending, seq }

function getWorker(path) {
  let w = workers.get(path);
  if (w) return w;
  const worker = new Worker(new URL("./usage-worker.js", import.meta.url), { workerData: { path } });
  w = { worker, pending: new Map(), seq: 0 };
  worker.on("message", ({ id, rows, error }) => {
    const p = w.pending.get(id);
    if (!p) return;
    w.pending.delete(id);
    if (w.pending.size === 0) worker.unref();
    if (error) p.reject(new Error(error));
    else p.resolve(rows);
  });
  const fail = (err) => {
    for (const p of w.pending.values()) p.reject(err);
    w.pending.clear();
    if (workers.get(path) === w) workers.delete(path); // al prossimo uso se ne crea uno nuovo
  };
  worker.on("error", fail);
  worker.on("exit", (code) => code !== 0 && fail(new Error(`usage worker terminato (${code})`)));
  // Il worker tiene vivo il processo solo mentre ha richieste in corso
  // (vedi queryInWorker). Dopo i listener: aggiungerne uno lo riattiverebbe.
  worker.unref();
  workers.set(path, w);
  return w;
}

function queryInWorker(path, sinceDay) {
  const w = getWorker(path);
  const id = ++w.seq;
  return new Promise((resolve, reject) => {
    if (w.pending.size === 0) w.worker.ref();
    w.pending.set(id, { resolve, reject });
    w.worker.postMessage({ id, sinceDay });
  });
}

function toMap(rows) {
  const map = new Map();
  for (const r of rows) {
    map.set(r.user_id, {
      requests: r.requests,
      allowed: r.allowed,
      blocked: r.blocked,
      errors: r.errors,
      tokens: r.tokens,
      firstSeen: r.first_ts ?? null,
      lastSeen: r.last_ts ?? null,
    });
  }
  return map;
}

async function compute(db, sinceDay) {
  const path = dbPath(db);
  const rows = path ? await queryInWorker(path, sinceDay) : db.prepare(SQL).all(sinceDay);
  return toMap(rows);
}

/**
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string} sinceDay "YYYY-MM-DD" incluso
 * @param {number} [ttlMs]
 * @returns {Promise<Map<string, {requests:number, allowed:number, blocked:number, errors:number, tokens:number, firstSeen:number|null, lastSeen:number|null}>>}
 */
export async function usageByUser(db, sinceDay, ttlMs = DEFAULT_USAGE_TTL_MS) {
  let perDb = caches.get(db);
  if (!perDb) {
    perDb = new Map();
    caches.set(db, perDb);
  }
  let entry = perDb.get(sinceDay);
  const fresh = entry?.map && Date.now() - entry.at < ttlMs;
  if (fresh) return entry.map;

  if (!entry) {
    entry = { at: 0, map: null, refreshing: null };
    perDb.set(sinceDay, entry);
    // Tieni pochi periodi (7/30/90/365 + qualche altro): niente crescita illimitata.
    if (perDb.size > 8) perDb.delete(perDb.keys().next().value);
  }
  if (!entry.refreshing) {
    entry.refreshing = compute(db, sinceDay)
      .then((map) => {
        entry.map = map;
        entry.at = Date.now();
        return map;
      })
      .finally(() => {
        entry.refreshing = null;
      });
  }
  // Valore precedente subito, se c'è; altrimenti si attende il primo calcolo.
  return entry.map ?? entry.refreshing;
}

/** Svuota la cache (test, o dopo operazioni che cambiano lo storico). */
export function clearUsageCache(db) {
  caches.delete(db);
}

/** Ferma i worker (spegnimento, fine benchmark). */
export async function closeUsageWorkers() {
  const all = [...workers.values()];
  workers.clear();
  await Promise.all(all.map((w) => w.worker.terminate()));
}
