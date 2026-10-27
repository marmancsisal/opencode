// Area admin: dashboard (pagina statica) + API JSON per gestire i clienti e
// leggere le metriche d'uso.
//
// La pagina /admin non contiene dati: chiede il token admin e chiama le API.
// Tutte le /admin/api/* richiedono `Authorization: Bearer <ADMIN_TOKEN>`.
// Senza token configurato l'area è disattivata.
//
// Le liste (clienti, eventi) sono paginate, filtrate e ordinate nel DB: la
// risposta ha dimensione costante qualunque sia il numero di clienti o di log.

import { readFileSync } from "node:fs";
import { readJson, sendJson, sendError, extractBearer } from "./http-helpers.js";
import { safeEqual, maskKey } from "./store.js";
import { allowedModelsForUser } from "./models.js";

export { maskKey };

const DASHBOARD_HTML = readFileSync(new URL("./dashboard.html", import.meta.url));
// Lo script della dashboard è diviso in tre file per leggibilità e servito unito.
const DASHBOARD_JS = ["core.js", "charts.js", "tables.js"]
  .map((f) => readFileSync(new URL(`./dashboard/${f}`, import.meta.url), "utf8"))
  .join("\n;\n");

const MAX_DAYS = 365;

function intParam(url, name, def, min, max) {
  const v = Number(url.searchParams.get(name));
  if (!Number.isFinite(v) || url.searchParams.get(name) === null) return def;
  return Math.min(Math.max(Math.trunc(v), min), max);
}

function clientView(cfg, u, usage) {
  return {
    id: u.id,
    login: u.login,
    source: u.source,
    groups: u.groups,
    enabled: u.enabled !== false,
    apiKeyHint: u.apiKeyHint,
    hasGithubToken: u.hasGithubToken,
    allowedModels: allowedModelsForUser(cfg, u),
    createdAt: u.createdAt ?? null,
    usage,
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

  // Le letture devono vedere anche gli eventi ancora nel buffer.
  metrics?.flush();

  const route = path.slice("/admin/api".length); // es. "/clients/alice/disable"
  const parts = route.split("/").filter(Boolean).map(decodeURIComponent);
  const days = intParam(url, "days", 30, 1, MAX_DAYS);

  // GET /admin/api/overview?days=30
  if (req.method === "GET" && route === "/overview") {
    return sendJson(res, 200, {
      provider: cfg.provider.name,
      clients: store.counts(),
      usage: metrics ? await metrics.overview(days) : null,
      models: cfg.models.map((m) => m.id),
      rules: cfg.rules.length,
    });
  }

  // GET /admin/api/clients?q=&status=&sort=&dir=&limit=&offset=&days=
  if (req.method === "GET" && route === "/clients") {
    const limit = intParam(url, "limit", 50, 1, 500);
    const offset = intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const { total, rows } = await store.queryClients({
      q: (url.searchParams.get("q") || "").trim(),
      status: url.searchParams.get("status") || "all",
      sort: url.searchParams.get("sort") || "requests",
      dir: url.searchParams.get("dir") || "desc",
      limit,
      offset,
      sinceDay: metrics ? metrics.sinceDay(days) : "0000-00-00",
    });
    return sendJson(res, 200, {
      data: rows.map((r) => clientView(cfg, r.user, r.usage)),
      total,
      limit,
      offset,
    });
  }

  // /admin/api/clients/:id[/azione]
  if (parts[0] === "clients" && parts[1]) {
    const id = parts[1];
    const action = parts[2];
    const user = store.findById(id);
    if (!user) return sendError(res, 404, `Cliente "${id}" non trovato`, { type: "not_found" });
    const usageOf = (u) => (metrics ? metrics.forUser(u.id, days) : null);

    if (req.method === "GET" && !action) {
      const view = clientView(cfg, user, usageOf(user));
      view.limits = view.allowedModels.map((m) => ({ model: m, counters: limiter.snapshot(cfg, user, m) }));
      view.recent = metrics ? metrics.recentForUser(id, 50) : [];
      return sendJson(res, 200, view);
    }
    if (req.method === "POST" && (action === "enable" || action === "disable")) {
      store.setEnabled(id, action === "enable");
      const u = store.findById(id);
      return sendJson(res, 200, clientView(cfg, u, usageOf(u)));
    }
    if (req.method === "POST" && action === "groups") {
      const { groups } = await readJson(req);
      if (!Array.isArray(groups) || !groups.every((g) => typeof g === "string" && g.trim())) {
        return sendError(res, 400, "groups deve essere un array di stringhe non vuote", { type: "invalid_request" });
      }
      store.setGroups(id, groups.map((g) => g.trim()));
      const u = store.findById(id);
      return sendJson(res, 200, clientView(cfg, u, usageOf(u)));
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
    return sendJson(res, 200, {
      days,
      byDay: metrics ? metrics.byDay(days) : [],
      byModel: metrics ? metrics.byModel(days) : [],
      topUsers: metrics ? await metrics.topUsers(days, intParam(url, "top", 10, 1, 100)) : [],
    });
  }

  // GET /admin/api/events?outcome=&user=&model=&q=&before=&limit=
  if (req.method === "GET" && route === "/events") {
    if (!metrics) return sendJson(res, 200, { data: [], nextBefore: null });
    return sendJson(
      res,
      200,
      metrics.events({
        outcome: url.searchParams.get("outcome") || "all",
        userId: url.searchParams.get("user") || null,
        model: url.searchParams.get("model") || null,
        q: (url.searchParams.get("q") || "").trim(),
        before: url.searchParams.get("before"),
        limit: intParam(url, "limit", 100, 1, 500),
      })
    );
  }

  // GET /admin/api/rules
  if (req.method === "GET" && route === "/rules") {
    const groups = new Set(store.allGroups());
    for (const r of cfg.rules) for (const g of r.match.groups) groups.add(g);
    return sendJson(res, 200, { rules: cfg.rules, groups: [...groups].sort() });
  }

  return sendError(res, 404, "Rotta admin non trovata", { type: "not_found" });
}
