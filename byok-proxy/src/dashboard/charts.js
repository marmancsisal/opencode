// KPI, grafici SVG (barre giornaliere) con hover+tooltip, e tabelle di testa.
"use strict";

D.renderKpis = function renderKpis() {
  const o = D.state.overview;
  const u = o.usage || { requests: 0, allowed: 0, blocked: 0, errors: 0, tokens: 0 };
  const lat = D.state.events.filter((e) => e.outcome === "allowed" && Number.isFinite(e.latencyMs));
  const avgLat = lat.length ? Math.round(lat.reduce((s, e) => s + e.latencyMs, 0) / lat.length) : null;
  const kpis = [
    { label: "Richieste totali", value: D.nf.format(u.requests), hint: `${D.pct(u.allowed, u.requests)} consentite` },
    { label: "Token consumati", value: D.nfc.format(u.tokens), hint: "prompt + risposta" },
    { label: "Bloccate", value: D.nf.format(u.blocked), hint: `${D.pct(u.blocked, u.requests)} del totale` },
    { label: "Errori upstream", value: D.nf.format(u.errors), hint: `${D.pct(u.errors, u.requests)} del totale` },
    { label: "Clienti attivi", value: `${o.clients.enabled}/${o.clients.total}`, hint: `${o.clients.withToken} con token` },
    { label: "Latenza media", value: avgLat == null ? "—" : `${D.nf.format(avgLat)} ms`, hint: "richieste riuscite" },
  ];
  D.$("#kpis").innerHTML = kpis
    .map((k) => `<div class="card kpi"><div class="label">${k.label}</div><div class="value">${k.value}</div><div class="hint">${k.hint}</div></div>`)
    .join("");
};

// Grafico a barre impilate (consentite/bloccate) oppure singola serie (token).
function barChart(el, data, { series, fmt }) {
  if (!data.length || data.every((d) => series.every((s) => !d[s.key]))) {
    el.innerHTML = '<div class="empty">Nessun dato nel periodo</div>';
    return;
  }
  const max = Math.max(1, ...data.map((d) => series.reduce((s, ser) => s + (d[ser.key] || 0), 0)));
  const W = 1000, H = 200, padB = 24, padT = 8, padL = 4;
  const n = data.length;
  const gap = n > 40 ? 1 : 2;
  const bw = (W - padL) / n;
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = 4;

  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Grafico a barre">`;
  for (let i = 0; i <= ticks; i++) {
    const v = (max / ticks) * i;
    const yy = y(v);
    svg += `<line class="gridline" x1="0" y1="${yy.toFixed(1)}" x2="${W}" y2="${yy.toFixed(1)}"/>`;
    svg += `<text class="axis" x="0" y="${(yy - 3).toFixed(1)}">${D.nfc.format(Math.round(v))}</text>`;
  }
  const labelEvery = Math.ceil(n / 8);
  data.forEach((d, i) => {
    const x = padL + i * bw;
    let yTop = H - padB;
    series.forEach((ser) => {
      const v = d[ser.key] || 0;
      if (v > 0) {
        const h = (H - padT - padB) * (v / max);
        const yy = yTop - h;
        svg += `<rect class="${ser.cls}" x="${(x + gap / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${(bw - gap).toFixed(1)}" height="${Math.max(0, h - 1).toFixed(1)}" rx="2"/>`;
        yTop = yy;
      }
    });
    if (i % labelEvery === 0) {
      svg += `<text class="axis" x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${D.esc(D.fmtDay(d.day))}</text>`;
    }
    // zona di hover a tutta altezza
    svg += `<rect class="hit" data-i="${i}" x="${x.toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${H}"></rect>`;
  });
  svg += `</svg>`;
  el.innerHTML = svg;

  const tip = D.$("#tip");
  const hits = D.$$(".hit", el);
  const onMove = (ev) => {
    const target = ev.target.closest(".hit");
    if (!target) return;
    hits.forEach((h) => h.classList.toggle("on", h === target));
    const d = data[Number(target.dataset.i)];
    tip.innerHTML =
      `<b>${D.esc(d.day)}</b>` +
      series.map((s) => `<div class="row"><span><i style="--c:var(${s.color})"></i>${s.label}</span><span>${fmt(d[s.key] || 0)}</span></div>`).join("");
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + 14, yy = ev.clientY + 14;
    if (x + r.width > innerWidth) x = ev.clientX - r.width - 14;
    if (yy + r.height > innerHeight) yy = ev.clientY - r.height - 14;
    tip.style.left = `${x}px`;
    tip.style.top = `${yy}px`;
  };
  el.onmousemove = onMove;
  el.onmouseleave = () => { tip.hidden = true; hits.forEach((h) => h.classList.remove("on")); };
};

