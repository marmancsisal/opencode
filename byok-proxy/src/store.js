// Store degli utenti e delle credenziali.
//
// Due sorgenti:
//  - utenti statici dalla config (api key + token GitHub via env);
//  - utenti registrati a runtime dal device flow, con api key generata e token
//    GitHub ottenuto col consenso dell'utente. Opzionalmente persistiti su file.
//
// La chiave è l'api key che l'utente incolla in Visual Studio come "API key" del
// modello custom. Dall'api key il proxy risale all'utente, ai suoi gruppi e al
// suo token GitHub con cui autenticare la chiamata al modello.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import crypto from "node:crypto";

export function generateApiKey() {
  return `byok_${crypto.randomBytes(24).toString("hex")}`;
}

/** Confronto a tempo costante per evitare timing oracle sull'api key. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export class UserStore {
  constructor(cfg, { path = null } = {}) {
    this.cfg = cfg;
    this.path = path;
    /** api key -> utente statico (config) */
    this.staticByKey = new Map();
    for (const u of cfg.users) {
      if (u.apiKey) this.staticByKey.set(u.apiKey, u);
    }
    /** api key -> utente runtime (device flow) */
    this.dynamicByKey = new Map();
    /** github user id -> api key, per non duplicare al re-login */
    this.keyByGithubId = new Map();
    if (path) this._load();
  }

  _load() {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8"));
      for (const u of data.users ?? []) {
        this.dynamicByKey.set(u.apiKey, { ...u, source: "device" });
        if (u.githubId != null) this.keyByGithubId.set(String(u.githubId), u.apiKey);
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e; // file assente al primo avvio: ok
    }
  }

  _save() {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const users = [...this.dynamicByKey.values()];
    writeFileSync(this.path, JSON.stringify({ users }, null, 2));
  }

  /** Risolve l'utente a partire dall'api key. O(n) solo sugli statici (pochi). */
  resolveByApiKey(apiKey) {
    if (!apiKey) return null;
    // Statici: confronto a tempo costante contro ciascuna chiave.
    for (const [key, user] of this.staticByKey) {
      if (safeEqual(key, apiKey)) return user;
    }
    const dyn = this.dynamicByKey.get(apiKey);
    if (dyn) return dyn;
    return null;
  }

  /**
   * Crea o aggiorna un utente registrato via device flow.
   * Riusa l'api key esistente se lo stesso account GitHub rientra.
   */
  upsertDeviceUser({ githubId, login, githubToken, groups = [] }) {
    const existingKey = githubId != null ? this.keyByGithubId.get(String(githubId)) : null;
    const apiKey = existingKey ?? generateApiKey();
    const user = {
      id: login,
      login,
      githubId,
      apiKey,
      groups,
      githubToken,
      source: "device",
    };
    this.dynamicByKey.set(apiKey, user);
    if (githubId != null) this.keyByGithubId.set(String(githubId), apiKey);
    this._save();
    return { apiKey, user };
  }
}
