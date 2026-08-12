/**
 * CAAO Control — admin dashboard client.
 *
 * No framework, no build step, no dependency. Everything rendered here comes
 * from the read-only API; every interpolated value goes through esc() because
 * run requests, repository names and model ids are attacker-influenced strings
 * in a company with many contributors.
 */

const state = {
  view: "overview",
  repo: "",
  live: true,
  data: null,
  drawer: null,
  tab: "graph",
  timer: null,
  csrfToken: null,
}

const el = (id) => document.getElementById(id)
const view = el("view")

/* ---------------- helpers ---------------- */

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

/** Minimal, safe subset of markdown used by the rationale strings: **bold**, `code`. */
function inline(text) {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(state.csrfToken && options.method && options.method !== "GET" ? { "x-caao-csrf": state.csrfToken } : {}),
      ...(options.headers ?? {}),
    },
  })
  if (res.status === 401 && path !== "/api/session") {
    location.reload()
    throw new Error("session expired")
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText)
  return res.json()
}

const money = (value, currency = "USD") =>
  `${currency === "USD" ? "$" : ""}${Number(value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  })}${currency === "USD" ? "" : ` ${currency}`}`

const num = (value) => Number(value ?? 0).toLocaleString()

/** Provider ids look like "omniroute/anthropic/claude-opus-5"; only the tail is informative. */
function shortModel(model) {
  if (!model) return "unassigned"
  const tail = String(model).split("/").pop()
  return tail.length > 28 ? `${tail.slice(0, 27)}…` : tail
}

