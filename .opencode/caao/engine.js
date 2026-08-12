/**
 * CAAO — Execution Manager engine.
 *
 * Everything the orchestrator decides is computed here, deterministically,
 * from the declarative configuration. No workflow is hardcoded.
 */

import { capability as getCapability, loadConfig } from "./config.js"
import { classify } from "./classify.js"
import { evaluatePost, resolveCapabilities, selectStrategy } from "./policy.js"
import { buildGraph, expandNode, isComplete, readyNodes, resetDownstream, toMermaid, waves } from "./dag.js"
import { resolveProvider } from "./provider.js"
import { actor, repoSignals } from "./context.js"
import { costOf, budgetState, budgets, currency, poolPricing, sum, usageOf } from "./pricing.js"
import { listRuns, loadRun, newRunId, saveRun, withRunLock } from "./state.js"
import { catalog, skillInstructionsFor } from "./catalog.js"
import { addUsage, attributionTarget, poolForModel, subtractUsage, ZERO_USAGE } from "./usage.js"
import { extractSavings, ownerOf } from "./savings.js"

const RUNNING = "running"
const ACTIVE = new Set(["planned", "executing", "needs_human"])
const MILLION = 1_000_000

function log(run, entry) {
  run.log.push({ at: new Date().toISOString(), ...entry })
  return entry
}

function node(run, nodeId) {
  const found = run.graph.nodes.find((candidate) => candidate.id === nodeId)
  if (!found) throw new Error(`CAAO: unknown node "${nodeId}" in run "${run.id}"`)
  return found
}

function attachCapability(run, config, capabilityId, dependsOn = []) {
  const existing = run.graph.nodes.find(
    (candidate) => candidate.capability === capabilityId && !["done", "expanded"].includes(candidate.status),
  )
  if (existing) return existing

  const capability = getCapability(config, capabilityId)
  const provider = resolveProvider(config, capabilityId, { signals: run.graph.signals })
  const created = {
    id: `${capabilityId}@${run.graph.nodes.filter((n) => n.capability === capabilityId).length + 1}`,
    capability: capabilityId,
    title: capability.title,
    phase: capability.phase,
    phaseRank: capability.phaseRank,
    agent: provider.agent,
    parallelizable: capability.parallelizable !== false,
    mutates: Boolean(capability.mutates),
    contextScope: capability.context,
    confidenceFloor: capability.confidence_floor,
    outputs: capability.outputs ?? [],
    mayRequest: capability.may_request ?? [],
    objective: capability.worker?.objective ?? capability.intent,
    checklist: capability.worker?.checklist ?? [],
    outputContract: capability.worker?.output_contract ?? "summary, confidence",
    dependsOn,
    layer: run.graph.layers.length,
    status: "pending",
    attempts: 0,
    results: [],
    provider,
    providerHistory: [],
    injected: true,
  }
  run.graph.nodes.push(created)
  if (!run.capabilities.includes(capabilityId)) run.capabilities.push(capabilityId)
  return created
}

export function buildBrief(run, target) {
  const upstream = target.dependsOn
    .map((id) => run.graph.nodes.find((candidate) => candidate.id === id))
    .filter(Boolean)
    .flatMap((dep) => dep.results.filter((result) => result.summary).map((result) => `- ${dep.title}: ${result.summary}`))
  const skills = skillInstructionsFor(loadConfig(run.configRoot), target.capability, { repo: run.repo, team: run.team })

  return [
    `# Assignment — ${target.title}`,
    "",
    `Original request: ${run.request}`,
    target.brief ? `Unit of work: ${target.brief}` : "",
    "",
    `## Objective`,
    target.objective,
    "",
    `## Constraints`,
    ...target.checklist.map((item) => `- ${item}`),
    `- Context scope: ${target.contextScope}`,
    target.scopeFiles?.length ? `- Files in scope: ${target.scopeFiles.join(", ")}` : "",
    "",
    upstream.length > 0 ? "## Upstream results" : "",
    ...upstream,
    "",
    skills.length > 0 ? "## Company skills" : "",
    ...skills.flatMap((skill) => [
      `### ${skill.title ?? skill.id}${skill.version ? ` (v${skill.version})` : ""}`,
      skill.content ?? `Follow the signed company skill at ${skill.file}.`,
    ]),
    "",
    "## Required output",
    `Return: ${target.outputContract}`,
    `End your reply with a single line: CONFIDENCE: <0.00-1.00>`,
    `Report confidence below ${target.confidenceFloor} instead of guessing.`,
  ]
    .filter((line) => line !== "")
    .join("\n")
}

