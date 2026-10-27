// Raccolta metriche d'uso, per la dashboard admin.
//
// Registra un evento per ogni richiesta di chat (anche quelle bloccate) e tiene
// aggregati pronti da leggere: totali, per utente, per modello, per giorno, più
// un anello degli ultimi eventi. Tutto in memoria, con sorgente temporale
// iniettabile per i test; per persistenza/scalabilità si rimpiazza lo store
// mantenendo gli stessi metodi di lettura.

const DAY_MS = 86_400_000;

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function emptyAgg() {
  return { requests: 0, allowed: 0, blocked: 0, errors: 0, tokens: 0 };
}

function addTo(agg, ev) {
  agg.requests += 1;
  agg.tokens += ev.tokens || 0;
  if (ev.outcome === "allowed") agg.allowed += 1;
  else if (ev.outcome === "blocked") agg.blocked += 1;
  else if (ev.outcome === "error") agg.errors += 1;
}

export class MetricsStore {
  constructor({ now = () => Date.now(), recentLimit = 500, retentionDays = 90 } = {}) {
    this.now = now;
    this.recentLimit = recentLimit;
    this.retentionDays = retentionDays;
    this.total = emptyAgg();
    /** @type {Map<string, object>} userId -> agg (+ login, lastSeen) */
    this.perUser = new Map();
    /** @type {Map<string, object>} model -> agg */
    this.perModel = new Map();
    /** @type {Map<string, object>} YYYY-MM-DD -> agg */
    this.perDay = new Map();
    /** @type {Array} anello degli ultimi eventi */
    this.recent = [];
  }

  /**
   * @param {object} ev
   * @param {string} ev.userId
   * @param {string} [ev.login]
   * @param {string} ev.model
   * @param {number} [ev.tokens]
   * @param {number} [ev.status] http status
   * @param {"allowed"|"blocked"|"error"} ev.outcome
   * @param {boolean} [ev.stream]
   */
  record(ev) {
    const ts = ev.ts ?? this.now();
    const e = { ts, tokens: 0, ...ev };

    addTo(this.total, e);

    let u = this.perUser.get(e.userId);
    if (!u) {
      u = { ...emptyAgg(), userId: e.userId, login: e.login ?? e.userId, firstSeen: ts };
      this.perUser.set(e.userId, u);
    }
    u.login = e.login ?? u.login;
    u.lastSeen = ts;
    addTo(u, e);

    let m = this.perModel.get(e.model);
    if (!m) {
      m = { ...emptyAgg(), model: e.model };
      this.perModel.set(e.model, m);
    }
    addTo(m, e);

    const dk = dayKey(ts);
    let d = this.perDay.get(dk);
    if (!d) {
      d = { ...emptyAgg(), day: dk };
      this.perDay.set(dk, d);
    }
    addTo(d, e);

    this.recent.push(e);
    if (this.recent.length > this.recentLimit) this.recent.shift();

    this._pruneDays(ts);
  }

  _pruneDays(ts) {
    const cutoff = ts - this.retentionDays * DAY_MS;
    for (const [k, v] of this.perDay) {
      if (Date.parse(v.day) < cutoff) this.perDay.delete(k);
    }
  }

  overview() {
    return {
      ...this.total,
      users: this.perUser.size,
      models: this.perModel.size,
      since: this.recent[0]?.ts ?? null,
    };
  }

  users() {
    return [...this.perUser.values()].sort((a, b) => b.requests - a.requests);
  }

  byModel() {
    return [...this.perModel.values()].sort((a, b) => b.requests - a.requests);
  }

  /** Serie giornaliera per gli ultimi `days` giorni (dal più vecchio al più recente). */
  byDay(days = 30) {
    const out = [];
    const end = this.now();
    for (let i = days - 1; i >= 0; i--) {
      const dk = dayKey(end - i * DAY_MS);
      out.push(this.perDay.get(dk) ?? { ...emptyAgg(), day: dk });
    }
    return out;
  }

  recentEvents(limit = 100) {
    return this.recent.slice(-limit).reverse();
  }

  /** Usage per un singolo utente (per la riga/espansione nella dashboard). */
  forUser(userId) {
    return this.perUser.get(userId) ?? { ...emptyAgg(), userId };
  }
}
