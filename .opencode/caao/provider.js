/**
 * CAAO — provider resolution.
 *
 * Capabilities never know which model executes them. Resolution happens here,
 * driven exclusively by providers.yaml. Changing a model is a one-line edit.
 *
 * A binding may declare `overrides`: conditional re-bindings evaluated against
 * the run signals. That is how "if the request was not understood confidently,
 * use a heavy model" is expressed without a single line of JavaScript.
 */

import { evaluate } from "./match.js"

function traitValue(pool, trait) {
  return Number(pool.traits?.[trait] ?? 0)
}

/**
 * `rank_by` entries are trait names, optionally prefixed with `-` for descending.
 * Ties fall back to the author-declared candidate order.
 */
function rank(candidates, pools, rankBy = []) {
  return candidates
    .map((id, index) => ({ id, index, pool: pools[id] }))
    .sort((a, b) => {
      for (const spec of rankBy) {
        const descending = spec.startsWith("-")
        const trait = descending ? spec.slice(1) : spec
        const delta = traitValue(a.pool, trait) - traitValue(b.pool, trait)
        if (delta !== 0) return descending ? -delta : delta
      }
      return a.index - b.index
    })
    .map((entry) => entry.id)
}

/** The opencode agent that carries a given capability/pool combination. */
export function agentName(capabilityId, poolId, defaultPoolId) {
  return poolId === defaultPoolId ? `caao-${capabilityId}` : `caao-${capabilityId}--${poolId}`
}

function resolveOverride(registry, binding, signals) {
  if (!signals) return null
  for (const override of binding.overrides ?? []) {
    if (!evaluate(override.when ?? {}, signals)) continue
    const profile = override.profile ? registry.profiles?.[override.profile] : null
    if (override.profile && !profile) throw new Error(`CAAO: unknown provider profile "${override.profile}"`)
    return {
      strategy: override.strategy ?? profile?.strategy,
      candidates: override.candidates ?? profile?.candidates,
      reason: override.reason ?? `override via profile "${override.profile}"`,
      profile: override.profile ?? null,
    }
  }
  return null
}

/** Every pool a capability can ever land on, across its binding and overrides. */
export function poolsFor(config, capabilityId) {
  const registry = config.providers
  const binding = registry.bindings?.[capabilityId] ?? {}
  const fromOverrides = (binding.overrides ?? []).flatMap((override) => {
    const profile = override.profile ? registry.profiles?.[override.profile] : null
    return override.candidates ?? profile?.candidates ?? []
  })
  return [...new Set([...(binding.candidates ?? []), ...fromOverrides])]
}

export function resolveProvider(config, capabilityId, { attempt = 0, signals = null } = {}) {
  const registry = config.providers
  const binding = registry.bindings?.[capabilityId]
  if (!binding) throw new Error(`CAAO: capability "${capabilityId}" has no provider binding`)

  const defaultStrategyId = binding.strategy ?? registry.defaults?.strategy ?? "declared"
  const defaultStrategy = registry.strategies?.[defaultStrategyId]
  if (!defaultStrategy) throw new Error(`CAAO: unknown provider strategy "${defaultStrategyId}"`)
  const defaultPool = rank(binding.candidates ?? [], registry.pools ?? {}, defaultStrategy.rank_by ?? [])[0]

  const override = resolveOverride(registry, binding, signals)
  const strategyId = override?.strategy ?? defaultStrategyId
  const strategy = registry.strategies?.[strategyId]
  if (!strategy) throw new Error(`CAAO: unknown provider strategy "${strategyId}"`)

  const candidates = override?.candidates ?? binding.candidates ?? []
  const ordered = rank(candidates, registry.pools ?? {}, strategy.rank_by ?? [])
  if (ordered.length === 0) throw new Error(`CAAO: capability "${capabilityId}" has no provider candidates`)

  const index = Math.min(attempt, ordered.length - 1)
  const selectedId = ordered[index]
  const pool = registry.pools[selectedId]

  return {
    capability: capabilityId,
    strategy: strategyId,
    pool: selectedId,
    tier: pool.tier ?? "standard",
    model: pool.model,
    temperature: pool.temperature,
    traits: pool.traits ?? {},
    agent: agentName(capabilityId, selectedId, defaultPool),
    defaultPool,
    escalated: Boolean(override) && selectedId !== defaultPool,
    escalationReason: override && selectedId !== defaultPool ? override.reason : null,
    order: ordered,
    fallbacks: ordered.slice(index + 1),
    exhausted: index >= ordered.length - 1,
    timeout_ms: registry.defaults?.timeout_ms,
  }
}

export function providerTable(config) {
  return Object.keys(config.providers.bindings ?? {}).map((id) => {
    const resolved = resolveProvider(config, id)
    return {
      capability: id,
      strategy: resolved.strategy,
      selected: resolved.model,
      tier: resolved.tier,
      fallbacks: resolved.fallbacks.map((pool) => config.providers.pools[pool].model),
      escalations: (config.providers.bindings[id].overrides ?? []).map((override) => ({
        when: override.when,
        to: override.profile ?? "inline",
        reason: override.reason ?? "",
      })),
    }
  })
}