/**
 * The brief handed to the triage worker. Triage runs before any graph exists,
 * so it is dispatched by the Execution Manager, not by the DAG.
 */
export function triageBrief(config, { request, changedFiles = [], branch = null }) {
  const capability = getCapability(config, "triage")
  const domains = Object.keys(config.policies.classification?.domains ?? {})
  const intents = (config.policies.classification?.intents ?? []).map((rule) => rule.id)
  const complexity = config.policies.classification?.semantic?.complexity_order ?? []

  return [
    "# Triage",
    "",
    "Classify the following developer request. Read it for meaning, not for keywords.",
    "",
    "## Request",
    request,
    "",
    branch ? `Branch: ${branch}` : "",
    changedFiles.length > 0 ? `Uncommitted / recently changed files (${changedFiles.length}):` : "No files are currently modified.",
    ...changedFiles.slice(0, 40).map((file) => `- ${file}`),
    changedFiles.length > 40 ? `- …and ${changedFiles.length - 40} more` : "",
    "",
    "## Vocabulary",
    `intent: ${intents.join(" | ")}`,
    `complexity: ${complexity.join(" | ")}`,
    `domains: ${domains.join(" | ")}`,
    "",
    "## Rules",
    ...(capability.worker?.checklist ?? []).map((item) => `- ${item}`),
    "",
    "## Required output",
    "Return only the JSON object, with no prose around it:",
    capability.worker?.output_contract ?? "",
  ]
    .filter((line) => line !== "")
    .join("\n")
}

export function plan(input = {}) {
  const config = loadConfig(input.root)
  const repo = input.skipRepoScan ? { changedFiles: input.changedFiles ?? [] } : repoSignals(input.cwd ?? process.cwd())
  const changedFiles = input.changedFiles ?? repo.changedFiles ?? []

  const signals = classify(config, { ...input, changedFiles })
  const { capabilities, trace } = resolveCapabilities(config, signals)
  const strategy = selectStrategy(config, {
    ...signals,
    capabilities,
    capability_count: capabilities.length,
  })
  const graph = buildGraph(config, {
    capabilities,
    strategy,
    signals: {
      intent: signals.intent,
      complexity: signals.complexity,
      understanding: signals.understanding,
      classification_confidence: signals.classification_confidence,
      touches: signals.touches,
      changed_files: signals.changed_files,
    },
  })

  const run = {
    id: input.runId ?? newRunId(),
    configRoot: config.root,
    createdAt: new Date().toISOString(),
    request: signals.request,
    status: "planned",
    // Attribution. Every figure in the dashboard is grouped by these three.
    repo: input.repo ?? repo.repo ?? null,
    project: input.project ?? repo.project ?? null,
    branch: input.branch ?? repo.branch ?? null,
    commit: repo.commit ?? null,
    actor: input.actor ?? (input.skipRepoScan ? null : actor(input.cwd ?? process.cwd())),
    team: input.team ?? process.env.CAAO_TEAM ?? null,
    signals: {
      intent: signals.intent,
      complexity: signals.complexity,
      understanding: signals.understanding,
      classification_confidence: signals.classification_confidence,
      touches: signals.touches,
      changed_files: signals.changed_files,
      evidence: signals.evidence,
    },
    capabilities,
    policyTrace: trace,
    strategy: { id: strategy.id, rule: strategy.rule, maxParallel: graph.maxParallel },
    graph,
    reopenCycles: 0,
    log: [],
  }

  log(run, { event: "planned", capabilities, strategy: strategy.id, nodes: graph.nodes.length })
  return input.persist === false ? run : saveRun(run)
}

