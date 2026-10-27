// Motore dei limiti.
//
// Ogni richiesta viene valutata contro tutte le regole che le corrispondono
// (dimensioni utente, gruppo e modello in AND). Vince la più restrittiva: se
// una qualsiasi regola supera un suo limite, la richiesta è bloccata.
//
// I contatori usano finestre fisse allineate (minuto/ora/giorno) per restare
// O(1) in memoria e nel tempo. Sono per-processo; per più istanze del proxy
// basta sostituire il backing store con Redis mantenendo la stessa interfaccia.

import { WINDOWS, REQUEST_LIMITS, TOKEN_LIMITS } from "./config.js";
import { ruleMatchesUser } from "./models.js";

/** Chiave di conteggio di una regola, in base a countBy. */
function countByKey(rule, user, model) {
  switch (rule.countBy) {
    case "group": {
      const g = rule.match.groups.find((x) => user.groups.includes(x)) ?? user.groups[0] ?? "-";
      return `g:${g}`;
    }
    case "model":
      return `m:${model}`;
    case "user+model":
      return `u:${user.id}#m:${model}`;
    case "global":
      return "*";
    case "user":
    default:
      return `u:${user.id}`;
  }
}

/** Una regola si applica a (utente, modello)? */
function ruleApplies(rule, user, model) {
  if (!ruleMatchesUser(rule, user)) return false;
  if (rule.match.models.length && !rule.match.models.includes(model)) return false;
  // Una regola di solo accesso (senza limiti) non partecipa al conteggio.
  return Object.keys(rule.limits).length > 0;
}

export class RateLimiter {
  /** @param {() => number} now sorgente temporale (iniettabile nei test). */
  constructor(now = () => Date.now()) {
    this.now = now;
    /** @type {Map<string, {windowStart:number, count:number}>} */
    this.buckets = new Map();
  }

  _bucket(compositeKey, windowSize) {
    const now = this.now();
    const windowStart = Math.floor(now / windowSize) * windowSize;
    let b = this.buckets.get(compositeKey);
    if (!b || b.windowStart !== windowStart) {
      b = { windowStart, count: 0 };
      this.buckets.set(compositeKey, b);
    }
    return b;
  }

  _key(rule, user, model, limitName) {
    return `${rule.id}|${countByKey(rule, user, model)}|${limitName}`;
  }

  /** Regole con limiti che si applicano a questa richiesta. */
  _matching(cfg, user, model) {
    return cfg.rules.filter((r) => ruleApplies(r, user, model));
  }

  /**
   * Prova a consumare una richiesta. Se consentita, incrementa i contatori di
   * richiesta. Non tocca i contatori token (vengono aggiornati dopo, con l'uso
   * reale), ma li controlla in pre-volo: se una finestra token è già satura,
   * blocca.
   *
   * @returns {{ok:true} | {ok:false, status:429, message:string, retryAfterSec:number, ruleId:string, limit:string}}
   */
  tryConsume(cfg, user, model) {
    const rules = this._matching(cfg, user, model);
    const now = this.now();

    // Pre-controllo (nessuna mutazione finché non sappiamo che passa tutto).
    for (const rule of rules) {
      for (const name of REQUEST_LIMITS) {
        if (!(name in rule.limits)) continue;
        const size = WINDOWS[name];
        const b = this._bucket(this._key(rule, user, model, name), size);
        if (b.count + 1 > rule.limits[name]) {
          return deny(rule, name, b, size, now);
        }
      }
      for (const name of TOKEN_LIMITS) {
        if (!(name in rule.limits)) continue;
        const size = WINDOWS[name];
        const b = this._bucket(this._key(rule, user, model, name), size);
        if (b.count >= rule.limits[name]) {
          return deny(rule, name, b, size, now);
        }
      }
    }

    // Tutto ok: incrementa i contatori di richiesta.
    for (const rule of rules) {
      for (const name of REQUEST_LIMITS) {
        if (!(name in rule.limits)) continue;
        const b = this._bucket(this._key(rule, user, model, name), WINDOWS[name]);
        b.count += 1;
      }
    }
    return { ok: true };
  }

  /** Aggiorna i contatori token dopo aver conosciuto l'uso reale. */
  addTokens(cfg, user, model, tokens) {
    if (!tokens || tokens <= 0) return;
    const rules = this._matching(cfg, user, model);
    for (const rule of rules) {
      for (const name of TOKEN_LIMITS) {
        if (!(name in rule.limits)) continue;
        const b = this._bucket(this._key(rule, user, model, name), WINDOWS[name]);
        b.count += tokens;
      }
    }
  }

  /** Stato dei contatori per diagnostica (solo per l'utente/modello dati). */
  snapshot(cfg, user, model) {
    const out = [];
    for (const rule of this._matching(cfg, user, model)) {
      for (const [name, limit] of Object.entries(rule.limits)) {
        const b = this._bucket(this._key(rule, user, model, name), WINDOWS[name]);
        out.push({ rule: rule.id, limit: name, used: b.count, max: limit });
      }
    }
    return out;
  }
}

function deny(rule, name, bucket, size, now) {
  const retryAfterSec = Math.max(1, Math.ceil((bucket.windowStart + size - now) / 1000));
  return {
    ok: false,
    status: 429,
    ruleId: rule.id,
    limit: name,
    retryAfterSec,
    message: `Limite superato (regola "${rule.id}", ${name}=${rule.limits[name]}). Riprova tra ${retryAfterSec}s.`,
  };
}