function tokens(value) {
  const n = Number(value ?? 0)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function duration(ms) {
  if (!ms && ms !== 0) return "—"
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

function ago(iso) {
  const diff = Date.now() - Date.parse(iso)
  if (Number.isNaN(diff)) return "—"
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const STATUS_CLASS = { done: "ok", running: "run", failed: "over", needs_human: "warn", executing: "run", planned: "", pending: "", stale: "warn" }

function statusPill(status) {
  return `<span class="pill ${STATUS_CLASS[status] ?? ""}">${esc(String(status).replace("_", " "))}</span>`
}

function budgetPill(budget, currency) {
  if (!budget || budget.state === "none") return `<span class="pill">no limit</span>`
  const share = budget.limit > 0 ? Math.round((budget.used / budget.limit) * 100) : 0
  return `<span class="pill ${budget.state}">${share}% of ${money(budget.limit, currency)}</span>`
}

function bar(used, limit, cls) {
  const share = limit > 0 ? Math.min(100, (used / limit) * 100) : 0
  return `<div class="bar ${cls ?? ""}"><i style="width:${share.toFixed(1)}%"></i></div>`
}

function table(headers, rows, { clickable = false } = {}) {
  if (rows.length === 0) return `<div class="empty">Nothing recorded yet.</div>`
  return `<div class="card" style="padding:4px 6px"><table>
    <thead><tr>${headers.map((h) => `<th class="${h.num ? "num" : ""}">${esc(h.label ?? h)}</th>`).join("")}</tr></thead>
    <tbody>${rows
      .map(
        (row) =>
          `<tr class="${clickable ? "clickable" : ""}"${row.id ? ` data-run="${esc(row.id)}"` : ""}>${row.cells
            .map((cell, index) => `<td class="${headers[index]?.num ? "num" : ""}">${cell}</td>`)
            .join("")}</tr>`,
      )
      .join("")}</tbody></table></div>`
}

/* ---------------- views ---------------- */

const TITLES = {
  overview: ["Overview", "Company-wide orchestration activity."],
  runs: ["Runs", "Every request, its DAG progress and the models executing it."],
  costs: ["Costs", "Where the token budget is actually going."],
  repos: ["Repositories", "Spend and activity segmented by GitHub repository."],
  models: ["Models & routing", "Which capability is bound to which model, and what it costs."],
  catalog: ["MCP & skills", "Centrally declared capabilities distributed to every developer."],
}

function renderOverview(data) {
  const c = data.currency
  const peak = Math.max(1, ...data.daily.map((d) => d.cost))

  const kpis = `
    <div class="grid cols-4">
      <div class="card kpi"><h3>Month to date</h3><b>${money(data.totals.monthToDate, c)}</b>
        <small>${budgetPill(data.budget.month, c)}</small>
        <div style="margin-top:10px">${bar(data.budget.monthToDate, data.budget.monthlyTotal, data.budget.month.state)}</div>
      </div>
      <div class="card kpi"><h3>Runs</h3><b>${num(data.totals.runs)}</b><small>${num(data.totals.active)} active right now</small></div>
      <div class="card kpi"><h3>Tasks executed</h3><b>${num(data.totals.nodes)}</b><small>${num(data.totals.attempts)} model attempts · ${num(
        data.totals.escalations,
      )} escalations</small></div>
      <div class="card kpi"><h3>Avg cost / run</h3><b>${money(data.totals.avgCostPerRun, c)}</b><small>${tokens(
        data.totals.avgTokensPerRun,
      )} tokens / run</small></div>
    </div>
    <div class="grid cols-4">
      <div class="card kpi"><h3>Input tokens</h3><b>${tokens(data.totals.inputTokens)}</b><small>${tokens(
        data.totals.cachedTokens,
      )} served from cache</small></div>
      <div class="card kpi"><h3>Output tokens</h3><b>${tokens(data.totals.outputTokens)}</b><small>${tokens(
        data.totals.tokens,
      )} in total</small></div>
      <div class="card kpi"><h3>Orchestration overhead</h3><b>${money(data.totals.orchestratorCost, c)}</b><small>${tokens(
        data.totals.orchestratorTokens,
      )} tokens the manager spent on itself</small></div>
      <div class="card kpi"><h3>Tokens saved</h3><b>${tokens(data.totals.tokensSaved)}</b><small>${
        data.totals.tokensSaved > 0 ? `${money(data.totals.costSaved, c)} not spent · compression MCPs` : "no compression tool reported yet"
      }</small></div>
    </div>`

  const active = data.runs.filter((run) => run.active).slice(0, 6)
  const activeCard = `
    <div class="section-head"><h2>In flight</h2><span class="muted">${active.length} run(s) executing</span></div>
    ${
      active.length === 0
        ? `<div class="empty">No run is currently executing.</div>`
        : table(
            [{ label: "Request" }, { label: "Repo" }, { label: "Progress" }, { label: "Models" }, { label: "Cost", num: true }],
            active.map((run) => ({
              id: run.id,
              cells: [
                `<div class="stack"><span>${esc(run.request.slice(0, 78))}</span><span class="muted mono">${esc(run.id)}</span></div>`,
                `<span class="tag">${esc(run.project)}</span>`,
                `<div class="progress-mini">${bar(run.done, run.nodes, "ok")}<span class="mono">${run.done}/${run.nodes}</span>${
                  run.running > 0 ? `<span class="pill run">${run.running} running</span>` : ""
                }</div>`,
                run.models.map((m) => `<span class="tag" title="${esc(m)}">${esc(shortModel(m))}</span>`).join(" ") || "—",
                money(run.cost, c),
              ],
            })),
            { clickable: true },
          )
    }`

  const spark = `
    <div class="card">
      <h3>Daily spend · last ${data.daily.length} days</h3>
      <div class="spark">${data.daily
        .map((d) => `<i class="${d.cost >= peak * 0.6 ? "hot" : ""}" style="height:${Math.max(2, (d.cost / peak) * 100)}%" title="${esc(d.key)}: ${money(d.cost, c)}"></i>`)
        .join("")}</div>
      <div class="row muted mono" style="margin-top:8px"><span>${esc(data.daily[0]?.key ?? "")}</span><span class="right">${esc(
        data.daily.at(-1)?.key ?? "",
      )}</span></div>
    </div>`

  const topRepos = `
    <div class="card">
      <h3>Spend by repository</h3>
      ${
        data.repos.length === 0
          ? `<p class="muted">No attributed runs yet.</p>`
          : data.repos
              .slice(0, 6)
              .map(
                (repo) => `<div style="margin-bottom:12px">
                  <div class="row"><span class="tag">${esc(repo.key)}</span><span class="right mono">${money(repo.cost, c)}</span></div>
                  <div style="margin-top:6px">${bar(repo.cost, data.budget.perRepoMonthly, repo.budget.state)}</div>
                </div>`,
              )
              .join("")
      }
    </div>`

  const recent = table(
    [{ label: "Request" }, { label: "Repo" }, { label: "Status" }, { label: "Waves", num: true }, { label: "Cost", num: true }, { label: "When" }],
    data.runs.slice(0, 12).map((run) => ({
      id: run.id,
      cells: [
        `<div class="stack"><span>${esc(run.request.slice(0, 70))}</span><span class="muted mono">${esc(run.intent ?? "")} · ${esc(
          run.complexity ?? "",
        )}</span></div>`,
        `<span class="tag">${esc(run.project)}</span>`,
        statusPill(run.status),
        String(run.waves),
        money(run.cost, c),
        `<span class="muted">${ago(run.createdAt)}</span>`,
      ],
    })),
    { clickable: true },
  )

  return `${kpis}
    ${activeCard}
    <div class="section-head"><h2>Trend</h2></div>
    <div class="grid cols-2">${spark}${topRepos}</div>
    <div class="section-head"><h2>Recent runs</h2><span class="muted">click a row for the DAG and its rationale</span></div>
    ${recent}`
}

function renderRuns(data) {
  const c = data.currency
  return `
    <div class="section-head"><h2>${data.runs.length} run(s)${state.repo ? ` in ${esc(state.repo)}` : ""}</h2>
      <span class="muted">click a row to open the live DAG</span></div>
    ${table(
      [
        { label: "Request" },
        { label: "Repo / branch" },
        { label: "Actor" },
        { label: "Status" },
        { label: "Progress" },
        { label: "Models" },
        { label: "Input", num: true },
        { label: "Output", num: true },
        { label: "Saved", num: true },
        { label: "Cost", num: true },
        { label: "When" },
      ],
      data.runs.map((run) => ({
        id: run.id,
        cells: [
          `<div class="stack"><span>${esc(run.request.slice(0, 64))}</span><span class="muted mono">${esc(run.strategy ?? "")} · ${esc(
            run.understanding ?? "",
          )}</span></div>`,
          `<div class="stack"><span class="tag">${esc(run.project)}</span><span class="muted mono">${esc(run.branch ?? "—")}</span></div>`,
          `<span class="muted">${esc(run.actor ?? "—")}</span>`,
          statusPill(run.status),
          `<div class="progress-mini">${bar(run.done, run.nodes, run.failed > 0 ? "over" : "ok")}<span class="mono">${run.done}/${run.nodes}</span></div>`,
          run.models.map((m) => `<span class="tag" title="${esc(m)}">${esc(shortModel(m))}</span>`).join(" ") || "—",
          tokens(run.inputTokens),
          tokens(run.outputTokens),
          run.tokensSaved > 0 ? `<span class="pill ok">${tokens(run.tokensSaved)}</span>` : `<span class="muted">—</span>`,
          money(run.cost, c),
          `<span class="muted">${ago(run.createdAt)}</span>`,
        ],
      })),
      { clickable: true },
    )}`
}

function renderCosts(data) {
  const c = data.currency
  const b = data.budget

  const budgets = `
    <div class="grid cols-4">
      <div class="card kpi"><h3>Monthly budget</h3><b>${money(b.monthToDate, c)}</b>
        <small>of ${money(b.monthlyTotal, c)} · warn at ${Math.round(b.warnAt * 100)}%</small>
        <div style="margin-top:10px">${bar(b.monthToDate, b.monthlyTotal, b.month.state)}</div></div>
      <div class="card kpi"><h3>Per-repo ceiling</h3><b>${money(b.perRepoMonthly, c)}</b><small>${
        data.repos.filter((r) => r.budget.state === "over").length
      } repo(s) over · ${data.repos.filter((r) => r.budget.state === "warn").length} warning</small></div>
      <div class="card kpi"><h3>Per-run ceiling</h3><b>${money(b.perRun, c)}</b><small>observational — runs are never refused</small></div>
      <div class="card kpi"><h3>Total tokens</h3><b>${tokens(data.totals.tokens)}</b><small>${
        data.totals.metered ? "metered from provider usage" : "no usage reported yet"
      }</small></div>
    </div>
    <div class="grid cols-4">
      <div class="card kpi"><h3>Input tokens</h3><b>${tokens(data.totals.inputTokens)}</b><small>${tokens(
        data.totals.cachedTokens,
      )} read from cache</small></div>
      <div class="card kpi"><h3>Output tokens</h3><b>${tokens(data.totals.outputTokens)}</b><small>generation is the expensive half</small></div>
      <div class="card kpi"><h3>Task vs orchestration</h3><b>${money(data.totals.cost - data.totals.orchestratorCost, c)}</b><small>${money(
        data.totals.orchestratorCost,
        c,
      )} spent planning and dispatching</small></div>
      <div class="card kpi"><h3>Tokens saved</h3><b>${tokens(data.totals.tokensSaved)}</b><small>${money(
        data.totals.costSaved,
        c,
      )} avoided by context tools</small></div>
    </div>`

  const byModel = table(
    [{ label: "Model" }, { label: "Tier" }, { label: "Calls", num: true }, { label: "Input", num: true }, { label: "Output", num: true }, { label: "Escalated", num: true }, { label: "Cost", num: true }],
    data.models.map((model) => ({
      cells: [
        `<span class="tag" title="${esc(model.model)}">${esc(shortModel(model.model))}</span>`,
        `<span class="pill">${esc(model.tier ?? "—")}</span>`,
        num(model.calls),
        tokens(model.inputTokens),
        tokens(model.outputTokens),
        num(model.escalations),
        money(model.cost, c),
      ],
    })),
  )

  const byCapability = table(
    [
      { label: "Capability" },
      { label: "Phase" },
      { label: "Tasks", num: true },
      { label: "Retries", num: true },
      { label: "Input", num: true },
      { label: "Output", num: true },
      { label: "Time", num: true },
      { label: "Cost", num: true },
    ],
    data.capabilities.map((cap) => ({
      cells: [
        `<span>${esc(cap.title ?? cap.key)}</span>`,
        `<span class="pill">${esc(cap.phase ?? "—")}</span>`,
        num(cap.calls),
        num(cap.retries),
        tokens(cap.inputTokens),
        tokens(cap.outputTokens),
        duration(cap.durationMs),
        money(cap.cost, c),
      ],
    })),
  )

  // Compression and retrieval MCPs are only worth their complexity if they pay
  // for themselves. These are the numbers the tools published — nothing here is
  // an estimate, and calls that reported nothing are shown as exactly that.
  const savings = (data.contextTools ?? []).length === 0
    ? `<div class="empty">No context tool has reported a saving yet. Install them with <code>npm run caao:catalog</code> and check <code>npm run caao:doctor</code>.</div>`
    : table(
        [
          { label: "Tool" },
          { label: "Calls", num: true },
          { label: "Reported", num: true },
          { label: "Before", num: true },
          { label: "After", num: true },
          { label: "Saved", num: true },
          { label: "Cut", num: true },
          { label: "Cost avoided", num: true },
        ],
        data.contextTools.map((tool) => ({
          cells: [
            `<div class="stack"><span class="tag">${esc(tool.key)}</span><span class="muted mono">${esc(
              (tool.tools ?? []).join(", ") || "—",
            )}</span></div>`,
            num(tool.calls),
            tool.unreportedCalls > 0
              ? `<span class="pill warn" title="${num(tool.unreportedCalls)} call(s) published no token count">${num(tool.reportedCalls)}</span>`
              : num(tool.reportedCalls),
            tokens(tool.tokensBefore),
            tokens(tool.tokensAfter),
            tokens(tool.tokensSaved),
            tool.ratio > 0 ? `${Math.round(tool.ratio * 100)}%` : `<span class="muted">—</span>`,
            money(tool.costSaved, c),
          ],
        })),
      )

  const byActor = table(
    [{ label: "Developer" }, { label: "Runs", num: true }, { label: "Tasks", num: true }, { label: "Cost", num: true }],
    data.actors.map((actor) => ({ cells: [esc(actor.key), num(actor.runs), num(actor.nodes), money(actor.cost, c)] })),
  )

  const prices = table(
    [{ label: "Pool" }, { label: "Model" }, { label: "Tier" }, { label: "Input / Mtok", num: true }, { label: "Output / Mtok", num: true }],
    (data.prices ?? []).map((price) => ({
      cells: [
        `<span class="tag">${esc(price.pool)}</span>`,
        esc(shortModel(price.model)),
        `<span class="pill">${esc(price.tier ?? "—")}</span>`,
        price.priced ? money(price.inputPerMTok, c) : `<span class="muted">unpriced</span>`,
        price.priced ? money(price.outputPerMTok, c) : `<span class="muted">unpriced</span>`,
      ],
    })),
  )

  return `${budgets}
    <div class="section-head"><h2>By model</h2></div>${byModel}
    <div class="section-head"><h2>By capability</h2><span class="muted">this is where a phase is worth optimising</span></div>${byCapability}
    <div class="section-head"><h2>Context tools — tokens saved</h2><span class="muted">self-reported by the tool; never estimated</span></div>${savings}
    <div class="section-head"><h2>By developer</h2></div>${byActor}
    <div class="section-head"><h2>Price list</h2><span class="muted">declared in providers.yaml — billing only, never used for routing</span></div>${prices}`
}

function renderRepos(data) {
  const c = data.currency
  return `
    <div class="section-head"><h2>${data.repos.length} repository bucket(s)</h2>
      <span class="muted">derived from the git remote of each run</span></div>
    ${table(
      [{ label: "Repository" }, { label: "Runs", num: true }, { label: "Active", num: true }, { label: "Tasks", num: true }, { label: "Failed", num: true }, { label: "Budget" }, { label: "Cost", num: true }],
      data.repos.map((repo) => ({
        cells: [
          `<span class="tag">${esc(repo.key)}</span>`,
          num(repo.runs),
          repo.active > 0 ? `<span class="pill run">${repo.active}</span>` : "0",
          num(repo.nodes),
          repo.failed > 0 ? `<span class="pill over">${repo.failed}</span>` : "0",
          `<div style="min-width:120px">${budgetPill(repo.budget, c)}${bar(repo.cost, data.budget.perRepoMonthly, repo.budget.state)}</div>`,
          money(repo.cost, c),
        ],
      })),
    )}`
}

function renderModels(payload) {
  const pools = table(
    [{ label: "Pool" }, { label: "Model" }, { label: "Tier" }, { label: "Input / Mtok", num: true }, { label: "Output / Mtok", num: true }],
    payload.pools.map((pool) => ({
      cells: [
        `<span class="tag">${esc(pool.pool)}</span>`,
        esc(shortModel(pool.model)),
        `<span class="pill">${esc(pool.tier ?? "—")}</span>`,
        pool.priced ? money(pool.inputPerMTok) : `<span class="muted">unpriced</span>`,
        pool.priced ? money(pool.outputPerMTok) : `<span class="muted">unpriced</span>`,
      ],
    })),
  )

  const routing = table(
    [{ label: "Capability" }, { label: "Strategy" }, { label: "Default model" }, { label: "Fallbacks" }, { label: "Escalation rules" }],
    payload.routing.map((row) => ({
      cells: [
        `<span>${esc(row.capability)}</span>`,
        `<span class="pill">${esc(row.strategy)}</span>`,
        `<div class="stack"><span class="tag" title="${esc(row.selected ?? "")}">${esc(shortModel(row.selected))}</span><span class="muted mono">${esc(row.tier ?? "")}</span></div>`,
        (row.fallbacks ?? []).map((candidate) => `<span class="tag" title="${esc(candidate)}">${esc(shortModel(candidate))}</span>`).join(" ") || `<span class="muted">none</span>`,
        (row.escalations ?? [])
          .map((rule) => `<div class="muted mono" style="font-size:11px">${esc(rule.when)} → ${esc(rule.to)}</div>`)
          .join("") || `<span class="muted">—</span>`,
      ],
    })),
  )

  return `<div class="callout">Model selection is declarative: a capability is bound to a <strong>profile</strong>, and a profile ranks pools by
    a strategy such as <code>highest_reasoning</code> or <code>cheapest</code>. Prices below are for billing only — the router
    ranks candidates with the abstract <code>traits.cost</code> score, never with dollars.</div>
    <div class="section-head"><h2>Pools</h2></div>${pools}
    <div class="section-head"><h2>Capability → model bindings</h2></div>${routing}`
}

function renderCatalog(payload) {
  const diagnostics = payload.diagnostics ?? { checks: [], skipped: [], totals: {} }
  const checkOf = new Map((diagnostics.checks ?? []).map((check) => [check.id, check]))
  const savedBy = new Map((payload.savings ?? []).map((tool) => [tool.key, tool]))

  // "Declared" and "working" are different things. The catalog used to show only
  // the first, which is how five MCP servers could be configured and none of
  // them running.
  const health = (item) => {
    const check = checkOf.get(item.id)
    if (!check) return item.enabled ? `<span class="pill warn" title="out of scope for this machine">not applied here</span>` : ""
    const label = { ok: "working", broken: "not usable" }[check.status] ?? check.status
    const cls = check.status === "ok" ? "ok" : "over"
    return `<span class="pill ${cls}" title="${esc((check.problems ?? []).join("; ") || "binary found, environment set, wired into opencode.json")}">${esc(label)}</span>`
  }

  const troubles = (item) => {
    const check = checkOf.get(item.id)
    if (!check || check.status === "ok") return ""
    return `<div class="callout warn" style="margin:10px 0 0">
      <ul style="margin:0;padding-left:18px">${(check.problems ?? []).map((line) => `<li>${esc(line)}</li>`).join("")}</ul>
      ${check.install ? `<div class="mono muted" style="margin-top:6px">install: ${esc(check.install)}</div>` : ""}
      ${check.setup ? `<div class="mono muted">setup: ${esc(check.setup)}</div>` : ""}
    </div>`
  }

  const saved = (item) => {
    const tool = savedBy.get(item.id)
    if (!tool || tool.tokensSaved <= 0) return ""
    return `<span class="pill ok" title="${num(tool.reportedCalls)} of ${num(tool.calls)} calls reported a number">saved ${tokens(
      tool.tokensSaved,
    )} tokens · ${money(tool.costSaved)}</span>`
  }

  const entry = (item, kind) => `
    <div class="card catalog-entry">
      <div class="row">
        <strong>${esc(item.title ?? item.id)}</strong>
        <span class="tag">${esc(item.id)}</span>
        ${item.version ? `<span class="pill">v${esc(item.version)}</span>` : ""}
        ${item.enabled ? `<span class="pill ok">enabled</span>` : `<span class="pill warn">disabled</span>`}
        ${item.enabled ? health(item) : ""}
        ${saved(item)}
        <span class="right muted mono">${esc(item.owner ?? "unowned")}</span>
        <button class="ghost compact" data-toggle-kind="${esc(kind)}" data-toggle-id="${esc(item.id)}" data-enabled="${item.enabled}">
          ${item.enabled ? "Disable" : "Enable"}
        </button>
      </div>
      <p class="muted" style="margin:8px 0 6px">${esc(item.description ?? "")}</p>
      <div class="row">
        <span class="pill">${esc(item.scopeLabel)}</span>
        ${kind === "mcp" ? `<span class="pill">${esc(item.kind)}</span>` : ""}
        ${kind === "context_tools" ? `<span class="pill">${esc(item.category)}</span><span class="pill">${esc(item.mode ?? "managed")}</span>` : ""}
        ${(item.capabilities ?? []).map((cap) => `<span class="tag">${esc(cap)}</span>`).join(" ")}
        ${(item.requiredEnv ?? []).map((env) => `<span class="tag">env:${esc(env)}</span>`).join(" ")}
      </div>
      ${troubles(item)}
      ${item.notes ? `<div class="callout" style="margin:10px 0 0">${esc(item.notes)}</div>` : ""}
    </div>`

  return `<div class="callout">Declared once in <code>catalog.yaml</code>, distributed to every developer machine.
    A machine receives an entry when it is enabled <em>and</em> its scope matches the repository being worked on or the developer's team.
    ${payload.mutationsEnabled ? "" : "Toggling is disabled — start the server with <code>CAAO_DASHBOARD_TOKEN</code> to enable it."}</div>
    <form id="catalog-add" class="card catalog-form">
      <div class="section-head"><h2>Add company tool</h2><span class="muted">Signed configuration · no inline secrets</span></div>
      <div class="form-grid">
        <label class="field"><span>Type</span><select name="kind"><option value="mcp">MCP server</option><option value="skills">Skill</option><option value="context_tools">Context tool</option></select></label>
        <label class="field"><span>ID</span><input name="id" type="text" pattern="[a-z0-9][a-z0-9._-]{0,63}" required placeholder="company-docs" /></label>
        <label class="field"><span>Title</span><input name="title" type="text" required placeholder="Company docs" /></label>
        <label class="field"><span>Owner</span><input name="owner" type="text" required placeholder="platform-team" /></label>
        <label class="field span-2"><span>Description</span><input name="description" type="text" required placeholder="What developers receive and why" /></label>
        <label class="field"><span>Integration</span><select name="integration"><option value="local">Local command</option><option value="remote">Remote HTTPS</option><option value="skill">Skill file</option><option value="compression">Compression tool</option><option value="knowledge_graph">Knowledge graph</option></select></label>
        <label class="field span-2"><span>Command, HTTPS URL, or skill path</span><input name="target" type="text" required placeholder="npx -y @company/mcp-docs" /></label>
      </div>
      <div class="row"><button class="primary" type="submit">Add to company catalog</button><span class="muted" id="catalog-message"></span></div>
    </form>
    <div class="grid cols-4" style="margin-bottom:8px">
      <div class="card kpi"><h3>MCP servers</h3><b>${payload.totals.mcpEnabled}/${payload.totals.mcp}</b><small>enabled</small></div>
      <div class="card kpi"><h3>Skills</h3><b>${payload.totals.skillsEnabled}/${payload.totals.skills}</b><small>enabled</small></div>
      <div class="card kpi"><h3>Context tools</h3><b>${payload.totals.contextToolsEnabled}/${payload.totals.contextTools}</b><small>compression + repo graph</small></div>
      <div class="card kpi"><h3>Usable on this machine</h3><b>${num(diagnostics.totals?.ok ?? 0)}/${num(
        diagnostics.totals?.checked ?? 0,
      )}</b><small>${
        (diagnostics.totals?.broken ?? 0) > 0
          ? `${num(diagnostics.totals.broken)} declared but not startable`
          : "every applicable tool can start"
      }</small></div>
    </div>
    <div class="section-head"><h2>Context infrastructure</h2><span class="muted">Disable any layer without deleting its configuration.</span></div>${payload.contextTools.map((item) => entry(item, "context_tools")).join("")}
    <div class="section-head"><h2>MCP servers</h2></div>${payload.mcp.map((item) => entry(item, "mcp")).join("")}
    <div class="section-head"><h2>Skills</h2></div>${payload.skills.map((item) => entry(item, "skills")).join("")}`
}

function catalogEntryFrom(form) {
  const data = Object.fromEntries(new FormData(form))
  const base = { id: data.id, title: data.title, owner: data.owner, description: data.description, scope: "all", enabled: true }
  if (data.kind === "skills") return { kind: data.kind, entry: { ...base, file: data.target } }
  const remote = data.integration === "remote"
  const mcp = remote ? { kind: "remote", url: data.target } : { kind: "local", command: data.target.trim().split(/\s+/) }
  if (data.kind === "context_tools") return { kind: data.kind, entry: { ...base, category: data.integration === "knowledge_graph" ? "knowledge_graph" : "compression", mcp } }
  return { kind: data.kind, entry: { ...base, ...mcp } }
}

async function bindCatalogActions() {
  view.querySelectorAll("[data-toggle-kind]").forEach((button) => button.addEventListener("click", async () => {
    button.disabled = true
    try {
      await api(`/api/catalog/${encodeURIComponent(button.dataset.toggleKind)}/${encodeURIComponent(button.dataset.toggleId)}/toggle`, {
        method: "POST",
        body: JSON.stringify({ enabled: button.dataset.enabled !== "true" }),
      })
      await render()
    } catch (error) {
      button.disabled = false
      alert(error.message)
    }
  }))
  el("catalog-add")?.addEventListener("submit", async (event) => {
    event.preventDefault()
    const message = el("catalog-message")
    try {
      const { kind, entry } = catalogEntryFrom(event.currentTarget)
      await api(`/api/catalog/${kind}`, { method: "POST", body: JSON.stringify(entry) })
      event.currentTarget.reset()
      await render()
    } catch (error) {
      message.textContent = error.message
    }
  })
}

/* ---------------- DAG rendering ---------------- */

const NODE_W = 190
const NODE_H = 62
const GAP_X = 70
const GAP_Y = 20

const NODE_COLOR = {
  done: { fill: "rgba(63,191,143,0.14)", stroke: "#3fbf8f" },
  running: { fill: "rgba(109,139,255,0.18)", stroke: "#6d8bff" },
  failed: { fill: "rgba(239,106,106,0.15)", stroke: "#ef6a6a" },
  stale: { fill: "rgba(230,180,81,0.14)", stroke: "#e6b451" },
  pending: { fill: "#14171f", stroke: "#333a4c" },
  expanded: { fill: "#14171f", stroke: "#2a3040" },
}

function renderDag(graph) {
  const waves = graph.waves.filter((wave) => wave.nodes.length > 0)
  if (waves.length === 0) return `<div class="empty">This run has no graph yet.</div>`

  const positions = new Map()
  const tallest = Math.max(...waves.map((wave) => wave.nodes.length))
  waves.forEach((wave, column) => {
    const offset = ((tallest - wave.nodes.length) * (NODE_H + GAP_Y)) / 2
    wave.nodes.forEach((id, row) => {
      positions.set(id, { x: 20 + column * (NODE_W + GAP_X), y: 46 + offset + row * (NODE_H + GAP_Y) })
    })
  })

  const width = 40 + waves.length * (NODE_W + GAP_X)
  const height = 80 + tallest * (NODE_H + GAP_Y)

  const edges = graph.edges
    .filter((edge) => positions.has(edge.from) && positions.has(edge.to))
    .map((edge) => {
      const a = positions.get(edge.from)
      const b = positions.get(edge.to)
      const x1 = a.x + NODE_W
      const y1 = a.y + NODE_H / 2
      const x2 = b.x - 6
      const y2 = b.y + NODE_H / 2
      const mid = (x1 + x2) / 2
      return `<path class="dag-edge" d="M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}" />`
    })
    .join("")

  const labels = waves
    .map((wave, column) => `<text class="wave-label" x="${20 + column * (NODE_W + GAP_X)}" y="30">wave ${column + 1} · ${wave.nodes.length} parallel</text>`)
    .join("")

  const boxes = graph.nodes
    .filter((node) => positions.has(node.id))
    .map((node) => {
      const pos = positions.get(node.id)
      const color = NODE_COLOR[node.status] ?? NODE_COLOR.pending
      const title = node.title.length > 24 ? `${node.title.slice(0, 23)}…` : node.title
      const model = shortModel(node.model)
      const meta =
        node.status === "done"
          ? `${node.confidence !== null ? node.confidence.toFixed(2) : "—"} · ${duration(node.durationMs)}`
          : node.status === "running"
            ? "executing…"
            : node.status
      return `<g class="dag-node ${esc(node.status)}" data-node="${esc(node.id)}">
        <rect x="${pos.x}" y="${pos.y}" width="${NODE_W}" height="${NODE_H}" fill="${color.fill}" stroke="${color.stroke}" />
        <text x="${pos.x + 12}" y="${pos.y + 20}">${esc(title)}${node.escalated ? " ⬆" : ""}${node.blocking ? " ⛔" : ""}</text>
        <text class="sub" x="${pos.x + 12}" y="${pos.y + 36}">${esc(model)}</text>
        <text class="sub" x="${pos.x + 12}" y="${pos.y + 51}">${esc(meta)}</text>
        <title>${esc(node.title)} — ${esc(node.status)} — ${esc(node.model ?? "unassigned")}${
          node.escalationReason ? ` (escalated: ${esc(node.escalationReason)})` : ""
        }</title>
      </g>`
    })
    .join("")

  const live = graph.live ?? {}
  return `<div class="live-strip">
      <span><b>${num(live.running)}</b> running</span><span><b>${num(live.pending)}</b> queued</span><span><b>${num(live.done)}</b> done</span>
      <span><b>${num(live.widestWave)}</b> peak parallel</span>
      <span><b>${tokens(live.inputTokens)}</b> in</span><span><b>${tokens(live.outputTokens)}</b> out</span>
      ${live.tokensSaved > 0 ? `<span><b>${tokens(live.tokensSaved)}</b> saved</span>` : ""}
      <span><b>${money(live.cost)}</b> live cost</span>
    </div><div class="dag-wrap">
      <svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Execution DAG">
        <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#2c3345" /></marker></defs>
        ${labels}${edges}${boxes}
      </svg>
    </div>
    <div class="legend">
      <span><i style="background:#3fbf8f"></i>done</span>
      <span><i style="background:#6d8bff"></i>running</span>
      <span><i style="background:#333a4c"></i>pending</span>
      <span><i style="background:#ef6a6a"></i>failed</span>
      <span><i style="background:#e6b451"></i>reopened / stale</span>
      <span>⬆ escalated to a heavier model</span>
      <span>⛔ blocking reviewer</span>
    </div>`
}

function renderRationale(rationale) {
  return `<div class="callout">${inline(rationale.headline)}</div>
    <ul class="chain">
      ${rationale.steps
        .map(
          (step) => `<li>
            <div class="stage">step ${step.step} · ${esc(step.stage)}</div>
            <h4>${inline(step.title)}</h4>
            <p class="muted" style="margin:2px 0 0">${inline(step.summary)}</p>
            <ul>${(step.detail ?? []).map((line) => `<li>${inline(line)}</li>`).join("")}</ul>
          </li>`,
        )
        .join("")}
    </ul>
    <div class="section-head"><h2>What would have changed the plan</h2></div>
    <ul class="chain" style="border:0;padding-left:0">
      ${rationale.counterfactuals.map((note) => `<li style="padding-left:0">${inline(note)}</li>`).join("")}
    </ul>`
}

function renderTasks(graph) {
  const orchestrator = graph.orchestrator ?? {}
  const rows = table(
    [
      { label: "Task" },
      { label: "Phase" },
      { label: "Wave", num: true },
      { label: "Status" },
      { label: "Model" },
      { label: "Attempts", num: true },
      { label: "Confidence", num: true },
      { label: "Input", num: true },
      { label: "Output", num: true },
      { label: "Time", num: true },
      { label: "Cost", num: true },
    ],
    graph.nodes.map((node) => ({
      cells: [
        `<div class="stack"><span>${esc(node.title)}${node.escalated ? " ⬆" : ""}</span><span class="muted mono">${esc(node.capability)}</span></div>`,
        `<span class="pill">${esc(node.phase)}</span>`,
        node.wave === null ? "—" : String(node.wave + 1),
        statusPill(node.status),
        `<div class="stack"><span class="tag" title="${esc(node.model ?? "")}">${esc(shortModel(node.model))}</span>${
          node.escalationReason ? `<span class="muted mono">${esc(node.escalationReason)}</span>` : ""
        }</div>`,
        String(node.attempts),
        node.confidence === null ? "—" : node.confidence.toFixed(2),
        tokens(node.inputTokens),
        tokens(node.outputTokens),
        duration(node.durationMs),
        `${money(node.cost)}${node.metered ? "" : ` <span class="muted" title="no provider usage observed for this task">·</span>`}`,
      ],
    })),
  )

  // The manager's own planning, dispatching and merging is real money that
  // belongs to no task. Hiding it would make every run look cheaper than it is.
  const overhead =
    orchestrator.tokens > 0 || orchestrator.cost > 0
      ? `<div class="section-head"><h2>Orchestration overhead</h2><span class="muted">planning, dispatch and merge — not attributable to a task</span></div>
        ${table(
          [{ label: "Model" }, { label: "Input", num: true }, { label: "Output", num: true }, { label: "Cost", num: true }],
          [
            {
              cells: [
                `<span class="tag" title="${esc(orchestrator.model ?? "")}">${esc(shortModel(orchestrator.model))}</span>`,
                tokens(orchestrator.inputTokens),
                tokens(orchestrator.outputTokens),
                money(orchestrator.cost),
              ],
            },
          ],
        )}`
      : ""

  const savings =
    (graph.contextTools ?? []).length > 0
      ? `<div class="section-head"><h2>Context tools</h2><span class="muted">tokens the compression MCPs reported saving on this run</span></div>
        ${table(
          [{ label: "Tool" }, { label: "Calls", num: true }, { label: "Saved", num: true }, { label: "Cost avoided", num: true }],
          graph.contextTools.map((tool) => ({
            cells: [
              `<span class="tag">${esc(tool.id)}</span>`,
              tool.reportedCalls < tool.calls
                ? `<span class="pill warn" title="${num(tool.calls - tool.reportedCalls)} call(s) reported no number">${num(tool.calls)}</span>`
                : num(tool.calls),
              tokens(tool.tokensSaved),
              money(tool.costSaved),
            ],
          })),
        )}`
      : ""

  return `${rows}${overhead}${savings}`
}

/* ---------------- drawer ---------------- */

async function openRun(runId) {
  state.drawer = runId
  state.tab = "graph"
  el("drawer").hidden = false
  el("drawer-body").innerHTML = `<div class="loading">Loading run…</div>`
  await refreshDrawer()
}

async function refreshDrawer() {
  if (!state.drawer) return
  let payload
  try {
    payload = await api(`/api/runs/${encodeURIComponent(state.drawer)}`)
  } catch (error) {
    el("drawer-body").innerHTML = `<div class="empty">${esc(error.message)}</div>`
    return
  }

  const s = payload.summary
  el("drawer-title").textContent = s.request
  el("drawer-subtitle").innerHTML = `<span class="tag">${esc(s.project)}</span> · ${esc(s.branch ?? "no branch")} · ${esc(
    s.actor ?? "unknown",
  )} · ${statusPill(s.status)} · ${s.done}/${s.nodes} tasks · ${money(s.cost)} · ${ago(s.createdAt)}`

  document.querySelectorAll("#drawer-tabs .tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === state.tab))
  el("drawer-body").innerHTML =
    state.tab === "graph" ? renderDag(payload.graph) : state.tab === "why" ? renderRationale(payload.rationale) : renderTasks(payload.graph)
}

function closeDrawer() {
  state.drawer = null
  el("drawer").hidden = true
}

/* ---------------- shell ---------------- */

async function render() {
  const [title, subtitle] = TITLES[state.view]
  el("view-title").textContent = title
  el("view-subtitle").textContent = subtitle

  try {
    if (state.view === "models") {
      view.innerHTML = renderModels(await api("/api/models"))
      el("topbar-stats").innerHTML = ""
      return
    }
    if (state.view === "catalog") {
      view.innerHTML = renderCatalog(await api("/api/catalog"))
      el("topbar-stats").innerHTML = ""
      await bindCatalogActions()
      return
    }

    const query = state.repo ? `?repo=${encodeURIComponent(state.repo)}` : ""
    const data = await api(`/api/overview${query}`)
    state.data = data
    // The costs view needs the declared price list, which only /api/costs carries.
    if (state.view === "costs") data.prices = (await api(`/api/costs${query}`)).prices

    el("topbar-stats").innerHTML = `
      <div class="topstat"><b>${num(data.totals.runs)}</b><span>runs</span></div>
      <div class="topstat"><b>${num(data.totals.active)}</b><span>active</span></div>
      <div class="topstat"><b>${money(data.totals.monthToDate, data.currency)}</b><span>month to date</span></div>`

    view.innerHTML =
      state.view === "overview"
        ? renderOverview(data)
        : state.view === "runs"
          ? renderRuns(data)
          : state.view === "costs"
            ? renderCosts(data)
            : renderRepos(data)

    view.querySelectorAll("tr[data-run]").forEach((row) => row.addEventListener("click", () => openRun(row.dataset.run)))
  } catch (error) {
    view.innerHTML = `<div class="empty">Cannot reach the CAAO API: ${esc(error.message)}</div>`
  }
}

async function loadRepos() {
  try {
    const { repos } = await api("/api/repos")
    const select = el("repo-filter")
    select.innerHTML =
      `<option value="">All repositories</option>` +
      repos.map((repo) => `<option value="${esc(repo.key)}">${esc(repo.key)} (${repo.runs})</option>`).join("")
    select.value = state.repo
  } catch {
    /* the empty state already explains the failure */
  }
}

function tick() {
  el("pulse").textContent = `updated ${new Date().toLocaleTimeString()}`
  render()
  refreshDrawer()
}

document.getElementById("nav").addEventListener("click", (event) => {
  const button = event.target.closest(".nav-item")
  if (!button) return
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button))
  state.view = button.dataset.view
  render()
})

el("repo-filter").addEventListener("change", (event) => {
  state.repo = event.target.value
  render()
})

el("live").addEventListener("change", (event) => {
  state.live = event.target.checked
  clearInterval(state.timer)
  if (state.live) state.timer = setInterval(tick, 4000)
})

el("drawer").addEventListener("click", (event) => {
  if (event.target.closest("[data-close]")) closeDrawer()
  const tab = event.target.closest(".tab")
  if (tab) {
    state.tab = tab.dataset.tab
    refreshDrawer()
  }
})

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeDrawer()
})