function nextUnlocked(runId) {
  const run = loadRun(runId)
  const running = run.graph.nodes.filter((candidate) => candidate.status === RUNNING)
  const budget = Math.max(0, (run.graph.maxParallel ?? 1) - running.length)

  const blocked = run.graph.nodes.filter((candidate) => candidate.status === "blocked")
  const ready = budget === 0 ? [] : readyNodes(run.graph).slice(0, budget)

  for (const target of ready) {
    target.status = RUNNING
    target.startedAt = new Date().toISOString()
    target.providerHistory = target.providerHistory ?? []
    target.providerHistory.push({
      attempt: target.attempts + 1,
      pool: target.provider.pool,
      model: target.provider.model,
      tier: target.provider.tier,
      agent: target.agent,
      escalated: Boolean(target.provider.escalated),
      reason: target.provider.escalationReason,
      at: target.startedAt,
    })
  }
  if (ready.length > 0) {
    run.status = "executing"
    log(run, { event: "dispatch", nodes: ready.map((target) => target.id) })
  }
  saveRun(run)

  return {
    runId: run.id,
    complete: isComplete(run.graph),
    maxParallel: run.graph.maxParallel,
    inFlight: running.length + ready.length,
    blocked: blocked.map((target) => ({ id: target.id, reason: target.blockedReason ?? "awaiting advisor" })),
    running: running.map((target) => target.id),
    dispatch: ready.map((target) => ({
      nodeId: target.id,
      capability: target.capability,
      agent: target.agent,
      model: target.provider.model,
      strategy: target.provider.strategy,
      contextScope: target.contextScope,
      expandable: Boolean(target.expandable),
      prompt: buildBrief(run, target),
    })),
  }
}

export function next(runId) {
  return withRunLock(runId, () => nextUnlocked(runId))
}

function expandUnlocked(runId, nodeId, subtasks) {
  const run = loadRun(runId)
  const config = loadConfig(run.configRoot)
  const children = expandNode(run.graph, nodeId, subtasks, config)
  log(run, { event: "expanded", node: nodeId, into: children.map((child) => child.id) })
  saveRun(run)
  return { runId: run.id, parent: nodeId, workers: children.map((child) => ({ id: child.id, capability: child.capability, title: child.title, model: child.provider.model, dependsOn: child.dependsOn })) }
}

export function expand(runId, nodeId, subtasks) {
  return withRunLock(runId, () => expandUnlocked(runId, nodeId, subtasks))
}

function applyRetryLadder(run, config, target, reason) {
  const retry = config.workflows.retry ?? {}
  const ladder = retry.ladder ?? []
  const step = ladder[Math.min(target.attempts - 1, ladder.length - 1)] ?? { action: "escalate" }

  if (target.attempts > (retry.max_attempts ?? 2) || step.action === "escalate") {
    target.status = "blocked"
    target.blockedReason = reason
    const advisor = attachCapability(run, config, "advisor", [])
    advisor.blockedNode = target.id
    return { action: "escalate", advisor: advisor.id, reason }
  }

  if (step.action === "switch_provider") {
    target.provider = resolveProvider(config, target.capability, { attempt: target.attempts, signals: run.graph.signals })
    target.agent = target.provider.agent
    target.status = "pending"
    return { action: "switch_provider", model: target.provider.model, reason }
  }

  target.status = "pending"
  return { action: "retry_same_provider", model: target.provider.model, reason }
}

