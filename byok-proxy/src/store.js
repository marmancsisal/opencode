// Store dei clienti, su SQLite con cache in memoria.
//
// Due sorgenti:
//  - clienti dalla config (api key + token GitHub via env), sincronizzati nel DB
//    all'avvio;
//  - clienti registrati col login GitHub (device flow), con api key generata.
//
// Le api key non sono mai salvate in chiaro: solo hash SHA-256 + un hint
// mascherato per la dashboard. Il lookup api key -> utente è una Map in memoria
// indicizzata per hash: O(1) a ogni richiesta, qualunque sia il numero di clienti.
// Il DB resta la fonte di verità; la cache si aggiorna a ogni scrittura.

import { readFileSync, existsSync } from "node:fs";
import crypto from "node:crypto";
import { openDb, tx } from "./db.js";
import { usageByUser } from "./usage-cache.js";

export function generateApiKey() {
  return `byok_${crypto.randomBytes(24).toString("hex")}`;
}

export function hashKey(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

/** Confronto a tempo costante (usato per il token admin). */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Mostra solo inizio e fine dell'api key. */
export function maskKey(key) {
  if (!key) return null;
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 9)}…${key.slice(-4)}`;
}

function configHash(u) {
  return hashKey(JSON.stringify([u.login, u.apiKey, u.groups, u.enabled]));
}

const ZERO_USAGE = Object.freeze({
  requests: 0, allowed: 0, blocked: 0, errors: 0, tokens: 0, firstSeen: null, lastSeen: null,
});

// Chiavi di ordinamento della lista clienti.
const SORTERS = {
  login: (a, b) => a.user.login.localeCompare(b.user.login, "it", { sensitivity: "base" }),
  requests: (a, b) => a.usage.requests - b.usage.requests,
  tokens: (a, b) => a.usage.tokens - b.usage.tokens,
  blocked: (a, b) => a.usage.blocked - b.usage.blocked,
  lastSeen: (a, b) => (a.usage.lastSeen ?? 0) - (b.usage.lastSeen ?? 0),
  created: (a, b) => (a.user.createdAt ?? 0) - (b.user.createdAt ?? 0),
};

export class UserStore {
  /**
   * @param {object} cfg config normalizzata
   * @param {object} [opts]
   * @param {import("node:sqlite").DatabaseSync} [opts.db] DB condiviso (default: in memoria)
   * @param {string} [opts.legacyJsonPath] vecchio users.json da importare una volta
   * @param {() => number} [opts.now]
   */
  constructor(cfg, { db = openDb(), legacyJsonPath = null, now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.db = db;
    this.now = now;
    /** token GitHub dei clienti da config: solo in memoria, mai nel DB */
    this.configTokens = new Map(cfg.users.map((u) => [u.id, u.githubToken ?? null]));
    /** hash api key -> utente */
    this.byHash = new Map();
    /** id -> utente */
    this.byId = new Map();

    this._prepare();
    this._seedConfigUsers();
    if (legacyJsonPath) this._importLegacyJson(legacyJsonPath);
    this._loadAll();
  }

  _prepare() {
    const db = this.db;
    this.q = {
      byId: db.prepare("SELECT * FROM users WHERE id = ?"),
      byGithubId: db.prepare("SELECT * FROM users WHERE github_id = ?"),
      all: db.prepare("SELECT * FROM users"),
      insert: db.prepare(`INSERT INTO users
        (id, login, source, github_id, api_key_hash, api_key_hint, groups, enabled, github_token,
         has_github_token, config_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      updateConfig: db.prepare(`UPDATE users SET login = ?, api_key_hash = ?, api_key_hint = ?, groups = ?,
        enabled = ?, has_github_token = ?, config_hash = ?, updated_at = ? WHERE id = ?`),
      setHasToken: db.prepare("UPDATE users SET has_github_token = ? WHERE id = ?"),
      deleteStaleConfig: db.prepare("SELECT id FROM users WHERE source = 'config'"),
      del: db.prepare("DELETE FROM users WHERE id = ?"),
      relogin: db.prepare(`UPDATE users SET login = ?, api_key_hash = ?, api_key_hint = ?, github_token = ?,
        has_github_token = ?, updated_at = ? WHERE id = ?`),
      setEnabled: db.prepare("UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?"),
      setGroups: db.prepare("UPDATE users SET groups = ?, updated_at = ? WHERE id = ?"),
      counts: db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(enabled), 0) AS enabled,
        COALESCE(SUM(has_github_token), 0) AS withToken FROM users`),
      groups: db.prepare("SELECT DISTINCT j.value AS g FROM users, json_each(users.groups) AS j ORDER BY g"),
      getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    };
  }

  /** Allinea i clienti della config al DB. Le modifiche admin restano finché la voce in config non cambia. */
  _seedConfigUsers() {
    const now = this.now();
    tx(this.db, () => {
      const wanted = new Set();
      for (const u of this.cfg.users) {
        wanted.add(u.id);
        const row = this.q.byId.get(u.id);
        const h = configHash(u);
        const hasToken = u.githubToken ? 1 : 0;
        const keyHash = u.apiKey ? hashKey(u.apiKey) : null;
        if (!row) {
          this.q.insert.run(u.id, u.login, "config", null, keyHash, maskKey(u.apiKey), JSON.stringify(u.groups),
            u.enabled === false ? 0 : 1, null, hasToken, h, now, now);
        } else if (row.source !== "config") {
          throw new Error(`Config: l'id "${u.id}" è già usato da un cliente registrato via login`);
        } else if (row.config_hash !== h) {
          this.q.updateConfig.run(u.login, keyHash, maskKey(u.apiKey), JSON.stringify(u.groups),
            u.enabled === false ? 0 : 1, hasToken, h, now, u.id);
        } else if (row.has_github_token !== hasToken) {
          this.q.setHasToken.run(hasToken, u.id);
        }
      }
      // Clienti tolti dalla config: non devono più poter entrare.
      for (const { id } of this.q.deleteStaleConfig.all()) {
        if (!wanted.has(id)) this.q.del.run(id);
      }
    });
  }

  /** Importa una volta il vecchio users.json (api key in chiaro -> hash). */
  _importLegacyJson(path) {
    if (this.q.getMeta.get("legacy_json_imported")) return;
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const now = this.now();
    tx(this.db, () => {
      for (const u of data.users ?? []) {
        if (!u.apiKey || !u.login) continue;
        const gid = u.githubId != null ? String(u.githubId) : null;
        if (gid && this.q.byGithubId.get(gid)) continue;
        const id = this._freeId(u.login, gid);
        this.q.insert.run(id, u.login, "device", gid, hashKey(u.apiKey), maskKey(u.apiKey),
          JSON.stringify(u.groups ?? []), u.enabled === false ? 0 : 1, u.githubToken ?? null,
          u.githubToken ? 1 : 0, null, now, now);
      }
      this.q.setMeta.run("legacy_json_imported", String(now));
    });
  }

  _freeId(login, githubId) {
    return this.q.byId.get(login) ? `${login}~${githubId ?? crypto.randomBytes(3).toString("hex")}` : login;
  }

  _toUser(r) {
    return {
      id: r.id,
      login: r.login,
      source: r.source,
      githubId: r.github_id,
      groups: JSON.parse(r.groups),
      enabled: !!r.enabled,
      githubToken: r.source === "config" ? (this.configTokens.get(r.id) ?? null) : r.github_token,
      hasGithubToken: !!r.has_github_token,
      apiKeyHint: r.api_key_hint,
      createdAt: r.created_at,
    };
  }

  _cache(row) {
    const prev = this.byId.get(row.id);
    if (prev?._hash) this.byHash.delete(prev._hash);
    const user = this._toUser(row);
    Object.defineProperty(user, "_hash", { value: row.api_key_hash, enumerable: false });
    this.byId.set(user.id, user);
    if (row.api_key_hash) this.byHash.set(row.api_key_hash, user);
    return user;
  }

  _uncache(id) {
    const prev = this.byId.get(id);
    if (!prev) return;
    if (prev._hash) this.byHash.delete(prev._hash);
    this.byId.delete(id);
  }

  _loadAll() {
    this.byHash.clear();
    this.byId.clear();
    for (const r of this.q.all.all()) this._cache(r);
  }

  _reload(id) {
    const row = this.q.byId.get(id);
    if (!row) {
      this._uncache(id);
      return null;
    }
    return this._cache(row);
  }

  /** Utente dall'api key, O(1). */
  resolveByApiKey(apiKey) {
    if (!apiKey) return null;
    return this.byHash.get(hashKey(apiKey)) ?? null;
  }

  findById(userId) {
    return this.byId.get(userId) ?? null;
  }

  /**
   * Crea o aggiorna un cliente registrato via login GitHub. Ogni login emette
   * una NUOVA api key (la precedente smette di funzionare): non avendo la chiave
   * in chiaro, non la si può ridare. Gruppi e stato di un cliente esistente
   * restano quelli impostati dall'admin.
   */
  upsertDeviceUser({ githubId, login, githubToken, groups = [] }) {
    const apiKey = generateApiKey();
    const h = hashKey(apiKey);
    const hint = maskKey(apiKey);
    const now = this.now();
    const gid = githubId != null ? String(githubId) : null;
    const existing = gid ? this.q.byGithubId.get(gid) : null;
    let id;
    if (existing) {
      id = existing.id;
      this.q.relogin.run(login, h, hint, githubToken ?? null, githubToken ? 1 : 0, now, id);
    } else {
      id = this._freeId(login, gid);
      this.q.insert.run(id, login, "device", gid, h, hint, JSON.stringify([...new Set(groups)]), 1,
        githubToken ?? null, githubToken ? 1 : 0, null, now, now);
    }
    const user = this._reload(id);
    return { apiKey, user };
  }

  setEnabled(userId, enabled) {
    if (!this.byId.has(userId)) return false;
    this.q.setEnabled.run(enabled ? 1 : 0, this.now(), userId);
    this._reload(userId);
    return true;
  }

  setGroups(userId, groups) {
    if (!this.byId.has(userId)) return false;
    this.q.setGroups.run(JSON.stringify([...new Set(groups)]), this.now(), userId);
    this._reload(userId);
    return true;
  }

  /** Revoca un cliente registrato via login (api key e token eliminati). */
  revokeDeviceUser(userId) {
    const u = this.byId.get(userId);
    if (!u || u.source !== "device") return false;
    this.q.del.run(userId);
    this._uncache(userId);
    return true;
  }

  counts() {
    const r = this.q.counts.get();
    return { total: r.total, enabled: r.enabled, withToken: r.withToken };
  }

  allGroups() {
    return this.q.groups.all().map((r) => r.g);
  }

  /**
   * Pagina di clienti con utilizzo nel periodo, filtrata e ordinata.
   *
   * I clienti sono già in memoria (cache del DB) e i totali per cliente arrivano
   * da un aggregato con cache breve (usage-cache.js): filtro, ordinamento e
   * paginazione costano qualche ms anche con decine di migliaia di clienti.
   *
   * @param {object} p
   * @param {string} [p.q] cerca in id, login e gruppi (senza distinzione maiuscole)
   * @param {"all"|"enabled"|"disabled"|"notoken"} [p.status]
   * @param {keyof SORTERS} [p.sort]
   * @param {"asc"|"desc"} [p.dir]
   * @param {number} [p.limit]
   * @param {number} [p.offset]
   * @param {string} [p.sinceDay] "YYYY-MM-DD": utilizzo da questo giorno incluso
   */
  async queryClients({ q = "", status = "all", sort = "requests", dir = "desc", limit = 50, offset = 0, sinceDay = "0000-00-00" } = {}) {
    const usage = await usageByUser(this.db, sinceDay);
    const needle = q.toLowerCase();
    const rows = [];
    for (const user of this.byId.values()) {
      if (status === "enabled" && !user.enabled) continue;
      if (status === "disabled" && user.enabled) continue;
      if (status === "notoken" && user.hasGithubToken) continue;
      if (
        needle &&
        !user.login.toLowerCase().includes(needle) &&
        !user.id.toLowerCase().includes(needle) &&
        !user.groups.some((g) => g.toLowerCase().includes(needle))
      ) {
        continue;
      }
      rows.push({ user, usage: usage.get(user.id) ?? ZERO_USAGE });
    }
    const cmp = SORTERS[sort] ?? SORTERS.requests;
    const sign = dir === "asc" ? 1 : -1;
    rows.sort((a, b) => sign * cmp(a, b) || (a.user.id < b.user.id ? -1 : a.user.id > b.user.id ? 1 : 0));
    const lim = Math.min(Math.max(limit, 1), 500);
    const off = Math.max(offset, 0);
    return { total: rows.length, rows: rows.slice(off, off + lim) };
  }
}
