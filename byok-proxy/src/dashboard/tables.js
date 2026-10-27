// Tabelle clienti/modelli/eventi/regole, drawer di dettaglio cliente, azioni.
// Clienti ed eventi sono pagine servite dal DB: qui si disegna solo la pagina.
"use strict";

function outcomeBadge(o) {
  if (o === "allowed") return '<span class="state ok">ok</span>';
  if (o === "blocked") return '<span class="state off">bloccata</span>';
  if (o === "error") return '<span class="state warn">errore</span>';
  return D.esc(o);
}

// ---------- Clienti ----------
const CLIENT_COLS = [
  { key: "login", label: "Cliente", sort: "login" },
  { key: "groups", label: "Gruppi" },
  { key: "source", label: "Tipo" },
  { key: "requests", label: "Richieste", num: true, sort: "requests" },
  { key: "tokens", label: "Token", num: true, sort: "tokens" },
  { key: "blocked", label: "Bloccate", num: true, sort: "blocked" },
  { key: "lastSeen", label: "Ultima attività", sort: "lastSeen" },
  { key: "state", label: "Stato" },
];

D.renderClients = function renderClients() {
  const { data, total } = D.state.clients;
  const cq = D.clientQuery;
  const arrow = (k) => (cq.sort === k ? `<span class="arrow">${cq.dir === "desc" ? "▼" : "▲"}</span>` : "");
  const head = CLIENT_COLS.map(
    (c) => `<th class="${c.num ? "num" : ""}" ${c.sort ? `data-sort="${c.sort}" tabindex="0"` : ""}>${c.label} ${c.sort ? arrow(c.sort) : ""}</th>`
  ).join("");
  const body = data
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
        <td>${u.lastSeen ? D.esc(D.fmtDate(u.lastSeen)) : '<span class="muted">—</span>'}</td>
        <td>${st}</td></tr>`;
    })
    .join("");
  D.$("#clientsTable").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body || '<tr><td class="empty" colspan="8">Nessun cliente</td></tr>'}</tbody>`;

  const from = total ? cq.offset + 1 : 0;
  const to = Math.min(cq.offset + data.length, total);
  D.$("#clientCount").textContent = `${D.nf.format(from)}–${D.nf.format(to)} di ${D.nf.format(total)}`;
  D.$("#clientPager").innerHTML = `
    <button type="button" data-page="prev" ${cq.offset === 0 ? "disabled" : ""}>← Precedenti</button>
    <span class="status">Pagina ${D.nf.format(Math.floor(cq.offset / cq.limit) + 1)} di ${D.nf.format(Math.max(1, Math.ceil(total / cq.limit)))}</span>
    <button type="button" data-page="next" ${to >= total ? "disabled" : ""}>Successivi →</button>`;

  D.$$("#clientsTable th[data-sort]").forEach((th) => {
    const go = () => {
      const k = th.dataset.sort;
      cq.dir = cq.sort === k ? (cq.dir === "desc" ? "asc" : "desc") : k === "login" ? "asc" : "desc";
      cq.sort = k;
      cq.offset = 0;
      D.loadClients();
    };
    th.onclick = go;
    th.onkeydown = (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), go());
  });
  D.$$("#clientsTable tr[data-id]").forEach((tr) => (tr.onclick = () => D.openClient(tr.dataset.id)));
  D.$$("#clientPager [data-page]").forEach((b) => {
    b.onclick = () => {
      cq.offset = Math.max(0, cq.offset + (b.dataset.page === "next" ? cq.limit : -cq.limit));
      D.loadClients();
    };
  });
};

D.$("#clientSearch").oninput = D.debounce((e) => {
  D.clientQuery.q = e.target.value.trim();
  D.clientQuery.offset = 0;
  D.loadClients();
});
D.$("#clientFilter").onchange = (e) => {
  D.clientQuery.status = e.target.value;
  D.clientQuery.offset = 0;
  D.loadClients();
};