function applyValidationGate(run, config, target, result) {
  const gate = config.workflows.validation?.gates?.[target.capability]
  if (!gate || result.verdict !== "fail") return null

  if (gate.on_fail === "annotate") return { action: "annotate", gate: target.capability }

  if (gate.on_fail === "reopen_build") {
    const maxCycles = config.workflows.validation?.max_reopen_cycles ?? 2
    if (run.reopenCycles >= maxCycles) {
      const advisor = attachCapability(run, config, "advisor", [])
      return { action: "escalate", advisor: advisor.id, reason: "reopen limit reached" }
    }
    run.reopenCycles += 1
    const reopened = run.graph.nodes.filter((candidate) => candidate.phase === "build" && candidate.status === "done")
    for (const candidate of reopened) {
      candidate.status = "pending"
      candidate.reopenedBy = target.id
    }
    const stale = resetDownstream(run.graph, reopened.map((candidate) => candidate.id), target.id)
    return {
      action: "reopen_build",
      gate: target.capability,
      nodes: reopened.map((candidate) => candidate.id),
      invalidated: stale,
    }
  }

  const advisor = attachCapability(run, config, "advisor", [])
  return { action: "escalate", advisor: advisor.id, gate: target.capability }
}

function recordUnlocked(runId, nodeId, result = {}) {
  const run = loadRun(runId)
  const config = loadConfig(run.configRoot)
  const target = node(run, nodeId)

  const confidence = typeof result.confidence === "number" ? result.confidence : null
  const reported = usageOf(result)
  target.attempts += 1
  target.endedAt = new Date().toISOString()

  // Usage observed from the opencode event stream is already on the node, so
  // only what the worker reported about itself still has to be added. A worker
  // that reports nothing is not free — it is already billed, exactly.
  if (reported.metered) {
    target.usage = addUsage(target.usage, { ...reported, calls: 1 })
    target.cost = sum([target.cost ?? 0, costOf(config, target.provider.pool, reported)])
  }

  // A retried node bills every attempt: that is the point of showing retries.
  // What this attempt cost is whatever the node accumulated since the last one.
  const accounted = target.results.reduce((total, entry) => addUsage(total, entry.usage), ZERO_USAGE)
  const usage = subtractUsage(target.usage ?? ZERO_USAGE, accounted)
  const cost = Math.max(0, sum([target.cost ?? 0, -sum(target.results.map((entry) => entry.cost ?? 0))]))

  target.results.push({
    at: target.endedAt,
    status: result.status ?? "ok",
    confidence,
    model: target.provider.model,
    pool: target.provider.pool,
    summary: result.summary ?? "",
    files: result.files ?? [],
    findings_blocking: result.findings_blocking ?? 0,
    verdict: result.verdict ?? null,
    usage,
    cost,
  })

  const decisions = []

  if (target.capability === "advisor" && result.decision) {
    const blocked = target.blockedNode ? node(run, target.blockedNode) : null
    target.status = "done"
    if (blocked) {
      if (result.decision === "switch_provider") {
        blocked.provider = resolveProvider(config, blocked.capability, { attempt: blocked.attempts, signals: run.graph.signals })
        blocked.agent = blocked.provider.agent
        blocked.status = "pending"
      } else if (result.decision === "retry") {
        blocked.status = "pending"
      } else if (result.decision === "escalate_human") {
        run.status = "needs_human"
      }
    }
    if (result.decision === "add_capability" && result.capability) {
      attachCapability(run, config, result.capability, [])
    }
    decisions.push({ action: `advisor:${result.decision}`, target: blocked?.id ?? null })
  } else if (result.status === "error" || result.status === "timeout") {
    decisions.push(applyRetryLadder(run, config, target, `worker ${result.status}`))
  } else if (confidence !== null && confidence < (target.confidenceFloor ?? 0.7)) {
    decisions.push(applyRetryLadder(run, config, target, `confidence ${confidence} below floor ${target.confidenceFloor}`))
  } else {
    target.status = "done"
  }

  if (target.stale && target.status === "done") {
    target.stale = false
    target.status = "pending"
    decisions.push({
      action: "discarded",
      node: target.id,
      reason: "the build was reopened while this node was running, so its result no longer describes the code",
    })
  }

  if (target.status === "done") {
    const gate = applyValidationGate(run, config, target, result)
    if (gate) decisions.push(gate)

    const post = evaluatePost(config, {
      confidence: confidence ?? 1,
      findings_blocking: result.findings_blocking ?? 0,
      capabilities: run.capabilities,
      touches: run.signals.touches,
    })
    for (const capabilityId of post.capabilities) {
      const injected = attachCapability(run, config, capabilityId, [])
      decisions.push({ action: "policy_injected", capability: capabilityId, node: injected.id })
    }
    if (post.escalate) run.status = "needs_human"
    if (post.trace.length > 0) run.policyTrace.push(...post.trace)

    for (const requested of result.request_capabilities ?? []) {
      const injected = attachCapability(run, config, requested, [target.id])
      decisions.push({ action: "capability_chained", capability: requested, node: injected.id })
    }
  }

  log(run, { event: "recorded", node: nodeId, status: target.status, confidence, decisions })

  if (isComplete(run.graph) && run.status !== "needs_human") run.status = "complete"
  saveRun(run)

  return {
    runId: run.id,
    node: target.id,
    nodeStatus: target.status,
    decisions,
    runStatus: run.status,
    remaining: run.graph.nodes.filter((candidate) => ["pending", RUNNING, "blocked"].includes(candidate.status)).length,
  }
}

