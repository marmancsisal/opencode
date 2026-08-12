/**
 * CAAO — fleet analytics.
 *
 * The engine answers "what is happening in this run". This module answers
 * "what is happening across every run in the company": spend by repository, by
 * model, by developer, and where the money is actually going.
 *
 * Pure functions over the run files. No LLM, no network, no database.
 */

import { budgetState, budgets, sum } from "./pricing.js"
import { waves } from "./dag.js"

const ACTIVE = new Set(["planned", "executing", "needs_human"])

function nodeCost(node) {
  return node.cost ?? 0
}

function nodeTokens(node) {
  return node.usage?.totalTokens ?? 0
}

/** Tokens the Execution Manager itself burned coordinating the run. */
function orchestratorOf(run) {
  return {
    cost: run.orchestrator?.cost ?? 0,
    inputTokens: run.orchestrator?.usage?.inputTokens ?? 0,
    outputTokens: run.orchestrator?.usage?.outputTokens ?? 0,
    tokens: run.orchestrator?.usage?.totalTokens ?? 0,
    metered: Boolean(run.orchestrator?.usage?.metered),
  }
}

function savingsOf(run) {
  const tools = Object.values(run.contextTools ?? {})
  return {
    tokensSaved: tools.reduce((total, tool) => total + (tool.tokensSaved ?? 0), 0),
    costSaved: sum(tools.map((tool) => tool.costSaved ?? 0)),
    calls: tools.reduce((total, tool) => total + (tool.calls ?? 0), 0),
  }
}

function bucketOf(run) {
  // Empty strings happen when a run is planned outside a git working copy.
  return run.repo || run.project || "unattributed"
}

function day(iso) {
  return String(iso ?? "").slice(0, 10)
}

/** Everything the dashboard needs about one run, without its full node payload. */
export function summarize(run) {
  const nodes = run.graph?.nodes ?? []
  const executed = nodes.filter((node) => node.attempts > 0)
  const done = nodes.filter((node) => node.status === "done").length
  const failed = nodes.filter((node) => node.status === "failed").length
  const running = nodes.filter((node) => node.status === "running").length
  const confidences = executed
    .map((node) => node.results.at(-1)?.confidence)
    .filter((value) => typeof value === "number")

  const starts = nodes.map((node) => node.startedAt).filter(Boolean).map((at) => Date.parse(at))
  const ends = nodes.map((node) => node.endedAt).filter(Boolean).map((at) => Date.parse(at))
  const orchestrator = orchestratorOf(run)
  const saved = savingsOf(run)

  return {
    id: run.id,
    request: run.request,
    status: run.status,
    active: ACTIVE.has(run.status) && done + failed < nodes.length,
    repo: run.repo ?? null,
    project: bucketOf(run),
    branch: run.branch ?? null,
    actor: run.actor ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt ?? run.createdAt,
    intent: run.signals?.intent ?? null,
    complexity: run.signals?.complexity ?? null,
    understanding: run.signals?.understanding ?? null,
    strategy: run.strategy?.id ?? null,
    capabilities: run.capabilities ?? [],
    nodes: nodes.length,
    done,
    failed,
    running,
    pending: nodes.length - done - failed - running,
    progress: nodes.length > 0 ? Number((done / nodes.length).toFixed(3)) : 0,
    attempts: executed.reduce((total, node) => total + node.attempts, 0),
    reopenCycles: run.reopenCycles ?? 0,
    escalations: nodes.filter((node) => node.provider?.escalated).length,
    minConfidence: confidences.length > 0 ? Math.min(...confidences) : null,
    inputTokens: nodes.reduce((total, node) => total + (node.usage?.inputTokens ?? 0), 0) + orchestrator.inputTokens,
    outputTokens: nodes.reduce((total, node) => total + (node.usage?.outputTokens ?? 0), 0) + orchestrator.outputTokens,
    cachedTokens: nodes.reduce((total, node) => total + (node.usage?.cachedTokens ?? 0), 0),
    tokens: nodes.reduce((total, node) => total + nodeTokens(node), 0) + orchestrator.tokens,
    taskCost: sum(nodes.map(nodeCost)),
    orchestratorCost: orchestrator.cost,
    orchestratorTokens: orchestrator.tokens,
    cost: sum([...nodes.map(nodeCost), orchestrator.cost]),
    tokensSaved: saved.tokensSaved,
    costSaved: saved.costSaved,
    contextToolCalls: saved.calls,
    metered: nodes.some((node) => node.usage?.metered) || orchestrator.metered,
    waves: run.graph ? waves(run.graph).length : 0,
    wallClockMs: starts.length > 0 && ends.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0,
    models: [...new Set(executed.map((node) => node.provider?.model).filter(Boolean))],
  }
}