/* ---------------- authentication ---------------- */

/**
 * The shell carries no data, so it is served to anyone; every figure in it
 * requires an admin session. Sign-in exchanges the token for an HttpOnly
 * cookie so it never lives in JavaScript-readable storage.
 */
async function start() {
  const session = await api("/api/session")
  state.csrfToken = session.csrfToken ?? null
  if (!session.configured) {
    el("gate").hidden = false
    el("gate-error").hidden = false
    el("gate-error").textContent = "This server has no admin token configured. Set CAAO_ADMIN_TOKEN and restart it."
    el("gate-form").hidden = true
    return
  }
  if (!session.authenticated) {
    el("gate").hidden = false
    el("gate-token").focus()
    return
  }

  el("gate").hidden = true
  el("shell").hidden = false
  await loadRepos()
  await render()
  clearInterval(state.timer)
  state.timer = setInterval(tick, 4000)
}

el("gate-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const error = el("gate-error")
  error.hidden = true
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: el("gate-token").value }),
  })
  if (!res.ok) {
    error.hidden = false
    error.textContent = (await res.json().catch(() => ({}))).error ?? "Sign in failed"
    return
  }
  el("gate-token").value = ""
  await start()
})

el("sign-out").addEventListener("click", async () => {
  clearInterval(state.timer)
  await fetch("/api/session", { method: "DELETE" })
  location.reload()
})

await start()