export function record(runId, nodeId, result = {}) {
  return withRunLock(runId, () => recordUnlocked(runId, nodeId, result))
}

/** The run a stray observation belongs to when the caller cannot name one. */
function mostRecentActiveRunId() {
  return listRuns().find((run) => ACTIVE.has(run.status))?.id ?? null
}

/**
 * The company price list wins; the provider's own figure is the fallback for a
 * pool nobody has priced yet, so an unpriced model is under-reported rather
 * than invisible.
 */
function priceOf(config, poolId, usage, providerCost = 0) {
  const priced = poolId ? costOf(config, poolId, usage) : 0
  return priced > 0 ? priced : sum([providerCost])
}

function ingestUnlocked(runId, observation) {
  const run = loadRun(runId)
  const config = loadConfig(run.configRoot)

  run.billedMessages = run.billedMessages ?? []
  if (observation.messageId) {
    if (run.billedMessages.includes(observation.messageId)) {
      return { status: "duplicate", runId: run.id, messageId: observation.messageId }
    }
    run.billedMessages.push(observation.messageId)
    if (run.billedMessages.length > 500) run.billedMessages.splice(0, run.billedMessages.length - 500)
  }

  const target = attributionTarget(run, observation)
  const pool = target?.provider?.pool ?? poolForModel(config, observation.model)
  const cost = priceOf(config, pool, observation.usage, observation.providerCost)

  if (target) {
    target.usage = addUsage(target.usage, observation.usage)
    target.cost = sum([target.cost ?? 0, cost])
    target.observed = true
  } else {
    // Nothing was in flight: this is the Execution Manager thinking, which is a
    // real and frequently surprising share of what a run costs.
    run.orchestrator = {
      model: observation.model ?? run.orchestrator?.model ?? null,
      usage: addUsage(run.orchestrator?.usage, observation.usage),
      cost: sum([run.orchestrator?.cost ?? 0, cost]),
    }
  }

  saveRun(run)
  return {
    status: "billed",
    runId: run.id,
    scope: target ? "task" : "orchestrator",
    node: target?.id ?? null,
    model: observation.model,
    pool,
    cost,
    usage: observation.usage,
  }
}

/**
 * Bill one completed assistant message. Called by the plugin for every model
 * call opencode reports, which is the only place the true token counts exist.
 */
export function ingestUsage(observation, { runId = null } = {}) {
  if (!observation) return { status: "ignored", reason: "not a billable message" }
  const target = runId ?? mostRecentActiveRunId()
  if (!target) return { status: "ignored", reason: "no active run" }
  try {
    return withRunLock(target, () => ingestUnlocked(target, observation))
  } catch (error) {
    return { status: "ignored", reason: error.message }
  }
}

