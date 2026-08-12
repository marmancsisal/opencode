/**
 * CAAO — observed token accounting.
 *
 * A worker cannot report its own token counts: it never sees them. Asking the
 * model to guess them produced exactly what you would expect — zeros, and a
 * dashboard that billed every run at $0.00.
 *
 * opencode, on the other hand, knows them exactly: every assistant message
 * carries the provider's usage report. This module turns those events into the
 * shape the engine bills, and answers the only genuinely hard question
 * involved: which task in flight produced this message.
 *
 * Pure functions. The engine owns the state; this file owns the interpretation.
 */

/** Agents that are the orchestrator itself rather than a capability worker. */
export const ORCHESTRATOR_AGENTS = new Set(["caao", "build", "general", "plan", "primary"])

/** How long after a node finished a late assistant message still belongs to it. */
const LATE_ARRIVAL_MS = 120_000

export const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  calls: 0,
  metered: false,
}

/**
 * Normalise one opencode event into a billable observation, or null.
 *
 * Only completed assistant messages are billable: `message.updated` fires on
 * every streamed chunk, and billing a partial message would count the same
 * tokens dozens of times.
 */
export function observationFrom(event) {
  if (event?.type !== "message.updated") return null
  const info = event.properties?.info
  if (!info || info.role !== "assistant") return null
  if (!info.time?.completed) return null

  const tokens = info.tokens ?? {}
  const output = Math.max(0, Number(tokens.output ?? 0))
  const reasoning = Math.max(0, Number(tokens.reasoning ?? 0))
  const cached = Math.max(0, Number(tokens.cache?.read ?? 0))
  // The provider reports fresh input and cache reads separately; CAAO bills a
  // single input figure and discounts the cached share of it, so add them here.
  const input = Math.max(0, Number(tokens.input ?? 0)) + cached
  if (input + output === 0) return null

  return {
    messageId: info.id ?? null,
    sessionId: info.sessionID ?? null,
    // opencode writes the agent name to both fields; `mode` is the legacy one
    // and is still what the published type declares, so accept either.
    agent: info.agent ?? info.mode ?? null,
    model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : (info.modelID ?? null),
    completedAt: new Date(info.time.completed).toISOString(),
    // What opencode itself computed. Kept as a fallback for pools that declare
    // no price list, and never silently preferred over the company price list.
    providerCost: Math.max(0, Number(info.cost ?? 0)),
    usage: {
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      reasoningTokens: reasoning,
      totalTokens: input + output,
      calls: 1,
      metered: true,
    },
  }
}

export function addUsage(base, delta) {
  const left = base ?? ZERO_USAGE
  const right = delta ?? ZERO_USAGE
  return {
    inputTokens: (left.inputTokens ?? 0) + (right.inputTokens ?? 0),
    outputTokens: (left.outputTokens ?? 0) + (right.outputTokens ?? 0),
    cachedTokens: (left.cachedTokens ?? 0) + (right.cachedTokens ?? 0),
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0),
    calls: (left.calls ?? 0) + (right.calls ?? 0),
    metered: Boolean(left.metered) || Boolean(right.metered),
  }
}

export function subtractUsage(total, accounted) {
  const left = total ?? ZERO_USAGE
  const right = accounted ?? ZERO_USAGE
  const clamp = (value) => Math.max(0, value)
  return {
    inputTokens: clamp((left.inputTokens ?? 0) - (right.inputTokens ?? 0)),
    outputTokens: clamp((left.outputTokens ?? 0) - (right.outputTokens ?? 0)),
    cachedTokens: clamp((left.cachedTokens ?? 0) - (right.cachedTokens ?? 0)),
    reasoningTokens: clamp((left.reasoningTokens ?? 0) - (right.reasoningTokens ?? 0)),
    totalTokens: clamp((left.totalTokens ?? 0) - (right.totalTokens ?? 0)),
    calls: clamp((left.calls ?? 0) - (right.calls ?? 0)),
    metered: (left.metered ?? false) && (left.totalTokens ?? 0) > (right.totalTokens ?? 0),
  }
}

/** The pool whose declared model matches what actually answered. */
export function poolForModel(config, model) {
  if (!model) return null
  const pools = config.providers.pools ?? {}
  for (const [id, pool] of Object.entries(pools)) {
    if (pool.model === model) return id
    // opencode reports "provider/model"; a pool may declare only the model id.
    if (typeof pool.model === "string" && pool.model.endsWith(`/${model}`)) return id
  }
  return null
}

/**
 * Which running task produced this message.
 *
 * The agent name is the strong signal: `caao-implementation--opus-5` is dispatched
 * for exactly one capability on exactly one pool. When several identical workers
 * run in parallel — a planning fan-out — no signal can tell them apart, so the
 * least-billed one takes the message. Across the wave the totals are exact; per
 * node they are a fair split, which is what the dashboard reports.
 */
export function attributionTarget(run, observation, { now = Date.now() } = {}) {
  // The Execution Manager runs under a generic agent name. It also frequently
  // runs on the same pool as the workers it dispatched, so the model fallback
  // below would happily charge its planning to whichever task is in flight.
  if (ORCHESTRATOR_AGENTS.has(observation.agent)) return null

  const nodes = run.graph?.nodes ?? []
  const running = nodes.filter((node) => node.status === "running")

  const byAgent = running.filter((node) => node.agent === observation.agent)
  const byModel = running.filter((node) => node.provider?.model === observation.model)
  const candidates = byAgent.length > 0 ? byAgent : byModel

  if (candidates.length > 0) {
    return [...candidates].sort(
      (a, b) => (a.usage?.calls ?? 0) - (b.usage?.calls ?? 0) || String(a.startedAt).localeCompare(String(b.startedAt)),
    )[0]
  }

  // A worker's final message can land after the Execution Manager recorded it.
  const justFinished = nodes.filter(
    (node) =>
      node.agent === observation.agent &&
      node.endedAt &&
      now - Date.parse(node.endedAt) >= 0 &&
      now - Date.parse(node.endedAt) < LATE_ARRIVAL_MS,
  )
  if (justFinished.length > 0) {
    return justFinished.sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))[0]
  }

  return null
}
