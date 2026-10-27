// Area admin: dashboard (pagina statica) + API JSON per gestire i clienti e
// leggere le metriche d'uso.
//
// La pagina /admin non contiene dati: chiede il token admin e chiama le API.
// Tutte le /admin/api/* richiedono `Authorization: Bearer <ADMIN_TOKEN>`.
// Senza token configurato l'area è disattivata.

import { readFileSync } from "node:fs";
import { readJson, sendJson, sendError, extractBearer } from "./http-helpers.js";
import { safeEqual } from "./store.js";
import { allowedModelsForUser } from "./models.js";

const DASHBOARD_HTML = readFileSync(new URL("./dashboard.html", import.meta.url));
// Lo script della dashboard è diviso in tre file per leggibilità e servito unito.
const DASHBOARD_JS = ["core.js", "charts.js", "tables.js"]
  .map((f) => readFileSync(new URL(`./dashboard/${f}`, import.meta.url), "utf8"))
  .join("\n;\n");

/** Mostra solo inizio e fine dell'api key. */
export function maskKey(key) {
  if (!key) return null;
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 9)}…${key.slice(-4)}`;
}

function clientView(cfg, u, metrics) {
  const usage = metrics ? metrics.forUser(u.id) : null;
  return {
    id: u.id,
    login: u.login,
    source: u.source,
    groups: u.groups,
    enabled: u.enabled !== false,
    apiKeyHint: maskKey(u.apiKey),
    hasGithubToken: !!u.githubToken,
    allowedModels: allowedModelsForUser(cfg, u),
    usage: usage && {
      requests: usage.requests,
      allowed: usage.allowed,
      blocked: usage.blocked,
      errors: usage.errors,
      tokens: usage.tokens,
      firstSeen: usage.firstSeen ?? null,
      lastSeen: usage.lastSeen ?? null,
    },
  };
}

function isAuthorized(cfg, req) {
  if (!cfg.admin.token) return false;
  const given = extractBearer(req.headers.authorization);
  return !!given && safeEqual(given, cfg.admin.token);
}

export async function handleAdmin(req, res, { path, url, cfg, store, limiter, metrics }) {
  if (req.method === "GET" && (path === "/admin" || path === "/admin/")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      "X-Frame-Options": "DENY",
    });
    return res.end(DASHBOARD_HTML);
  }

  if (req.method === "GET" && path === "/admin/dashboard.js") {
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(DASHBOARD_JS);
  }

  if (!path.startsWith("/admin/api/")) {
    return sendError(res, 404, "Rotta admin non trovata", { type: "not_found" });
  }
  if (!cfg.admin.token) {
    return sendError(res, 403, "Area admin disattivata: imposta ADMIN_TOKEN.", { type: "admin_disabled" });
  }
  if (!isAuthorized(cfg, req)) {
    return sendError(res, 401, "Token admin mancante o non valido.", { type: "authentication_error" });
  }

  const route = path.slice("/admin/api".length); // es. "/clients/alice/disable"
  const parts = route.split("/").filter(Boolean).map(decodeURIComponent);

  // GET /admin/api/overview
  if (req.method === "GET" && route === "/overview") {
    const clients = store.listClients();
    return sendJson(res, 200, {
      provider: cfg.provider.name,
      clients: {
        total: clients.length,
        enabled: clients.filter((c) => c.enabled !== false).length,
        withToken: clients.filter((c) => !!c.githubToken).length,
      },
      usage: metrics ? metrics.overview() : null,
      models: cfg.models.map((m) => m.id),
      rules: cfg.rules.length,
    });
  }

  // GET /admin/api/clients
  if (req.method === "GET" && route === "/clients") {
    const data = store.listClients().map((u) => clientView(cfg, u, metrics));
    return sendJson(res, 200, { data });
  }

  // /admin/api/clients/:id[/azione]
  if (parts[0] === "clients" && parts[1]) {
    const id = parts[1];
    const action = parts[2];
    const user = store.findById(id);
    if (!user) return sendError(res, 404, `Cliente "${id}" non trovato`, { type: "not_found" });

    if (req.method === "GET" && !action) {
      const view = clientView(cfg, user, metrics);
      view.limits = view.allowedModels.map((m) => ({ model: m, counters: limiter.snapshot(cfg, user, m) }));
      view.recent = metrics ? metrics.recentEvents(500).filter((e) => e.userId === id).slice(0, 50) : [];
      return sendJson(res, 200, view);
    }
    if (req.method === "POST" && (action === "enable" || action === "disable")) {
      store.setEnabled(id, action === "enable");
      return sendJson(res, 200, clientView(cfg, user, metrics));
    }
    if (req.method === "POST" && action === "groups") {
      const { groups } = await readJson(req);
      if (!Array.isArray(groups) || !groups.every((g) => typeof g === "string" && g.trim())) {
        return sendError(res, 400, "groups deve essere un array di stringhe non vuote", { type: "invalid_request" });
      }
      store.setGroups(id, groups.map((g) => g.trim()));
      return sendJson(res, 200, clientView(cfg, user, metrics));
    }
    if (req.method === "DELETE" && !action) {
      if (user.source !== "device") {
        return sendError(res, 400, "I clienti definiti in config si rimuovono dal file di config; qui puoi solo disattivarli.", {
          type: "invalid_request",
        });
      }
      store.revokeDeviceUser(id);
      return sendJson(res, 200, { revoked: id });
    }
    return sendError(res, 405, "Metodo/azione non supportati", { type: "method_not_allowed" });
  }

  // GET /admin/api/usage?days=30
  if (req.method === "GET" && route === "/usage") {
    const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 30, 1), 90);
    return sendJson(res, 200, {
      byDay: metrics ? metrics.byDay(days) : [],
      byModel: metrics ? metrics.byModel() : [],
      byUser: metrics ? metrics.users() : [],
    });
  }

  // GET /admin/api/events?limit=100
  if (req.method === "GET" && route === "/events") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
    return sendJson(res, 200, { data: metrics ? metrics.recentEvents(limit) : [] });
  }

  // GET /admin/api/rules
  if (req.method === "GET" && route === "/rules") {
    const groups = new Set();
    for (const u of store.listClients()) for (const g of u.groups) groups.add(g);
    for (const r of cfg.rules) for (const g of r.match.groups) groups.add(g);
    return sendJson(res, 200, { rules: cfg.rules, groups: [...groups].sort() });
  }

  return sendError(res, 404, "Rotta admin non trovata", { type: "not_found" });
}
