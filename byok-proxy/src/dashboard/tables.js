// Tabelle clienti/modelli/eventi/regole, drawer di dettaglio cliente, azioni.
"use strict";

// ---------- Clienti ----------
D.clientSort = { key: "requests", dir: -1 };

D.filteredClients = function filteredClients() {
  const q = D.$("#clientSearch").value.trim().toLowerCase();
  const f = D.$("#clientFilter").value;
  let rows = D.state.clients.filter((c) => {
    if (f === "enabled" && !c.enabled) return false;
    if (f === "disabled" && c.enabled) return false;
    if (f === "notoken" && c.hasGithubToken) return false;
    if (q) return c.login.toLowerCase().includes(q) || c.groups.some((g) => g.toLowerCase().includes(q));
    return true;
  });
  const { key, dir } = D.clientSort;
  const val = (c) => (key === "login" ? c.login : key === "groups" ? c.groups.length : c.usage?.[key] || 0);
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (typeof va === "string") return dir * va.localeCompare(vb);
    return dir * (va - vb);
  });
  return rows;
};

D.renderClients = function renderClients() {
  const rows = D.filteredClients();
  D.$("#clientCount").textContent = `${rows.length} di ${D.state.clients.length}`;
  const cols = [
    { key: "login", label: "Cliente" },
    { key: "groups", label: "Gruppi" },
    { key: "source", label: "Tipo" },
    { key: "requests", label: "Richieste", num: true },
    { key: "tokens", label: "Token", num: true },
    { key: "blocked", label: "Bloccate", num: true },
    { key: "state", label: "Stato" },
  ];
  const arrow = (k) => (D.clientSort.key === k ? `<span class="arrow">${D.clientSort.dir < 0 ? "▼" : "▲"}</span>` : "");
  const head = cols
    .map((c) => {
      const sortable = ["login", "groups", "requests", "tokens", "blocked"].includes(c.key);
      return `<th class="${c.num ? "num" : ""}" ${sortable ? `data-sort="${c.key}"` : ""}>${c.label} ${sortable ? arrow(c.key) : ""}</th>`;
    })
    .join("");
  const body = rows
    .map((c) => {
      const u = c.usage || {};
      const st = !c.enabled
        ? '<span class="state off">Disattivato</span>'
        : c.hasGithubToken
          ? '<span class="state ok">Attivo</span>'
          : '<span class="state warn">Senza token</span>';
      return `<tr class="clickable" data-id="${D.esc(c.id)}">
        <td>${D.esc(c.login)}</td>
        <td>${c.groups.map((g) => `<span class="pill">${D.esc(g)}</span>`).join(" ") || '<span class="muted">—</span>'}</td>
        <td><span class="muted">${c.source === "device" ? "login" : "config"}</span></td>
        <td class="num">${D.nf.format(u.requests || 0)}</td>
        <td class="num">${D.nfc.format(u.tokens || 0)}</td>
        <td class="num">${D.nf.format(u.blocked || 0)}</td>
        <td>${st}</td></tr>`;
    })
    .join("");
  D.$("#clientsTable").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body || '<tr><td class="empty">Nessun cliente</td></tr>'}</tbody>`;

  D.$$("#clientsTable th[data-sort]").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      D.clientSort = { key: k, dir: D.clientSort.key === k ? -D.clientSort.dir : (k === "login" ? 1 : -1) };
      D.renderClients();
    };
  });
  D.$$("#clientsTable tr[data-id]").forEach((tr) => (tr.onclick = () => D.openClient(tr.dataset.id)));
};

D.$("#clientSearch").oninput = () => D.renderClients();
D.$("#clientFilter").onchange = () => D.renderClients();

// ---------- Drawer cliente ----------
D.openClient = async function openClient(id, refresh) {
  D.openClientId = id;
  let c;
  try {
    c = await D.api(`/clients/${encodeURIComponent(id)}`);
  } catch {
    return;
  }
  const u = c.usage || { requests: 0, allowed: 0, blocked: 0, errors: 0, tokens: 0 };
  const limitsHtml = c.limits
    .filter((l) => l.counters.length)
    .map(
      (l) => `<div style="margin-top:8px"><div class="mono" style="font-size:12px">${D.esc(l.model)}</div>${l.counters
        .map((ct) => {
          const ratio = ct.max ? Math.min(1, ct.used / ct.max) : 0;
          return `<div style="display:flex;justify-content:space-between;font-size:12px;margin-top:4px"><span class="muted">${D.esc(ct.rule)} · ${ct.limit}</span><span>${D.nf.format(ct.used)} / ${D.nf.format(ct.max)}</span></div>
            <div class="meter ${ratio > 0.9 ? "hot" : ""}"><div style="width:${(ratio * 100).toFixed(0)}%"></div></div>`;
        })
        .join("")}</div>`
    )
    .join("");

  const recent = (c.recent || [])
    .slice(0, 20)
    .map(
      (e) => `<tr><td>${D.esc(D.fmtDate(e.ts))}</td><td class="mono">${D.esc(e.model)}</td><td>${outcomeBadge(e.outcome)}</td><td class="num">${D.nf.format(e.tokens || 0)}</td></tr>`
    )
    .join("");

  const canManage = c.source === "device" || true;
  const drawer = D.$("#drawer");
  drawer.innerHTML = `
    <div class="card-head">
      <h2 id="drawerTitle">${D.esc(c.login)}</h2>
      <button type="button" id="drawerClose" aria-label="Chiudi">✕</button>
    </div>
    <div class="row-actions">
      ${c.enabled
        ? `<button type="button" class="danger" data-act="disable">Disattiva</button>`
        : `<button type="button" class="primary" data-act="enable">Riattiva</button>`}
      ${c.source === "device" ? `<button type="button" class="danger" data-act="revoke">Revoca accesso</button>` : ""}
    </div>
    <dl class="kv">
      <dt>Stato</dt><dd>${c.enabled ? '<span class="state ok">Attivo</span>' : '<span class="state off">Disattivato</span>'}</dd>
      <dt>Tipo</dt><dd>${c.source === "device" ? "registrato via login" : "definito in config"}</dd>
      <dt>Token GitHub</dt><dd>${c.hasGithubToken ? '<span class="state ok">presente</span>' : '<span class="state warn">assente</span>'}</dd>
      <dt>API key</dt><dd class="mono">${D.esc(c.apiKeyHint || "—")}</dd>
      <dt>Gruppi</dt><dd id="groupsCell">${c.groups.map((g) => `<span class="pill">${D.esc(g)}</span>`).join(" ") || '<span class="muted">nessuno</span>'}
        <button type="button" id="editGroups" style="margin-left:8px;padding:2px 8px">Modifica</button></dd>
      <dt>Modelli consentiti</dt><dd>${c.allowedModels.map((m) => `<span class="pill">${D.esc(m)}</span>`).join(" ") || '<span class="muted">nessuno</span>'}</dd>
      <dt>Prima richiesta</dt><dd>${D.fmtDate(u.firstSeen)}</dd>
      <dt>Ultima richiesta</dt><dd>${D.fmtDate(u.lastSeen)}</dd>
    </dl>
    <div><h2 style="font-size:14px">Utilizzo</h2>
      <dl class="kv">
        <dt>Richieste</dt><dd>${D.nf.format(u.requests)} (${D.nf.format(u.allowed)} ok, ${D.nf.format(u.blocked)} bloccate, ${D.nf.format(u.errors)} errori)</dd>
        <dt>Token</dt><dd>${D.nf.format(u.tokens)}</dd>
      </dl>
    </div>
    ${limitsHtml ? `<div><h2 style="font-size:14px">Limiti in corso</h2>${limitsHtml}</div>` : ""}
    <div><h2 style="font-size:14px">Ultime richieste</h2>
      <div class="table-wrap"><table>${recent ? `<thead><tr><th>Quando</th><th>Modello</th><th>Esito</th><th class="num">Token</th></tr></thead><tbody>${recent}</tbody>` : '<tbody><tr><td class="empty">Nessuna richiesta</td></tr></tbody>'}</table></div>
    </div>`;
  void canManage;

  D.$("#drawerBg").hidden = false;
  drawer.hidden = false;
  D.$("#drawerClose").onclick = D.closeDrawer;
  D.$("#editGroups").onclick = () => editGroups(c);
  D.$$("#drawer [data-act]").forEach((b) => (b.onclick = () => clientAction(c, b.dataset.act)));
  if (!refresh) D.$("#drawerClose").focus();
};

function outcomeBadge(o) {
  if (o === "allowed") return '<span class="state ok">ok</span>';
  if (o === "blocked") return '<span class="state off">bloccata</span>';
  if (o === "error") return '<span class="state warn">errore</span>';
  return D.esc(o);
}

async function editGroups(c) {
  const input = prompt("Gruppi separati da virgola:", c.groups.join(", "));
  if (input == null) return;
  const groups = input.split(",").map((g) => g.trim()).filter(Boolean);
  try {
    await D.api(`/clients/${encodeURIComponent(c.id)}/groups`, { method: "POST", body: JSON.stringify({ groups }) });
    D.toast("Gruppi aggiornati");
    await D.loadAll(true);
    D.openClient(c.id, true);
  } catch (err) {
    D.toast(`Errore: ${err.message}`);
  }
}

async function clientAction(c, act) {
  if (act === "revoke" && !confirm(`Revocare l'accesso di ${c.login}? L'API key smetterà di funzionare.`)) return;
  try {
    if (act === "revoke") {
      await D.api(`/clients/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      D.toast("Accesso revocato");
      D.closeDrawer();
    } else {
      await D.api(`/clients/${encodeURIComponent(c.id)}/${act}`, { method: "POST" });
      D.toast(act === "disable" ? "Cliente disattivato" : "Cliente riattivato");
    }
    await D.loadAll(true);
    if (act !== "revoke") D.openClient(c.id, true);
  } catch (err) {
    D.toast(`Errore: ${err.message}`);
  }
}