function savingsUnlocked(runId, observation, poolId) {
  const run = loadRun(runId)
  const config = loadConfig(run.configRoot)
  const pricing = poolPricing(config, poolId ?? resolveProvider(config, "planning").pool)

  run.contextTools = run.contextTools ?? {}
  const bucket = run.contextTools[observation.id] ?? {
    id: observation.id,
    calls: 0,
    reportedCalls: 0,
    tokensBefore: 0,
    tokensAfter: 0,
    tokensSaved: 0,
    costSaved: 0,
    tools: [],
  }

  bucket.calls += 1
  if (!bucket.tools.includes(observation.tool)) bucket.tools.push(observation.tool)
  if (observation.reported) {
    bucket.reportedCalls += 1
    bucket.tokensBefore += observation.tokensBefore ?? 0
    bucket.tokensAfter += observation.tokensAfter ?? 0
    bucket.tokensSaved += observation.tokensSaved ?? 0
    // Saved input tokens are tokens the orchestrator's model never had to read.
    bucket.costSaved = sum([bucket.costSaved, ((observation.tokensSaved ?? 0) / MILLION) * (pricing.input_per_mtok ?? 0)])
  }

  run.contextTools[observation.id] = bucket
  saveRun(run)
  return { status: "recorded", runId: run.id, ...bucket }
}

/**
 * Record what a compression or retrieval MCP claims to have saved. The figure
 * is self-reported by the tool — CAAO never sees the payload it compressed —
 * so a call that reports nothing is counted but never estimated.
 */
export function recordContextSavings(input, { runId = null, pool = null } = {}) {
  const config = loadConfig()
  const entry = ownerOf(catalog(config).contextTools, input.tool)
  if (!entry) return { status: "ignored", reason: `no catalog context tool owns "${input.tool}"` }

  const observation = extractSavings(entry, input)
  if (!observation) return { status: "ignored", reason: `"${input.tool}" is not a measured tool of ${entry.id}` }

  const target = runId ?? mostRecentActiveRunId()
  if (!target) return { status: "ignored", reason: "no active run", ...observation }
  try {
    return withRunLock(target, () => savingsUnlocked(target, observation, pool))
  } catch (error) {
    return { status: "ignored", reason: error.message }
  }
}

function mergeUnlocked(runId) {
  const run = loadRun(runId)
  const config = loadConfig(run.configRoot)

  const contributions = run.graph.nodes
    .filter((candidate) => candidate.mutates && candidate.status === "done")
    .map((candidate) => ({
      node: candidate.id,
      capability: candidate.capability,
      files: [...new Set(candidate.results.flatMap((result) => result.files ?? []))],
      summary: candidate.results.at(-1)?.summary ?? "",
    }))

  const owners = new Map()
  for (const contribution of contributions) {
    for (const file of contribution.files) {
      owners.set(file, [...(owners.get(file) ?? []), contribution.node])
    }
  }
  const conflicts = [...owners.entries()]
    .filter(([, nodes]) => nodes.length > 1)
    .map(([file, nodes]) => ({ file, nodes, rule: "same_file_touched_by_multiple_nodes" }))

  const pendingGates = run.graph.nodes
    .filter((candidate) => candidate.phase === "validate" && candidate.status !== "done")
    .map((candidate) => ({
      capability: candidate.capability,
      blocking: config.workflows.validation?.gates?.[candidate.capability]?.blocking ?? false,
    }))

  const policy = config.workflows.merge ?? {}
  const report = {
    runId: run.id,
    strategy: policy.strategy ?? "sequential-apply",
    contributions,
    files: [...owners.keys()],
    conflicts,
    conflictPolicy: policy.conflict ?? "escalate",
    pendingGates,
    unified: conflicts.length === 0,
  }

  log(run, { event: "merged", files: report.files.length, conflicts: conflicts.length })
  if (conflicts.length > 0 && report.conflictPolicy === "escalate") {
    attachCapability(run, config, "advisor", [])
    report.escalated = true
  }
  saveRun(run)
  return report
}

