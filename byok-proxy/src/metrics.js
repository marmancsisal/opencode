// Metriche d'uso su SQLite, pensate per molti clienti e molti log.
//
// Scrittura: record() mette l'evento in un buffer e torna subito. Il buffer
// viene scritto in UNA transazione (eventi + riepiloghi) dopo `flushIntervalMs`,
// oppure al primo giro libero dell'event loop quando raggiunge `batchSize`:
// mai dentro la richiesta, che quindi non aspetta il disco.
//
// Lettura: KPI, grafici e classifiche leggono dai riepiloghi (vedi db.js), non
// dalla tabella eventi: il costo dipende da giorni x clienti/modelli, non dal
// numero di richieste. La tabella eventi si interroga solo per il log paginato
// e per il dettaglio di un cliente, sempre via indice e con LIMIT.
//
// Retention: eventi oltre `retentionDays` e riepiloghi oltre
// `rollupRetentionDays` vengono cancellati a blocchi, all'avvio e ogni ora.

import { openDb, tx, dayKey } from "./db.js";
import { usageByUser } from "./usage-cache.js";

const DAY_MS = 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;
const PRUNE_CHUNK = 5000;
// Ricerca nel log: fino a questo numero di clienti/modelli corrispondenti si
// legge l'indice di ciascuno (costo limitato); oltre, il termine è generico e
// una scansione per id trova presto le corrispondenze.
const SEARCH_FANOUT = 50;
const COUNTERS = "requests, allowed, blocked, errors, tokens, latency_sum, latency_n";
const ADD_COUNTERS = `
  requests = requests + excluded.requests,
  allowed = allowed + excluded.allowed,
  blocked = blocked + excluded.blocked,
  errors = errors + excluded.errors,
  tokens = tokens + excluded.tokens,
  latency_sum = latency_sum + excluded.latency_sum,
  latency_n = latency_n + excluded.latency_n`;
const ADD_SEEN = `,
  first_ts = MIN(COALESCE(first_ts, excluded.first_ts), excluded.first_ts),
  last_ts = MAX(COALESCE(last_ts, excluded.last_ts), excluded.last_ts)`;

function newAgg(e) {
  return { requests: 0, allowed: 0, blocked: 0, errors: 0, tokens: 0, latencySum: 0, latencyN: 0, first: e.ts, last: e.ts };
}

function addTo(a, e) {
  a.requests += 1;
  if (e.outcome === "allowed") a.allowed += 1;
  else if (e.outcome === "blocked") a.blocked += 1;
  else if (e.outcome === "error") a.errors += 1;
  a.tokens += e.tokens || 0;
  if (Number.isFinite(e.latencyMs)) {
    a.latencySum += Math.round(e.latencyMs);
    a.latencyN += 1;
  }
  if (e.ts < a.first) a.first = e.ts;
  if (e.ts > a.last) a.last = e.ts;
}

function bump(map, key, e, extra) {
  let a = map.get(key);
  if (!a) {
    a = Object.assign(newAgg(e), extra);
    map.set(key, a);
  }
  addTo(a, e);
}

const counters = (a) => [a.requests, a.allowed, a.blocked, a.errors, a.tokens, a.latencySum, a.latencyN];

export class MetricsStore {
  /**
   * @param {object} [opts]
   * @param {import("node:sqlite").DatabaseSync} [opts.db] DB condiviso con UserStore
   * @param {() => number} [opts.now]
   * @param {number} [opts.batchSize] eventi oltre i quali si scrive al prossimo giro
   * @param {number} [opts.flushIntervalMs] 0 = nessun timer (test, benchmark)
   * @param {number} [opts.retentionDays] giorni di log eventi conservati
   * @param {number} [opts.rollupRetentionDays] giorni di riepiloghi conservati
   */
  constructor({
    db = openDb(),
    now = () => Date.now(),
    batchSize = 500,
    flushIntervalMs = 1000,
    retentionDays = 90,
    rollupRetentionDays = 400,
  } = {}) {
    this.db = db;
    this.now = now;
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
    this.retentionDays = retentionDays;
    this.rollupRetentionDays = rollupRetentionDays;
    this.buffer = [];
    this.timer = null;
    this.immediate = null;
    this.pruneTimer = null;
    this._prepare();
    this.prune();
    if (flushIntervalMs > 0) {
      this.pruneTimer = setInterval(() => this.prune(), PRUNE_EVERY_MS);
      this.pruneTimer.unref?.();
    }
  }