D.closeDrawer = function closeDrawer() {
  D.openClientId = null;
  D.$("#drawer").hidden = true;
  D.$("#drawerBg").hidden = true;
};
D.$("#drawerBg").onclick = D.closeDrawer;
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !D.$("#drawer").hidden) D.closeDrawer();
});

// ---------- Modelli ----------
D.renderModels = function renderModels() {
  const rows = D.state.usage?.byModel || [];
  D.$("#modelsTable").innerHTML = rows.length
    ? `<thead><tr><th>Modello</th><th class="num">Richieste</th><th class="num">Consentite</th><th class="num">Bloccate</th><th class="num">Errori</th><th class="num">Token</th></tr></thead>
       <tbody>${rows
         .map(
           (m) => `<tr><td class="mono">${D.esc(m.model)}</td><td class="num">${D.nf.format(m.requests)}</td><td class="num">${D.nf.format(m.allowed)}</td><td class="num">${D.nf.format(m.blocked)}</td><td class="num">${D.nf.format(m.errors)}</td><td class="num">${D.nf.format(m.tokens)}</td></tr>`
         )
         .join("")}</tbody>`
    : '<tbody><tr><td class="empty">Nessun utilizzo ancora</td></tr></tbody>';
};

// ---------- Eventi ----------
D.renderEvents = function renderEvents() {
  const q = D.$("#eventSearch").value.trim().toLowerCase();
  const f = D.$("#eventFilter").value;
  const rows = D.state.events.filter((e) => {
    if (f !== "all" && e.outcome !== f) return false;
    if (q) return (e.login || e.userId || "").toLowerCase().includes(q) || (e.model || "").toLowerCase().includes(q);
    return true;
  });
  D.$("#eventsTable").innerHTML =
    `<thead><tr><th>Quando</th><th>Cliente</th><th>Modello</th><th>Esito</th><th class="num">Token</th><th class="num">Latenza</th><th>Motivo</th></tr></thead>` +
    `<tbody>${rows.length
      ? rows
          .map(
            (e) => `<tr><td>${D.esc(D.fmtDate(e.ts))}</td><td>${D.esc(e.login || e.userId)}</td><td class="mono">${D.esc(e.model)}</td><td>${outcomeBadge(e.outcome)}</td><td class="num">${D.nf.format(e.tokens || 0)}</td><td class="num">${Number.isFinite(e.latencyMs) ? D.nf.format(e.latencyMs) + " ms" : "—"}</td><td class="muted">${D.esc(e.reason || "")}</td></tr>`
          )
          .join("")
      : '<tr><td class="empty">Nessun evento</td></tr>'}</tbody>`;
};
D.$("#eventSearch").oninput = () => D.renderEvents();
D.$("#eventFilter").onchange = () => D.renderEvents();