// ---------- Drawer cliente ----------
D.openClient = async function openClient(id, refresh) {
  D.openClientId = id;
  let c;
  try {
    c = await D.api(`/clients/${encodeURIComponent(id)}?days=${D.days}`);
  } catch {
    return;
  }
  const u = c.usage || { requests: 0, allowed: 0, blocked: 0, errors: 0, tokens: 0, byModel: [] };
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
  const perModel = (u.byModel || [])
    .map((m) => `<tr><td class="mono">${D.esc(m.model)}</td><td class="num">${D.nf.format(m.requests)}</td><td class="num">${D.nfc.format(m.tokens)}</td></tr>`)
    .join("");
  const recent = (c.recent || [])
    .slice(0, 20)
    .map(
      (e) => `<tr><td>${D.esc(D.fmtDate(e.ts))}</td><td class="mono">${D.esc(e.model)}</td><td>${outcomeBadge(e.outcome)}</td><td class="num">${D.nf.format(e.tokens || 0)}</td></tr>`
    )
    .join("");

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
      <button type="button" data-act="events">Vedi tutti gli eventi</button>
    </div>
    <dl class="kv">
      <dt>Stato</dt><dd>${c.enabled ? '<span class="state ok">Attivo</span>' : '<span class="state off">Disattivato</span>'}</dd>
      <dt>Tipo</dt><dd>${c.source === "device" ? "registrato via login" : "definito in config"}</dd>
      <dt>Token GitHub</dt><dd>${c.hasGithubToken ? '<span class="state ok">presente</span>' : '<span class="state warn">assente</span>'}</dd>
      <dt>API key</dt><dd class="mono">${D.esc(c.apiKeyHint || "—")}</dd>
      <dt>Gruppi</dt><dd>${c.groups.map((g) => `<span class="pill">${D.esc(g)}</span>`).join(" ") || '<span class="muted">nessuno</span>'}
        <button type="button" id="editGroups" style="margin-left:8px;padding:2px 8px">Modifica</button></dd>
      <dt>Modelli consentiti</dt><dd>${c.allowedModels.map((m) => `<span class="pill">${D.esc(m)}</span>`).join(" ") || '<span class="muted">nessuno</span>'}</dd>
      <dt>Prima richiesta</dt><dd>${D.fmtDate(u.firstSeen)}</dd>
      <dt>Ultima richiesta</dt><dd>${D.fmtDate(u.lastSeen)}</dd>
    </dl>
    <div><h2 style="font-size:14px">Utilizzo · ultimi ${D.days} giorni</h2>
      <dl class="kv">
        <dt>Richieste</dt><dd>${D.nf.format(u.requests)} (${D.nf.format(u.allowed)} ok, ${D.nf.format(u.blocked)} bloccate, ${D.nf.format(u.errors)} errori)</dd>
        <dt>Token</dt><dd>${D.nf.format(u.tokens)}</dd>
      </dl>
      ${perModel ? `<div class="table-wrap"><table><thead><tr><th>Modello</th><th class="num">Richieste</th><th class="num">Token</th></tr></thead><tbody>${perModel}</tbody></table></div>` : ""}
    </div>
    ${limitsHtml ? `<div><h2 style="font-size:14px">Limiti in corso</h2>${limitsHtml}</div>` : ""}
    <div><h2 style="font-size:14px">Ultime richieste</h2>
      <div class="table-wrap"><table>${recent ? `<thead><tr><th>Quando</th><th>Modello</th><th>Esito</th><th class="num">Token</th></tr></thead><tbody>${recent}</tbody>` : '<tbody><tr><td class="empty">Nessuna richiesta</td></tr></tbody>'}</table></div>
    </div>`;

  D.$("#drawerBg").hidden = false;
  drawer.hidden = false;
  D.$("#drawerClose").onclick = D.closeDrawer;
  D.$("#editGroups").onclick = () => editGroups(c);
  D.$$("#drawer [data-act]").forEach((b) => (b.onclick = () => clientAction(c, b.dataset.act)));
  if (!refresh) D.$("#drawerClose").focus();
};

async function afterChange(id) {
  await D.loadAll(true);
  if (D.tab !== "clients") await D.loadClients().catch(() => {});
  if (id) D.openClient(id, true);
}

async function editGroups(c) {
  const input = prompt("Gruppi separati da virgola:", c.groups.join(", "));
  if (input == null) return;
  const groups = input.split(",").map((g) => g.trim()).filter(Boolean);
  try {
    await D.api(`/clients/${encodeURIComponent(c.id)}/groups`, { method: "POST", body: JSON.stringify({ groups }) });
    D.toast("Gruppi aggiornati");
    await afterChange(c.id);
  } catch (err) {
    D.toast(`Errore: ${err.message}`);
  }
}

async function clientAction(c, act) {
  if (act === "events") {
    D.closeDrawer();
    D.eventQuery.q = c.id;
    D.$("#eventSearch").value = c.id;
    D.selectTab("events");
    return;
  }
  if (act === "revoke" && !confirm(`Revocare l'accesso di ${c.login}? L'API key smetterà di funzionare.`)) return;
  try {
    if (act === "revoke") {
      await D.api(`/clients/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      D.toast("Accesso revocato");
      D.closeDrawer();
      await afterChange(null);
    } else {
      await D.api(`/clients/${encodeURIComponent(c.id)}/${act}`, { method: "POST" });
      D.toast(act === "disable" ? "Cliente disattivato" : "Cliente riattivato");
      await afterChange(c.id);
    }
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
    ? `<thead><tr><th>Modello</th><th class="num">Richieste</th><th class="num">Consentite</th><th class="num">Bloccate</th><th class="num">Errori</th><th class="num">Token</th><th class="num">Latenza media</th></tr></thead>
       <tbody>${rows
         .map(
           (m) => `<tr><td class="mono">${D.esc(m.model)}</td><td class="num">${D.nf.format(m.requests)}</td><td class="num">${D.nf.format(m.allowed)}</td><td class="num">${D.nf.format(m.blocked)}</td><td class="num">${D.nf.format(m.errors)}</td><td class="num">${D.nf.format(m.tokens)}</td><td class="num">${m.avgLatencyMs == null ? "—" : `${D.nf.format(m.avgLatencyMs)} ms`}</td></tr>`
         )
         .join("")}</tbody>`
    : '<tbody><tr><td class="empty">Nessun utilizzo nel periodo</td></tr></tbody>';
};