function group(summaries, keyOf, extra = () => ({})) {
  const buckets = new Map()
  for (const item of summaries) {
    const key = keyOf(item)
    if (key === null || key === undefined) continue
    const bucket = buckets.get(key) ?? {
      key,
      runs: 0,
      cost: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      tokensSaved: 0,
      nodes: 0,
      failed: 0,
      active: 0,
    }
    bucket.runs += 1
    bucket.cost = sum([bucket.cost, item.cost])
    bucket.tokens += item.tokens
    bucket.inputTokens += item.inputTokens
    bucket.outputTokens += item.outputTokens
    bucket.tokensSaved += item.tokensSaved
    bucket.nodes += item.nodes
    bucket.failed += item.failed
    bucket.active += item.active ? 1 : 0
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
    .map((bucket) => ({ ...bucket, ...extra(bucket) }))
    .sort((a, b) => b.cost - a.cost || b.runs - a.runs)
}

/** Spend per model, computed from the nodes rather than the run summaries. */
export function byModel(runs) {
  const buckets = new Map()
  const bucketFor = (key, seed) => {
    const bucket = buckets.get(key) ?? {
      key,
      model: key,
      pool: null,
      tier: null,
      calls: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      tokens: 0,
      capabilities: [],
      escalations: 0,
      ...seed,
    }
    buckets.set(key, bucket)
    return bucket
  }

  for (const run of runs) {
    for (const node of run.graph?.nodes ?? []) {
      if (!node.provider?.model || node.attempts === 0) continue
      const bucket = bucketFor(node.provider.model, { pool: node.provider.pool, tier: node.provider.tier })
      bucket.calls += node.attempts
      bucket.cost = sum([bucket.cost, nodeCost(node)])
      bucket.inputTokens += node.usage?.inputTokens ?? 0
      bucket.outputTokens += node.usage?.outputTokens ?? 0
      bucket.cachedTokens += node.usage?.cachedTokens ?? 0
      bucket.tokens += nodeTokens(node)
      bucket.escalations += node.provider.escalated ? 1 : 0
      if (!bucket.capabilities.includes(node.capability)) bucket.capabilities.push(node.capability)
    }

    // The orchestrator is a real model call on a real model: hiding it made the
    // console under-report the very spend it exists to explain.
    const orchestrator = orchestratorOf(run)
    if (orchestrator.tokens > 0 && run.orchestrator?.model) {
      const bucket = bucketFor(run.orchestrator.model, {})
      bucket.calls += run.orchestrator.usage?.calls ?? 1
      bucket.cost = sum([bucket.cost, orchestrator.cost])
      bucket.inputTokens += orchestrator.inputTokens
      bucket.outputTokens += orchestrator.outputTokens
      bucket.cachedTokens += run.orchestrator.usage?.cachedTokens ?? 0
      bucket.tokens += orchestrator.tokens
      if (!bucket.capabilities.includes("orchestration")) bucket.capabilities.push("orchestration")
    }
  }
  return [...buckets.values()].sort((a, b) => b.cost - a.cost)
}

export function byCapability(runs) {
  const buckets = new Map()
  for (const run of runs) {
    for (const node of run.graph?.nodes ?? []) {
      if (node.attempts === 0) continue
      const bucket = buckets.get(node.capability) ?? {
        key: node.capability,
        title: node.title,
        phase: node.phase,
        calls: 0,
        cost: 0,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        retries: 0,
        durationMs: 0,
      }
      bucket.calls += 1
      bucket.retries += Math.max(0, node.attempts - 1)
      bucket.cost = sum([bucket.cost, nodeCost(node)])
      bucket.tokens += nodeTokens(node)
      bucket.inputTokens += node.usage?.inputTokens ?? 0
      bucket.outputTokens += node.usage?.outputTokens ?? 0
      if (node.startedAt && node.endedAt) bucket.durationMs += Date.parse(node.endedAt) - Date.parse(node.startedAt)
      buckets.set(node.capability, bucket)
    }
  }
  return [...buckets.values()].sort((a, b) => b.cost - a.cost)
}

/**
 * What the compression and retrieval layer bought back. Figures are what the
 * tools themselves reported: `unreportedCalls` is how much of the traffic came
 * with no number attached, and is deliberately not estimated away.
 */
export function byContextTool(runs) {
  const buckets = new Map()
  for (const run of runs) {
    for (const tool of Object.values(run.contextTools ?? {})) {
      const bucket = buckets.get(tool.id) ?? {
        key: tool.id,
        calls: 0,
        reportedCalls: 0,
        runs: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        tokensSaved: 0,
        costSaved: 0,
        tools: [],
      }
      bucket.runs += 1
      bucket.calls += tool.calls ?? 0
      bucket.reportedCalls += tool.reportedCalls ?? 0
      bucket.tokensBefore += tool.tokensBefore ?? 0
      bucket.tokensAfter += tool.tokensAfter ?? 0
      bucket.tokensSaved += tool.tokensSaved ?? 0
      bucket.costSaved = sum([bucket.costSaved, tool.costSaved ?? 0])
      for (const name of tool.tools ?? []) if (!bucket.tools.includes(name)) bucket.tools.push(name)
      buckets.set(tool.id, bucket)
    }
  }
  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      unreportedCalls: Math.max(0, bucket.calls - bucket.reportedCalls),
      // The share of the original payload the tool removed, so the dashboard can
      // say "cut 80%" rather than making the reader divide two token counts.
      ratio: bucket.tokensBefore > 0 ? Number((bucket.tokensSaved / bucket.tokensBefore).toFixed(3)) : null,
    }))
    .sort((a, b) => b.tokensSaved - a.tokensSaved || b.calls - a.calls)
}

