// Dashboard admin: stato, chiamate API, login, tab, aggiornamento.
// I tre file in src/dashboard/ vengono serviti concatenati come /admin/dashboard.js.
"use strict";

const D = {
  $: (s, r = document) => r.querySelector(s),
  $$: (s, r = document) => [...r.querySelectorAll(s)],
  nf: new Intl.NumberFormat("it-IT"),
  nfc: new Intl.NumberFormat("it-IT", { notation: "compact", maximumFractionDigits: 1 }),
  token: null,
  state: { overview: null, clients: [], usage: null, events: [], rules: null },
  days: 30,
  timer: null,
  openClientId: null,
};

D.esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
D.fmtDate = (ts) => (ts ? new Date(ts).toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" }) : "—");
D.fmtDay = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
D.pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1).replace(".", ",")}%` : "0%");

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
  D.$$("nav [role=tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
  D.$$("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== name));
  D.pref.set("tab", name);
  if (name === "overview" && D.state.usage) D.renderCharts();
};

D.setAuto = function setAuto() {
  clearInterval(D.timer);
  if (D.$("#autoRefresh").checked) D.timer = setInterval(() => D.loadAll(true), 10000);
};

D.loadAll = async function loadAll(silent) {
  try {
    const [overview, clients, usage, events, rules] = await Promise.all([
      D.api("/overview"),
      D.api("/clients"),
      D.api(`/usage?days=${D.days}`),
      D.api("/events?limit=500"),
      D.api("/rules"),
    ]);
    D.state = { overview, clients: clients.data, usage, events: events.data, rules };
    D.render();
    D.$("#lastUpdate").textContent = `Aggiornato ${new Date().toLocaleTimeString("it-IT")}`;
    if (D.openClientId) D.openClient(D.openClientId, true);
  } catch (err) {
    if (!silent && D.token) D.toast(`Errore: ${err.message}`);
  }
};

D.render = function render() {
  D.$("#providerName").textContent = D.state.overview.provider;
  D.renderKpis();
  D.renderCharts();
  D.renderTop();
  D.renderClients();
  D.renderModels();
  D.renderEvents();
  D.renderRules();
};