// ---------- Eventi ----------
D.renderEvents = function renderEvents() {
  const { data, nextBefore } = D.state.events;
  D.$("#eventsTable").innerHTML =
    `<thead><tr><th>Quando</th><th>Cliente</th><th>Modello</th><th>Esito</th><th class="num">Token</th><th class="num">Latenza</th><th>Motivo</th></tr></thead>` +
    `<tbody>${data.length
      ? data
          .map(
            (e) => `<tr><td>${D.esc(D.fmtDate(e.ts))}</td><td>${D.esc(e.login || e.userId)}</td><td class="mono">${D.esc(e.model)}</td><td>${outcomeBadge(e.outcome)}</td><td class="num">${D.nf.format(e.tokens || 0)}</td><td class="num">${Number.isFinite(e.latencyMs) ? D.nf.format(e.latencyMs) + " ms" : "—"}</td><td class="muted">${D.esc(e.reason || "")}</td></tr>`
          )
          .join("")
      : '<tr><td class="empty" colspan="7">Nessun evento</td></tr>'}</tbody>`;
  D.$("#eventCount").textContent = `${D.nf.format(data.length)} eventi mostrati`;
  D.$("#eventPager").innerHTML = nextBefore
    ? `<button type="button" id="moreEvents">Carica altri</button>`
    : data.length ? '<span class="status">Fine del log</span>' : "";
  const more = D.$("#moreEvents");
  if (more) more.onclick = () => D.loadEvents(false);
};

D.$("#eventSearch").oninput = D.debounce((e) => {
  D.eventQuery.q = e.target.value.trim();
  D.loadEvents(true);
});
D.$("#eventFilter").onchange = (e) => {
  D.eventQuery.outcome = e.target.value;
  D.loadEvents(true);
};

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
      : '<tr><td class="empty" colspan="7">Nessuna regola</td></tr>'}</tbody>`;
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
D.$("#refreshBtn").onclick = () => {
  D.eventsPaged = false;
  D.loadAll();
};
D.$("#autoRefresh").onchange = () => D.setAuto();
D.$("#daysSel").onchange = (e) => {
  D.days = Number(e.target.value);
  D.loadAll();
};
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
