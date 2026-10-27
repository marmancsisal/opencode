// Worker thread per gli aggregati pesanti della dashboard.
//
// Apre una propria connessione SQLite in sola lettura sullo stesso file: in
// modalità WAL legge in parallelo alle scritture del processo principale, che
// così non resta mai bloccato da una query della dashboard.

import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(workerData.path);
db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -16000;");
const usageByUser = db.prepare(`SELECT user_id, SUM(requests) AS requests, SUM(allowed) AS allowed,
  SUM(blocked) AS blocked, SUM(errors) AS errors, SUM(tokens) AS tokens,
  MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts
  FROM usage_user_day WHERE day >= ? GROUP BY user_id`);

parentPort.on("message", ({ id, sinceDay }) => {
  try {
    parentPort.postMessage({ id, rows: usageByUser.all(sinceDay) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