export function merge(runId) {
  return withRunLock(runId, () => mergeUnlocked(runId))
}

export function status(runId) {
  const run = loadRun(runId)
  return {
    runId: run.id,
    request: run.request,
    status: run.status,
    signals: run.signals,
    capabilities: run.capabilities,
    strategy: run.strategy,
    policyTrace: run.policyTrace,
    nodes: run.graph.nodes.map((candidate) => ({
      id: candidate.id,
      capability: candidate.capability,
      status: candidate.status,
      attempts: candidate.attempts,
      model: candidate.provider.model,
      dependsOn: candidate.dependsOn,
      confidence: candidate.results.at(-1)?.confidence ?? null,
    })),
    mermaid: toMermaid(run.graph),
    log: run.log,
  }
}

function durationMs(target) {
  if (!target.startedAt || !target.endedAt) return null
  return Math.max(0, Date.parse(target.endedAt) - Date.parse(target.startedAt))
}

function humanDuration(ms) {
  if (ms === null) return "—"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Attribution recap: who did what, on which model, and why that model.
 * This is the only place where model names are deliberately surfaced to the developer.
 */
export function report(runId) {
  const run = loadRun(runId)
  const config = loadConfig(run.configRoot)
  const money = currency(config)
  const limits = budgets(config)

  // A task that has burned tokens belongs in the report even before it reports
  // a result — otherwise a run in flight looks free right up until it finishes.
  const executed = run.graph.nodes
    .filter((candidate) => candidate.attempts > 0 || candidate.status === "expanded" || (candidate.usage?.calls ?? 0) > 0)
    .sort((a, b) => (a.phaseRank - b.phaseRank) || String(a.id).localeCompare(String(b.id)))

  const steps = executed.map((candidate) => {
    const last = candidate.results.at(-1) ?? {}
    const history = candidate.providerHistory ?? []
    const first = history[0] ?? {}
    return {
      node: candidate.id,
      phase: candidate.phase,
      capability: candidate.capability,
      title: candidate.title,
      status: candidate.status,
      model: candidate.provider.model,
      pool: candidate.provider.pool,
      tier: candidate.provider.tier,
      attempts: candidate.attempts,
      confidence: last.confidence ?? null,
      verdict: last.verdict ?? null,
      files: [...new Set(candidate.results.flatMap((entry) => entry.files ?? []))],
      durationMs: durationMs(candidate),
      escalated: Boolean(candidate.provider.escalated),
      escalationReason: candidate.provider.escalationReason ?? null,
      switchedFrom: history.length > 1 && first.model !== candidate.provider.model ? first.model : null,
      reopenedBy: candidate.reopenedBy ?? null,
      usage: candidate.usage ?? ZERO_USAGE,
      cost: candidate.cost ?? 0,
    }
  })

  const byModel = new Map()
  for (const step of steps) {
    const entry = byModel.get(step.model) ?? {
      model: step.model,
      tier: step.tier,
      pool: step.pool,
      steps: 0,
      capabilities: [],
      durationMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      tokens: 0,
      cost: 0,
    }
    entry.steps += 1
    entry.durationMs += step.durationMs ?? 0
    entry.inputTokens += step.usage.inputTokens ?? 0
    entry.outputTokens += step.usage.outputTokens ?? 0
    entry.tokens += step.usage.totalTokens
    entry.cost = sum([entry.cost, step.cost])
    if (!entry.capabilities.includes(step.capability)) entry.capabilities.push(step.capability)
    byModel.set(step.model, entry)
  }

  const orchestrator = {
    model: run.orchestrator?.model ?? null,
    usage: run.orchestrator?.usage ?? ZERO_USAGE,
    cost: run.orchestrator?.cost ?? 0,
  }
  const contextTools = Object.values(run.contextTools ?? {})
  const confidences = steps.map((step) => step.confidence).filter((value) => typeof value === "number")
  const taskCost = sum(steps.map((step) => step.cost))
  const runCost = sum([taskCost, orchestrator.cost])
  const classification = run.signals.evidence?.semantic ?? {}
  const executionWaves = waves(run.graph)
  const modelTimeMs = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0)
  const starts = run.graph.nodes.map((target) => target.startedAt).filter(Boolean).map((at) => Date.parse(at))
  const ends = run.graph.nodes.map((target) => target.endedAt).filter(Boolean).map((at) => Date.parse(at))
  const wallClockMs = starts.length > 0 && ends.length > 0 ? Math.max(...ends) - Math.min(...starts) : 0

  const table = [
    "| Phase | Capability | Model | Attempts | Confidence | Time | Cost |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...steps.map((step) =>
      `| ${step.phase} | ${step.title}${step.escalated ? " ⬆" : ""} | \`${step.model}\` | ${step.attempts} | ${
        step.confidence === null ? "—" : step.confidence.toFixed(2)
      } | ${humanDuration(step.durationMs)} | ${step.usage.metered ? `${money} ${step.cost.toFixed(4)}` : "—"} |`,
    ),
  ].join("\n")

  return {
    runId: run.id,
    request: run.request,
    status: run.status,
    repo: run.repo ?? null,
    project: run.project ?? null,
    branch: run.branch ?? null,
    actor: run.actor ?? null,
    understanding: {
      intent: run.signals.intent,
      complexity: run.signals.complexity,
      band: run.signals.understanding,
      confidence: run.signals.classification_confidence,
      source: classification.source ?? "keywords",
      rationale: classification.rationale ?? null,
      disagreement: classification.disagreement ?? null,
      raised: classification.raised ?? null,
      ambiguities: classification.ambiguities ?? [],
    },
    capabilities: run.capabilities,
    strategy: run.strategy,
    why: run.policyTrace.map((entry) => ({
      stage: entry.stage,
      policy: entry.policy,
      added: entry.added,
      reason: entry.reason,
    })),
    steps,
    models: [...byModel.values()].sort((a, b) => b.steps - a.steps),
    orchestrator,
    contextTools,
    escalations: steps.filter((step) => step.escalated || step.switchedFrom),
    parallelism: {
      maxParallel: run.graph.maxParallel,
      waves: executionWaves.length,
      widest: executionWaves.reduce((widest, wave) => Math.max(widest, wave.length), 0),
      concurrent: executionWaves.map((wave) => wave.length),
      modelTimeMs,
      wallClockMs,
      speedup: wallClockMs > 0 ? Number((modelTimeMs / wallClockMs).toFixed(2)) : null,
    },
    totals: {
      nodes: steps.length,
      attempts: steps.reduce((total, step) => total + step.attempts, 0),
      files: [...new Set(steps.flatMap((step) => step.files))].length,
      reopenCycles: run.reopenCycles,
      durationMs: modelTimeMs,
      minConfidence: confidences.length > 0 ? Math.min(...confidences) : null,
      inputTokens: steps.reduce((total, step) => total + step.usage.inputTokens, 0) + (orchestrator.usage.inputTokens ?? 0),
      outputTokens: steps.reduce((total, step) => total + step.usage.outputTokens, 0) + (orchestrator.usage.outputTokens ?? 0),
      cachedTokens: steps.reduce((total, step) => total + (step.usage.cachedTokens ?? 0), 0) + (orchestrator.usage.cachedTokens ?? 0),
      tokens: steps.reduce((total, step) => total + step.usage.totalTokens, 0) + (orchestrator.usage.totalTokens ?? 0),
      taskCost,
      orchestratorCost: orchestrator.cost,
      tokensSaved: contextTools.reduce((total, tool) => total + (tool.tokensSaved ?? 0), 0),
      costSaved: sum(contextTools.map((tool) => tool.costSaved ?? 0)),
      cost: runCost,
      currency: money,
      metered: steps.some((step) => step.usage.metered) || Boolean(orchestrator.usage.metered),
      budget: budgetState(runCost, limits.perRun, limits.warnAt),
    },
    table,
  }
}

export { listRuns, loadRun, toMermaid, loadConfig }