D.renderCharts = function renderCharts() {
  if (!D.state.usage) return;
  const byDay = D.state.usage.byDay;
  D.$("#reqSub").textContent = `Ultimi ${D.days} giorni`;
  barChart(D.$("#reqChart"), byDay, {
    fmt: (v) => D.nf.format(v),
    series: [
      { key: "allowed", cls: "s1", color: "--series-1", label: "Consentite" },
      { key: "blocked", cls: "s2", color: "--series-2", label: "Bloccate" },
    ],
  });
  barChart(D.$("#tokChart"), byDay, {
    fmt: (v) => D.nf.format(v),
    series: [{ key: "tokens", cls: "s1", color: "--series-1", label: "Token" }],
  });
  D.renderChartTable("reqChartTable", byDay, [
    { key: "day", label: "Giorno" },
    { key: "allowed", label: "Consentite", num: true },
    { key: "blocked", label: "Bloccate", num: true },
    { key: "errors", label: "Errori", num: true },
  ]);
  D.renderChartTable("tokChartTable", byDay, [
    { key: "day", label: "Giorno" },
    { key: "tokens", label: "Token", num: true },
    { key: "requests", label: "Richieste", num: true },
  ]);
};

D.renderChartTable = function renderChartTable(id, rows, cols) {
  const el = D.$(`#${id}`);
  if (!el) return;
  el.innerHTML =
    `<table><thead><tr>${cols.map((c) => `<th class="${c.num ? "num" : ""}">${c.label}</th>`).join("")}</tr></thead>` +
    `<tbody>${[...rows].reverse().map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.num ? D.nf.format(r[c.key] || 0) : D.esc(r[c.key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
};

D.renderTop = function renderTop() {
  const clients = [...D.state.clients]
    .filter((c) => c.usage && c.usage.requests)
    .sort((a, b) => b.usage.requests - a.usage.requests)
    .slice(0, 8);
  const maxC = Math.max(1, ...clients.map((c) => c.usage.requests));
  D.$("#topClients").innerHTML = clients.length
    ? `<thead><tr><th>Cliente</th><th class="num">Richieste</th><th class="num">Token</th><th>Quota</th></tr></thead><tbody>${clients
        .map(
          (c) => `<tr><td>${D.esc(c.login)}</td><td class="num">${D.nf.format(c.usage.requests)}</td><td class="num">${D.nfc.format(c.usage.tokens)}</td>
          <td><div class="inline-bar"><div class="track"><div class="fill" style="width:${((c.usage.requests / maxC) * 100).toFixed(0)}%"></div></div></div></td></tr>`
        )
        .join("")}</tbody>`
    : '<tbody><tr><td class="empty">Nessun utilizzo ancora</td></tr></tbody>';

  const models = [...(D.state.usage?.byModel || [])].slice(0, 8);
  const maxM = Math.max(1, ...models.map((m) => m.requests));
  D.$("#topModels").innerHTML = models.length
    ? `<thead><tr><th>Modello</th><th class="num">Richieste</th><th class="num">Token</th><th>Quota</th></tr></thead><tbody>${models
        .map(
          (m) => `<tr><td class="mono">${D.esc(m.model)}</td><td class="num">${D.nf.format(m.requests)}</td><td class="num">${D.nfc.format(m.tokens)}</td>
          <td><div class="inline-bar"><div class="track"><div class="fill" style="width:${((m.requests / maxM) * 100).toFixed(0)}%"></div></div></div></td></tr>`
        )
        .join("")}</tbody>`
    : '<tbody><tr><td class="empty">Nessun utilizzo ancora</td></tr></tbody>';
};

// Toggle grafico/tabella accessibile.
D.$$("[data-table-toggle]").forEach((btn) => {
  btn.onclick = () => {
    const chart = D.$(`#${btn.dataset.tableToggle}`);
    const table = D.$(`#${btn.dataset.tableToggle}Table`);
    const showTable = table.hidden;
    table.hidden = !showTable;
    chart.hidden = showTable;
    btn.textContent = showTable ? "Grafico" : "Tabella";
  };
});