// ---------- Regole ----------
D.renderRules = function renderRules() {
  const rules = D.state.rules?.rules || [];
  const dim = (arr) => (arr.length ? arr.map((x) => `<span class="pill">${D.esc(x)}</span>`).join(" ") : '<span class="muted">tutti</span>');
  const lim = (l) => Object.entries(l).map(([k, v]) => `${k}=${D.nf.format(v)}`).join(", ") || '<span class="muted">—</span>';
  D.$("#rulesTable").innerHTML =
    `<thead><tr><th>Regola</th><th>Utenti</th><th>Gruppi</th><th>Modelli</th><th>Conteggio</th><th>Limiti</th><th>Accesso</th></tr></thead>` +
    `<tbody>${rules.length
      ? rules
          .map(
            (r) => `<tr><td>${D.esc(r.id)}</td><td>${dim(r.match.users)}</td><td>${dim(r.match.groups)}</td><td>${dim(r.match.models)}</td><td class="muted">${D.esc(r.countBy)}</td><td>${lim(r.limits)}</td><td>${r.access ? `<span class="pill">${D.esc(r.access)}</span>` : '<span class="muted">—</span>'}</td></tr>`
          )
          .join("")
      : '<tr><td class="empty">Nessuna regola</td></tr>'}</tbody>`;
};

// ---------- Avvio ----------
D.$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  D.token = D.$("#tokenInput").value.trim();
  D.$("#loginErr").textContent = "";
  try {
    await D.api("/overview");
    D.session.set("adminToken", D.token);
    D.showApp();
  } catch (err) {
    D.$("#loginErr").textContent = err.message;
  }
};
D.$("#logoutBtn").onclick = () => D.logout();
D.$("#refreshBtn").onclick = () => D.loadAll();
D.$("#autoRefresh").onchange = () => D.setAuto();
D.$("#daysSel").onchange = (e) => { D.days = Number(e.target.value); D.loadAll(); };
D.$$("nav [role=tab]").forEach((b) => (b.onclick = () => D.selectTab(b.dataset.tab)));

// Tema
const savedTheme = D.pref.get("theme");
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
D.$("#themeBtn").onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  D.pref.set("theme", next);
  if (D.state.usage) D.renderCharts();
};

// Sessione già autenticata?
D.token = D.session.get("adminToken");
if (D.token) {
  D.api("/overview").then(() => D.showApp()).catch(() => D.logout());
}
