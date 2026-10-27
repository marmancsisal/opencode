// Dashboard admin: stato, chiamate API, login, tab, aggiornamento.
// I tre file in src/dashboard/ vengono serviti concatenati come /admin/dashboard.js.
//
// Scala: la dashboard non scarica mai "tutto". Totali e grafici arrivano già
// aggregati dal server; clienti ed eventi sono pagine (50 / 100 righe) filtrate
// e ordinate nel DB. L'aggiornamento automatico ricarica solo la vista aperta.
"use strict";

const D = {
  $: (s, r = document) => r.querySelector(s),
  $$: (s, r = document) => [...r.querySelectorAll(s)],
  nf: new Intl.NumberFormat("it-IT"),
  nfc: new Intl.NumberFormat("it-IT", { notation: "compact", maximumFractionDigits: 1 }),
  token: null,
  days: 30,
  tab: "overview",
  timer: null,
  openClientId: null,
  state: {
    overview: null,
    usage: null,
    rules: null,
    clients: { data: [], total: 0 },
    events: { data: [], nextBefore: null },
  },
  clientQuery: { q: "", status: "all", sort: "requests", dir: "desc", limit: 50, offset: 0 },
  eventQuery: { q: "", outcome: "all", limit: 100 },
  eventsPaged: false, // l'utente ha caricato pagine successive: niente refresh automatico
};

D.esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
D.fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "—");
D.fmtDay = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
D.pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1).replace(".", ",")}%` : "0%");
D.debounce = (fn, ms = 250) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

// Storage protetto: in finestre private o con storage bloccato non deve rompere nulla.
D.session = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* ignora */ } },
  del: (k) => { try { sessionStorage.removeItem(k); } catch { /* ignora */ } },
};
D.pref = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
};

D.api = async function api(path, opts = {}) {
  const res = await fetch(`/admin/api${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${D.token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) {
    const msg = body?.error?.message || "Non autorizzato";
    D.logout(msg);
    throw new Error(msg);
  }
  if (!res.ok) throw new Error(body?.error?.message || `HTTP ${res.status}`);
  return body;
};

D.qs = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

D.toast = function toast(msg) {
  const t = D.$("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(D._toastTimer);
  D._toastTimer = setTimeout(() => (t.hidden = true), 2500);
};

D.logout = function logout(msg) {
  D.token = null;
  D.session.del("adminToken");
  clearInterval(D.timer);
  D.$("#app").hidden = true;
  D.$("#login").hidden = false;
  D.$("#loginErr").textContent = msg || "";
  if (D.closeDrawer) D.closeDrawer();
};

D.showApp = function showApp() {
  D.$("#login").hidden = true;
  D.$("#app").hidden = false;
  D.selectTab(D.pref.get("tab") || "overview");
  D.loadAll();
  D.setAuto();
};

D.selectTab = function selectTab(name) {
  if (!D.$(`[data-panel="${name}"]`)) name = "overview";
  D.tab = name;
  D.$$("nav [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  D.$$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  D.pref.set("tab", name);
  if (!D.token) return;
  if (name === "overview" && D.state.usage) D.renderCharts();
  if (name === "clients") D.loadClients();
  if (name === "events") D.loadEvents(true);
};

D.setAuto = function setAuto() {
  clearInterval(D.timer);
  if (D.$("#autoRefresh").checked) D.timer = setInterval(() => D.loadAll(true), 10000);
};

D.loadClients = async function loadClients() {
  const r = await D.api(`/clients?${D.qs({ ...D.clientQuery, days: D.days })}`);
  // Se un filtro ha ridotto il totale sotto l'offset, torna all'ultima pagina valida.
  if (r.data.length === 0 && r.total > 0 && D.clientQuery.offset > 0) {
    D.clientQuery.offset = Math.max(0, Math.floor((r.total - 1) / D.clientQuery.limit) * D.clientQuery.limit);
    return D.loadClients();
  }
  D.state.clients = r;
  D.renderClients();
};

D.loadEvents = async function loadEvents(reset) {
  const before = reset ? null : D.state.events.nextBefore;
  const r = await D.api(`/events?${D.qs({ ...D.eventQuery, before })}`);
  if (reset) {
    D.state.events = r;
    D.eventsPaged = false;
  } else {
    D.state.events = { data: [...D.state.events.data, ...r.data], nextBefore: r.nextBefore };
    D.eventsPaged = true;
  }
  D.renderEvents();
};

D.loadAll = async function loadAll(silent) {
  try {
    const [overview, usage, rules] = await Promise.all([
      D.api(`/overview?days=${D.days}`),
      D.api(`/usage?days=${D.days}`),
      D.state.rules ? Promise.resolve(D.state.rules) : D.api("/rules"),
    ]);
    Object.assign(D.state, { overview, usage, rules });
    D.$("#providerName").textContent = overview.provider;
    D.renderKpis();
    D.renderCharts();
    D.renderTop();
    D.renderModels();
    D.renderRules();
    // Solo la vista aperta, per non caricare pagine che nessuno guarda.
    if (D.tab === "clients") await D.loadClients();
    if (D.tab === "events" && !D.eventsPaged) await D.loadEvents(true);
    D.$("#lastUpdate").textContent = `Aggiornato ${new Date().toLocaleTimeString("it-IT")}`;
    if (D.openClientId) D.openClient(D.openClientId, true);
  } catch (err) {
    if (!silent && D.token) D.toast(`Errore: ${err.message}`);
  }
};