/** Contiguous daily series, so a chart never invents a slope over a missing day. */
export function daily(summaries, days = 30) {
  const empty = (key) => ({ key, runs: 0, cost: 0, tokens: 0, inputTokens: 0, outputTokens: 0, tokensSaved: 0 })
  const spend = new Map()
  for (const item of summaries) {
    const key = day(item.createdAt)
    const bucket = spend.get(key) ?? empty(key)
    bucket.runs += 1
    bucket.cost = sum([bucket.cost, item.cost])
    bucket.tokens += item.tokens
    bucket.inputTokens += item.inputTokens
    bucket.outputTokens += item.outputTokens
    bucket.tokensSaved += item.tokensSaved
    spend.set(key, bucket)
  }

  const series = []
  const cursor = new Date()
  for (let offset = days - 1; offset >= 0; offset--) {
    const at = new Date(cursor.getTime() - offset * 86400000)
    const key = at.toISOString().slice(0, 10)
    series.push(spend.get(key) ?? empty(key))
  }
  return series
}

function monthOf(iso) {
  return String(iso ?? "").slice(0, 7)
}

/**
 * The central view. `filter.repo` narrows every figure to one repository, which
 * is how an admin looks at a single team without the rest of the company's
 * noise skewing the totals.
 */
export function overview(config, runs, { repo = null, since = null, days = 30 } = {}) {
  const scoped = runs.filter((run) => {
    if (repo && bucketOf(run) !== repo) return false
    if (since && String(run.createdAt) < since) return false
    return true
  })

  const summaries = scoped.map(summarize)
  const limits = budgets(config)
  const thisMonth = monthOf(new Date().toISOString())
  const monthSpend = sum(summaries.filter((item) => monthOf(item.createdAt) === thisMonth).map((item) => item.cost))
  const totalCost = sum(summaries.map((item) => item.cost))

  const repos = group(summaries, (item) => item.project, (bucket) => ({
    budget: budgetState(bucket.cost, limits.perRepoMonthly, limits.warnAt),
  }))

  return {
    generatedAt: new Date().toISOString(),
    filter: { repo, since, days },
    currency: limits.currency,
    totals: {
      runs: summaries.length,
      active: summaries.filter((item) => item.active).length,
      nodes: summaries.reduce((total, item) => total + item.nodes, 0),
      attempts: summaries.reduce((total, item) => total + item.attempts, 0),
      escalations: summaries.reduce((total, item) => total + item.escalations, 0),
      reopenCycles: summaries.reduce((total, item) => total + item.reopenCycles, 0),
      tokens: summaries.reduce((total, item) => total + item.tokens, 0),
      inputTokens: summaries.reduce((total, item) => total + item.inputTokens, 0),
      outputTokens: summaries.reduce((total, item) => total + item.outputTokens, 0),
      cachedTokens: summaries.reduce((total, item) => total + item.cachedTokens, 0),
      orchestratorTokens: summaries.reduce((total, item) => total + item.orchestratorTokens, 0),
      orchestratorCost: sum(summaries.map((item) => item.orchestratorCost)),
      tokensSaved: summaries.reduce((total, item) => total + item.tokensSaved, 0),
      costSaved: sum(summaries.map((item) => item.costSaved)),
      cost: totalCost,
      monthToDate: monthSpend,
      avgCostPerRun: summaries.length > 0 ? Number((totalCost / summaries.length).toFixed(4)) : 0,
      avgTokensPerRun: summaries.length > 0 ? Math.round(summaries.reduce((total, item) => total + item.tokens, 0) / summaries.length) : 0,
      metered: summaries.some((item) => item.metered),
    },
    budget: {
      ...limits,
      monthToDate: monthSpend,
      month: budgetState(monthSpend, limits.monthlyTotal, limits.warnAt),
    },
    repos,
    actors: group(summaries, (item) => item.actor),
    intents: group(summaries, (item) => item.intent),
    strategies: group(summaries, (item) => item.strategy),
    understanding: group(summaries, (item) => item.understanding),
    models: byModel(scoped),
    capabilities: byCapability(scoped),
    contextTools: byContextTool(scoped),
    daily: daily(summaries, days),
    runs: summaries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
  }
}

/** Distinct repositories seen, for the dashboard's repository switcher. */
export function repositories(runs) {
  const seen = new Map()
  for (const run of runs) {
    const key = bucketOf(run)
    const entry = seen.get(key) ?? { key, repo: run.repo ?? null, runs: 0, cost: 0, lastSeen: run.createdAt }
    entry.runs += 1
    entry.cost = sum([entry.cost, sum((run.graph?.nodes ?? []).map(nodeCost)), orchestratorOf(run).cost])
    if (String(run.createdAt) > String(entry.lastSeen)) entry.lastSeen = run.createdAt
    seen.set(key, entry)
  }
  return [...seen.values()].sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
}
