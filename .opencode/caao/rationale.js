/**
 * CAAO — "why this DAG?"
 *
 * Every graph CAAO builds is the product of a deterministic chain: the request
 * was classified, the classification selected capabilities through declared
 * policies, the capabilities were wired by declared phase dependencies, and
 * each node was bound to a model by a declared routing strategy.
 *
 * This module replays that chain as an ordered narrative so a developer never
 * has to take the plan on faith — and an admin can audit why an expensive model
 * was chosen for a given task.
 */

import { loadConfig } from "./config.js"
import { waves } from "./dag.js"

function pct(value) {
  return typeof value === "number" ? `${Math.round(value * 100)}%` : "n/a"
}

function list(values) {
  const items = (values ?? []).filter(Boolean)
  if (items.length === 0) return "none"
  if (items.length === 1) return items[0]
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
}

/** Step 1 — how the sentence was turned into structured signals. */
function understandingStep(run) {
  const semantic = run.signals?.evidence?.semantic ?? {}
  const keywords = run.signals?.evidence?.keywords ?? {}
  const semanticUsed = semantic.source === "semantic" || semantic.source === "model"

  const facts = [
    `Intent read as **${run.signals?.intent}**.`,
    `Complexity read as **${run.signals?.complexity}**.`,
    `Classification confidence ${pct(run.signals?.classification_confidence)} → understanding band **${run.signals?.understanding}**.`,
  ]
  if (semantic.rationale) facts.push(`Classifier rationale: "${semantic.rationale}"`)
  if (semantic.disagreement) facts.push(`The semantic and keyword readings disagreed (${semantic.disagreement}), so confidence was lowered.`)
  if (semantic.raised) facts.push(`Complexity was raised to ${semantic.raised} because the request implies more than it states.`)
  if ((semantic.ambiguities ?? []).length > 0) facts.push(`Open ambiguities: ${list(semantic.ambiguities)}.`)
  if (run.signals?.touches?.length > 0) facts.push(`Sensitive areas touched: ${list(run.signals.touches)}.`)
  if (run.signals?.changed_files > 0) facts.push(`${run.signals.changed_files} changed files in the working tree.`)

  return {
    step: 1,
    stage: "understanding",
    title: "The request was classified",
    summary: semanticUsed
      ? "A model read the request and produced structured signals; keyword matching was used only as a cross-check."
      : "No semantic classification was available, so the deterministic keyword reading was used.",
    source: semantic.source ?? "keywords",
    detail: facts,
    evidence: { semantic, keywords },
  }
}

/** Step 2 — which declared policies turned those signals into capabilities. */
function policySteps(run) {
  const trace = run.policyTrace ?? []
  return trace.map((entry, index) => ({
    step: 2 + index,
    stage: `policy:${entry.stage}`,
    title:
      entry.stage === "base"
        ? `Baseline set chosen by rule \`${entry.policy}\``
        : `Policy \`${entry.policy}\` added ${list(entry.added)}`,
    summary: entry.reason || "declared policy",
    added: entry.added ?? [],
    policy: entry.policy,
    escalate: Boolean(entry.escalate),
    detail: [
      `Rule \`${entry.policy}\` fired at the **${entry.stage}** stage.`,
      `Reason as declared in policies.yaml: "${entry.reason || "—"}".`,
      entry.added?.length > 0 ? `Capabilities added: ${list(entry.added)}.` : "No new capabilities were needed.",
    ],
  }))
}

/** Step 3 — why the graph has this shape rather than a straight line. */
function topologyStep(run, config, offset) {
  const execution = config.workflows?.execution ?? {}
  const depends = execution.phase_depends_on ?? {}
  const graph = run.graph ?? { nodes: [] }
  const shape = waves(graph)
  const phases = [...new Set(graph.nodes.map((node) => node.phase))]

  const wiring = phases.map((phase) => {
    const upstream = depends[phase] ?? []
    return upstream.length === 0
      ? `**${phase}** has no declared prerequisites, so it starts immediately.`
      : `**${phase}** waits for ${list(upstream)} to finish, as declared in workflows.yaml.`
  })

  return {
    step: offset,
    stage: "topology",
    title: `Strategy \`${run.strategy?.id}\` shaped a ${shape.length}-wave graph`,
    summary: `Selection rule \`${run.strategy?.rule}\` matched, allowing up to ${run.strategy?.maxParallel} agents at once.`,
    detail: [
      `Strategy \`${run.strategy?.id}\` was chosen by rule \`${run.strategy?.rule}\` in workflows.yaml.`,
      `Edges are not hand-drawn: they come from phase dependencies.`,
      ...wiring,
      `Result: ${shape.length} wave${shape.length === 1 ? "" : "s"} of ${shape.map((wave) => wave.length).join(" → ")} task(s), the widest running ${Math.max(
        0,
        ...shape.map((wave) => wave.length),
      )} agents in parallel.`,
    ],
    waves: shape.map((wave, index) => ({
      index: index + 1,
      nodes: wave.map((id) => {
        const node = graph.nodes.find((candidate) => candidate.id === id)
        return { id, title: node?.title ?? id, phase: node?.phase ?? null, capability: node?.capability ?? null }
      }),
    })),
  }
}