  _prepare() {
    const db = this.db;
    const p = (sql) => db.prepare(sql);
    this.q = {
      insertEvent: p(`INSERT INTO events (ts, user_id, model, outcome, status, tokens, latency_ms, reason, stream)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      upDay: p(`INSERT INTO usage_day (day, ${COUNTERS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day) DO UPDATE SET ${ADD_COUNTERS}`),
      upUserDay: p(`INSERT INTO usage_user_day (day, user_id, ${COUNTERS}, first_ts, last_ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, user_id) DO UPDATE SET ${ADD_COUNTERS}${ADD_SEEN}`),
      upModelDay: p(`INSERT INTO usage_model_day (day, model, ${COUNTERS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, model) DO UPDATE SET ${ADD_COUNTERS}`),
      upDaily: p(`INSERT INTO usage_daily (day, user_id, model, ${COUNTERS}, first_ts, last_ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, user_id, model) DO UPDATE SET ${ADD_COUNTERS}${ADD_SEEN}`),

      totals: p(`SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(allowed),0) AS allowed,
        COALESCE(SUM(blocked),0) AS blocked, COALESCE(SUM(errors),0) AS errors, COALESCE(SUM(tokens),0) AS tokens,
        COALESCE(SUM(latency_sum),0) AS latency_sum, COALESCE(SUM(latency_n),0) AS latency_n
        FROM usage_day WHERE day >= ?`),
      activeModels: p("SELECT COUNT(DISTINCT model) AS n FROM usage_model_day WHERE day >= ?"),
      byDay: p("SELECT day, requests, allowed, blocked, errors, tokens FROM usage_day WHERE day >= ?"),
      byModel: p(`SELECT model, SUM(requests) AS requests, SUM(allowed) AS allowed, SUM(blocked) AS blocked,
        SUM(errors) AS errors, SUM(tokens) AS tokens,
        CASE WHEN SUM(latency_n) > 0 THEN SUM(latency_sum) / SUM(latency_n) END AS avg_latency_ms
        FROM usage_model_day WHERE day >= ? GROUP BY model ORDER BY requests DESC`),
      login: p("SELECT login FROM users WHERE id = ?"),
      forUser: p(`SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(allowed),0) AS allowed,
        COALESCE(SUM(blocked),0) AS blocked, COALESCE(SUM(errors),0) AS errors, COALESCE(SUM(tokens),0) AS tokens
        FROM usage_user_day WHERE user_id = ? AND day >= ?`),
      userSeen: p("SELECT MIN(first_ts) AS first_ts, MAX(last_ts) AS last_ts FROM usage_user_day WHERE user_id = ?"),
      userByModel: p(`SELECT model, SUM(requests) AS requests, SUM(tokens) AS tokens FROM usage_daily
        WHERE user_id = ? AND day >= ? GROUP BY model ORDER BY requests DESC`),
      recentForUser: p("SELECT * FROM events WHERE user_id = ? ORDER BY id DESC LIMIT ?"),
      knownUser: p("SELECT 1 FROM users WHERE id = ?"),
      knownModel: p("SELECT 1 FROM usage_model_day WHERE model = ? LIMIT 1"),
      matchUsers: p(`SELECT id FROM users WHERE id LIKE ? ESCAPE '\\' OR login LIKE ? ESCAPE '\\' LIMIT ${SEARCH_FANOUT + 1}`),
      matchModels: p(`SELECT DISTINCT model FROM usage_model_day WHERE model LIKE ? ESCAPE '\\' LIMIT ${SEARCH_FANOUT + 1}`),

      pruneEvents: p(`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE ts < ? LIMIT ${PRUNE_CHUNK})`),
      pruneDay: p("DELETE FROM usage_day WHERE day < ?"),
      pruneUserDay: p("DELETE FROM usage_user_day WHERE day < ?"),
      pruneModelDay: p("DELETE FROM usage_model_day WHERE day < ?"),
      pruneDaily: p("DELETE FROM usage_daily WHERE day < ?"),
    };
  }

  /** Registra un evento. Non tocca il DB: il lotto si scrive fuori dalla richiesta. */
  record(ev) {
    this.buffer.push({ ts: ev.ts ?? this.now(), ...ev });
    if (this.buffer.length >= this.batchSize) {
      if (!this.immediate) {
        this.immediate = setImmediate(() => {
          this.immediate = null;
          this.flush();
        });
      }
    } else if (!this.timer && this.flushIntervalMs > 0) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Scrive il buffer: eventi + riepiloghi in una sola transazione. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.immediate) {
      clearImmediate(this.immediate);
      this.immediate = null;
    }
    if (this.buffer.length === 0) return 0;
    const batch = this.buffer;
    this.buffer = [];

    // Pre-aggrega in memoria: una sola upsert per chiave di ciascun riepilogo.
    const day = new Map();
    const userDay = new Map();
    const modelDay = new Map();
    const daily = new Map();
    for (const e of batch) {
      const d = dayKey(e.ts);
      bump(day, d, e, { day: d });
      bump(userDay, `${d}\u0000${e.userId}`, e, { day: d, userId: e.userId });
      bump(modelDay, `${d}\u0000${e.model}`, e, { day: d, model: e.model });
      bump(daily, `${d}\u0000${e.userId}\u0000${e.model}`, e, { day: d, userId: e.userId, model: e.model });
    }

    tx(this.db, () => {
      const ins = this.q.insertEvent;
      for (const e of batch) {
        ins.run(e.ts, e.userId, e.model, e.outcome, e.status ?? null, e.tokens || 0,
          Number.isFinite(e.latencyMs) ? Math.round(e.latencyMs) : null, e.reason ?? null, e.stream ? 1 : 0);
      }
      for (const a of day.values()) this.q.upDay.run(a.day, ...counters(a));
      for (const a of userDay.values()) this.q.upUserDay.run(a.day, a.userId, ...counters(a), a.first, a.last);
      for (const a of modelDay.values()) this.q.upModelDay.run(a.day, a.model, ...counters(a));
      for (const a of daily.values()) this.q.upDaily.run(a.day, a.userId, a.model, ...counters(a), a.first, a.last);
    });
    return batch.length;
  }

  /** Cancella i dati oltre la retention, a blocchi per non tenere il DB occupato a lungo. */
  prune() {
    const now = this.now();
    const cutoff = now - this.retentionDays * DAY_MS;
    let removed = 0;
    for (;;) {
      const n = Number(this.q.pruneEvents.run(cutoff).changes);
      removed += n;
      if (n < PRUNE_CHUNK) break;
    }
    const rollCut = dayKey(now - this.rollupRetentionDays * DAY_MS);
    this.q.pruneDay.run(rollCut);
    this.q.pruneUserDay.run(rollCut);
    this.q.pruneModelDay.run(rollCut);
    this.q.pruneDaily.run(rollCut);
    return removed;
  }

  /** Ferma i timer e scrive quanto resta (da chiamare allo spegnimento). */
  close() {
    this.flush();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }

  /** Primo giorno incluso per una finestra di `days` giorni che termina oggi. */
  sinceDay(days) {
    return dayKey(this.now() - (days - 1) * DAY_MS);
  }

  async overview(days = 30) {
    const since = this.sinceDay(days);
    const t = this.q.totals.get(since);
    return {
      requests: t.requests,
      allowed: t.allowed,
      blocked: t.blocked,
      errors: t.errors,
      tokens: t.tokens,
      users: (await usageByUser(this.db, since)).size,
      models: this.q.activeModels.get(since).n,
      avgLatencyMs: t.latency_n ? Math.round(t.latency_sum / t.latency_n) : null,
      days,
    };
  }

  /** Serie giornaliera completa (giorni senza traffico a zero), dal più vecchio. */
  byDay(days = 30) {
    const rows = new Map(this.q.byDay.all(this.sinceDay(days)).map((r) => [r.day, r]));
    const out = [];
    const end = this.now();
    for (let i = days - 1; i >= 0; i--) {
      const day = dayKey(end - i * DAY_MS);
      const r = rows.get(day);
      out.push({
        day,
        requests: r?.requests ?? 0,
        allowed: r?.allowed ?? 0,
        blocked: r?.blocked ?? 0,
        errors: r?.errors ?? 0,
        tokens: r?.tokens ?? 0,
      });
    }
    return out;
  }

  byModel(days = 30) {
    return this.q.byModel.all(this.sinceDay(days)).map((r) => ({
      model: r.model,
      requests: r.requests,
      allowed: r.allowed,
      blocked: r.blocked,
      errors: r.errors,
      tokens: r.tokens,
      avgLatencyMs: r.avg_latency_ms == null ? null : Math.round(r.avg_latency_ms),
    }));
  }

  async topUsers(days = 30, limit = 10) {
    const top = [...(await usageByUser(this.db, this.sinceDay(days)))]
      .sort((a, b) => b[1].requests - a[1].requests)
      .slice(0, limit);
    return top.map(([userId, u]) => ({
      userId,
      login: this.q.login.get(userId)?.login ?? userId,
      requests: u.requests,
      tokens: u.tokens,
      blocked: u.blocked,
    }));
  }

  /** Utilizzo di un cliente nel periodo + prima/ultima richiesta di sempre. */
  forUser(userId, days = 30) {
    const since = this.sinceDay(days);
    const u = this.q.forUser.get(userId, since);
    const seen = this.q.userSeen.get(userId);
    return {
      requests: u.requests,
      allowed: u.allowed,
      blocked: u.blocked,
      errors: u.errors,
      tokens: u.tokens,
      firstSeen: seen?.first_ts ?? null,
      lastSeen: seen?.last_ts ?? null,
      byModel: this.q.userByModel.all(userId, since),
    };
  }

  recentForUser(userId, limit = 50) {
    return this.q.recentForUser.all(userId, limit).map(toEvent);
  }

  /**
   * Log eventi paginato a cursore (dal più recente). `before` è l'id
   * dell'ultimo evento della pagina precedente.
   *
   * La ricerca testuale `q` non scansiona il log: trova prima i clienti
   * (id/login) e i modelli che contengono il testo, poi legge gli eventi di
   * ciascuno dal suo indice e unisce i risultati. Nessuna corrispondenza =
   * risposta immediata. Un `q` uguale a un cliente o modello noto è un filtro esatto.
   */
  events({ outcome, userId, model, q, before, limit = 100 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const base = [];
    const args = [];
    if (before) {
      base.push("e.id < ?");
      args.push(Number(before));
    }
    if (outcome && outcome !== "all") {
      base.push("e.outcome = ?");
      args.push(outcome);
    }
    if (userId) {
      base.push("e.user_id = ?");
      args.push(userId);
    }
    if (model) {
      base.push("e.model = ?");
      args.push(model);
    }

    if (q && !userId && this.q.knownUser.get(q)) {
      return this._eventsPage([...base, "e.user_id = ?"], [...args, q], lim);
    }
    if (q && !model && this.q.knownModel.get(q)) {
      return this._eventsPage([...base, "e.model = ?"], [...args, q], lim);
    }
    if (!q) return this._eventsPage(base, args, lim);

    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const users = this.q.matchUsers.all(like, like).map((r) => r.id);
    const models = this.q.matchModels.all(like).map((r) => r.model);
    if (users.length === 0 && models.length === 0) return { data: [], nextBefore: null };

    if (users.length <= SEARCH_FANOUT && models.length <= SEARCH_FANOUT) {
      // Una lettura d'indice per ciascun cliente/modello, poi unione per id.
      const seen = new Map();
      for (const u of users) {
        for (const r of this._eventRows([...base, "e.user_id = ?"], [...args, u], lim + 1)) seen.set(r.id, r);
      }
      for (const m of models) {
        for (const r of this._eventRows([...base, "e.model = ?"], [...args, m], lim + 1)) seen.set(r.id, r);
      }
      const rows = [...seen.values()].sort((a, b) => b.id - a.id).slice(0, lim + 1);
      return this._page(rows, lim);
    }

    // Termine generico: molte corrispondenze, la scansione per id si ferma presto.
    const or = [];
    if (users.length) {
      or.push("e.user_id IN (SELECT id FROM users WHERE id LIKE ? ESCAPE '\\' OR login LIKE ? ESCAPE '\\')");
      args.push(like, like);
    }
    if (models.length) {
      or.push("e.model LIKE ? ESCAPE '\\'");
      args.push(like);
    }
    return this._eventsPage([...base, `(${or.join(" OR ")})`], args, lim);
  }

  _eventRows(where, args, n) {
    return this.db
      .prepare(`SELECT e.*, u.login FROM events e LEFT JOIN users u ON u.id = e.user_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY e.id DESC LIMIT ?`)
      .all(...args, n);
  }

  _eventsPage(where, args, lim) {
    return this._page(this._eventRows(where, args, lim + 1), lim);
  }

  _page(rows, lim) {
    const hasMore = rows.length > lim;
    const page = rows.slice(0, lim).map(toEvent);
    return { data: page, nextBefore: hasMore ? page.at(-1).id : null };
  }
}

function toEvent(r) {
  return {
    id: r.id,
    ts: r.ts,
    userId: r.user_id,
    login: r.login ?? r.user_id,
    model: r.model,
    outcome: r.outcome,
    status: r.status,
    tokens: r.tokens,
    latencyMs: r.latency_ms,
    reason: r.reason,
    stream: !!r.stream,
  };
}
