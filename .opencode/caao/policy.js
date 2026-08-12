/**
 * CAAO — policy engine.
 *
 * `base` policies are exclusive (first match wins) and produce the minimal
 * capability set. `augment` policies are additive and composed on top until a
 * fixpoint is reached, which is what makes composition rules such as
 * "migration implies testing" work without hardcoding a pipeline.
 */

import { evaluate } from "./match.js"

const MAX_COMPOSITION_PASSES = 8

export function resolveCapabilities(config, signals) {
  const trace = []
  const selected = []

  const baseRule = config.policies.base?.find((policy) => evaluate(policy.when ?? {}, signals))
  if (!baseRule) throw new Error("CAAO: no base policy matched — policies.yaml must declare a fallback")

  for (const id of baseRule.capabilities ?? []) if (!selected.includes(id)) selected.push(id)
  trace.push({ stage: "base", policy: baseRule.id, added: [...selected], reason: baseRule.reason ?? "baseline capability set" })

  const applied = new Set()
  for (let pass = 0; pass < MAX_COMPOSITION_PASSES; pass++) {
    let changed = false
    for (const policy of config.policies.augment ?? []) {
      if (applied.has(policy.id)) continue
      if (!evaluate(policy.when ?? {}, { ...signals, capabilities: selected })) continue

      const added = (policy.capabilities ?? []).filter((id) => !selected.includes(id))
      applied.add(policy.id)
      if (added.length === 0) continue

      selected.push(...added)
      trace.push({ stage: "augment", policy: policy.id, added, reason: policy.reason ?? "context policy" })
      changed = true
    }
    if (!changed) break
  }

  return { capabilities: selected, trace }
}

export function evaluatePost(config, signals) {
  const additions = []
  const trace = []
  let escalate = false

  for (const policy of config.policies.post ?? []) {
    if (!evaluate(policy.when ?? {}, signals)) continue
    const added = (policy.capabilities ?? []).filter((id) => !additions.includes(id))
    additions.push(...added)
    if (policy.escalate) escalate = true
    trace.push({ stage: "post", policy: policy.id, added, escalate: Boolean(policy.escalate), reason: policy.reason ?? "" })
  }

  return { capabilities: additions, escalate, trace }
}

export function selectStrategy(config, signals) {
  const rules = config.workflows.selection ?? []
  const rule = rules.find((candidate) => evaluate(candidate.when ?? {}, signals))
  const id = rule?.strategy ?? config.workflows.default
  const strategy = config.workflows.strategies?.[id]
  if (!strategy) throw new Error(`CAAO: unknown workflow strategy "${id}"`)
  return { id, rule: rule?.id ?? "default", ...strategy }
}