/** Step 4 — why each node is running on the model it is running on. */
function routingStep(run, offset) {
  const nodes = (run.graph?.nodes ?? []).filter((node) => node.status !== "expanded")
  const bindings = nodes.map((node) => {
    const provider = node.provider ?? {}
    const history = node.providerHistory ?? []
    const reasons = []
    reasons.push(
      `Capability \`${node.capability}\` is bound to profile \`${provider.tier ?? "?"}\` with strategy \`${provider.strategy ?? "?"}\`.`,
    )
    if (provider.escalated) reasons.push(`Escalated: ${provider.escalationReason ?? "an override in providers.yaml matched the run signals"}.`)
    if (provider.fallback) reasons.push(`The preferred pool was unavailable, so the next candidate in the profile was used.`)
    if (history.length > 1) reasons.push(`${history.length} routing decisions were made for this node (retry or provider switch).`)
    return {
      node: node.id,
      title: node.title,
      capability: node.capability,
      phase: node.phase,
      status: node.status,
      model: provider.model ?? null,
      pool: provider.pool ?? null,
      tier: provider.tier ?? null,
      escalated: Boolean(provider.escalated),
      why: reasons,
    }
  })

  const escalated = bindings.filter((binding) => binding.escalated)

  return {
    step: offset,
    stage: "routing",
    title: `${new Set(bindings.map((binding) => binding.model)).size} distinct model(s) were bound to ${bindings.length} task(s)`,
    summary:
      escalated.length > 0
        ? `${escalated.length} task(s) were escalated to a heavier model because the run signals matched a declared override.`
        : "No escalation was necessary: every task ran on its default profile.",
    detail: [
      `Model choice is per capability, never per run: cheap work stays cheap even inside an expensive run.`,
      ...escalated.map((binding) => `\`${binding.title}\` → \`${binding.model}\` — ${binding.why.at(-1) ?? ""}`),
    ],
    bindings,
  }
}

/**
 * Full causal chain for a run, ordered from the raw sentence to the model that
 * executed each task.
 */
export function explain(run, config = loadConfig()) {
  const policies = policySteps(run)
  const offset = 2 + policies.length
  const steps = [understandingStep(run), ...policies, topologyStep(run, config, offset), routingStep(run, offset + 1)]

  return {
    runId: run.id,
    request: run.request,
    headline: `"${run.request}" was read as a ${run.signals?.complexity} ${run.signals?.intent} task with ${pct(
      run.signals?.classification_confidence,
    )} confidence, which selected ${run.capabilities?.length ?? 0} capabilities and the \`${run.strategy?.id}\` strategy.`,
    steps,
    capabilities: run.capabilities ?? [],
    counterfactuals: counterfactuals(run),
  }
}

/**
 * "What would have had to be different for a different plan?" — the fastest way
 * for an admin to understand a routing decision is to see its boundary.
 */
export function counterfactuals(run) {
  const notes = []
  const confidence = run.signals?.classification_confidence ?? 0

  if (run.signals?.understanding !== "clear") {
    notes.push(
      `Confidence was ${pct(confidence)}. Above the accept threshold the run would have skipped the extra research and clarification work.`,
    )
  } else {
    notes.push(`Confidence was ${pct(confidence)}, above the accept threshold, so no clarification capability was added.`)
  }

  if (!(run.capabilities ?? []).includes("security")) {
    notes.push("No security-sensitive path was touched; touching auth, crypto or payments would have added a security review node.")
  } else {
    notes.push("A security-sensitive path was touched, which is why a security review is present and blocking.")
  }

  if ((run.reopenCycles ?? 0) > 0) {
    notes.push(`${run.reopenCycles} reopen cycle(s) happened: a reviewer returned blocking findings, so the build phase and everything downstream was re-run.`)
  }

  const parallel = run.strategy?.maxParallel ?? 1
  notes.push(
    parallel > 1
      ? `Strategy \`${run.strategy?.id}\` allows ${parallel} concurrent agents; a simpler request would have matched a sequential strategy.`
      : `Strategy \`${run.strategy?.id}\` is deliberately sequential; a broader or riskier request would have matched a parallel strategy.`,
  )

  return notes
}
