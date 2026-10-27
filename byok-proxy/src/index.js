#!/usr/bin/env node
// Entry point: carica la config, apre il DB, costruisce i componenti e avvia il server.

import { loadConfigFromFile } from "./config.js";
import { openDb } from "./db.js";
import { UserStore } from "./store.js";
import { RateLimiter } from "./limits.js";
import { ModelProvider } from "./provider.js";
import { DeviceFlow } from "./auth.js";
import { MetricsStore } from "./metrics.js";
import { createApp, startServer } from "./server.js";
import { closeUsageWorkers } from "./usage-cache.js";

const SWEEP_EVERY_MS = 10 * 60 * 1000;

async function main() {
  const configPath = process.env.CONFIG_PATH || "config.json";
  const cfg = loadConfigFromFile(configPath);

  const dbPath = process.env.DB_PATH || "./data/proxy.db";
  const db = openDb(dbPath);
  const store = new UserStore(cfg, {
    db,
    // Vecchio file utenti (versioni precedenti): importato una sola volta.
    legacyJsonPath: process.env.USERS_DB || "./data/users.json",
  });
  const metrics = new MetricsStore({
    db,
    retentionDays: Number(process.env.EVENTS_RETENTION_DAYS) || 90,
    rollupRetentionDays: Number(process.env.ROLLUP_RETENTION_DAYS) || 400,
  });
  const limiter = new RateLimiter();
  const provider = new ModelProvider(cfg);
  const deviceFlow = new DeviceFlow(cfg.oauth);

  const sweep = setInterval(() => limiter.sweep(), SWEEP_EVERY_MS);
  sweep.unref();

  const app = createApp({ cfg, store, limiter, provider, deviceFlow, metrics });
  const server = await startServer(app, cfg.server);
  const addr = server.address();
  console.log(`[byok-proxy] in ascolto su http://${addr.address}:${addr.port}`);
  console.log(`[byok-proxy] database: ${dbPath} (${store.counts().total} clienti)`);
  console.log(`[byok-proxy] provider: ${cfg.provider.name} -> ${cfg.provider.baseUrl}`);
  console.log(`[byok-proxy] modelli: ${cfg.models.map((m) => m.id).join(", ") || "(nessuno)"}`);
  console.log(
    cfg.admin.token
      ? `[byok-proxy] dashboard admin: http://${addr.address}:${addr.port}/admin`
      : "[byok-proxy] dashboard admin disattivata (imposta ADMIN_TOKEN per abilitarla)"
  );

  // Spegnimento pulito: smette di accettare richieste, scrive gli eventi in
  // buffer e chiude il DB.
  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[byok-proxy] ${signal}: arresto in corso`);
    server.close(async () => {
      metrics.close();
      await closeUsageWorkers();
      db.close();
      process.exit(0);
    });
    setTimeout(() => {
      metrics.close();
      process.exit(0);
    }, 10_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((e) => {
  console.error(`[byok-proxy] avvio fallito: ${e.message}`);
  process.exit(1);
});
