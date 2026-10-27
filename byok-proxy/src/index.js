#!/usr/bin/env node
// Entry point: carica la config, costruisce i componenti e avvia il server.

import { loadConfigFromFile } from "./config.js";
import { UserStore } from "./store.js";
import { RateLimiter } from "./limits.js";
import { ModelProvider } from "./provider.js";
import { DeviceFlow } from "./auth.js";
import { MetricsStore } from "./metrics.js";
import { createApp, startServer } from "./server.js";

async function main() {
  const configPath = process.env.CONFIG_PATH || "config.json";
  const cfg = loadConfigFromFile(configPath);

  const store = new UserStore(cfg, { path: process.env.USERS_DB || "./data/users.json" });
  const limiter = new RateLimiter();
  const provider = new ModelProvider(cfg);
  const deviceFlow = new DeviceFlow(cfg.oauth);
  const metrics = new MetricsStore();

  const app = createApp({ cfg, store, limiter, provider, deviceFlow, metrics });
  const server = await startServer(app, cfg.server);
  const addr = server.address();
  console.log(`[byok-proxy] in ascolto su http://${addr.address}:${addr.port}`);
  console.log(`[byok-proxy] provider: ${cfg.provider.name} -> ${cfg.provider.baseUrl}`);
  console.log(`[byok-proxy] modelli: ${cfg.models.map((m) => m.id).join(", ") || "(nessuno)"}`);
  console.log(
    cfg.admin.token
      ? `[byok-proxy] dashboard admin: http://${addr.address}:${addr.port}/admin`
      : "[byok-proxy] dashboard admin disattivata (imposta ADMIN_TOKEN per abilitarla)"
  );
}

main().catch((e) => {
  console.error(`[byok-proxy] avvio fallito: ${e.message}`);
  process.exit(1);
});
