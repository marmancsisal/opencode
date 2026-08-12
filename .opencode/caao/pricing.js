/**
 * CAAO — cost accounting.
 *
 * Two different numbers are deliberately kept apart:
 *   traits.cost  1..5, used to RANK candidates. Routing must stay stable when a
 *                price list changes.
 *   pricing      real USD per million tokens, used to BILL. Never read by the
 *                router.
 *
 * Everything here is pure arithmetic over recorded token counts. A run whose
 * workers never reported usage costs a known zero, not an invented estimate —
 * `metered` says which of the two it is.
 */

const MILLION = 1_000_000

export function currency(config) {
  return config.providers.defaults?.currency ?? "USD"
}

export function poolPricing(config, poolId) {
  const fallback = config.providers.defaults?.pricing ?? { input_per_mtok: 0, output_per_mtok: 0 }
  const pool = config.providers.pools?.[poolId]
  return { ...fallback, ...(pool?.pricing ?? {}) }
}

/** Cost of one model call. `pool` is the logical pool id, not the model string. */
export function costOf(config, poolId, { inputTokens = 0, outputTokens = 0, cachedTokens = 0 } = {}) {
  const pricing = poolPricing(config, poolId)
  // Cached input is billed by every provider we target at a fraction of the
  // input rate; until a pool declares its own multiplier, assume the common 10%.
  const cacheRate = pricing.cached_multiplier ?? 0.1
  const billableInput = Math.max(0, inputTokens - cachedTokens)

  const input = (billableInput / MILLION) * (pricing.input_per_mtok ?? 0)
  const cached = (cachedTokens / MILLION) * (pricing.input_per_mtok ?? 0) * cacheRate
  const output = (outputTokens / MILLION) * (pricing.output_per_mtok ?? 0)

  return round(input + cached + output)
}

export function round(amount) {
  return Number(amount.toFixed(6))
}

/** Money is summed in micro-units so a long run does not accumulate float drift. */
export function sum(amounts) {
  return round(amounts.reduce((total, amount) => total + Math.round((amount ?? 0) * MILLION), 0) / MILLION)
}

export function usageOf(result = {}) {
  const inputTokens = result.tokens_in ?? result.inputTokens ?? 0
  const outputTokens = result.tokens_out ?? result.outputTokens ?? 0
  const cachedTokens = result.tokens_cached ?? result.cachedTokens ?? 0
  return {
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
    metered: inputTokens > 0 || outputTokens > 0,
  }
}

export function budgets(config) {
  return {
    currency: currency(config),
    warnAt: config.providers.budgets?.warn_at ?? 0.8,
    monthlyTotal: config.providers.budgets?.monthly_total ?? null,
    perRepoMonthly: config.providers.budgets?.per_repo_monthly ?? null,
    perRun: config.providers.budgets?.per_run ?? null,
  }
}

/** `ok` | `warn` | `over` — the only three states the dashboard renders. */
export function budgetState(spent, limit, warnAt = 0.8) {
  if (!limit || limit <= 0) return { state: "none", used: null, limit: null }
  const used = spent / limit
  return { state: used >= 1 ? "over" : used >= warnAt ? "warn" : "ok", used: Number(used.toFixed(4)), limit }
}

/** Per-million-token price table, for the dashboard's provider view. */
export function priceTable(config) {
  return Object.entries(config.providers.pools ?? {}).map(([id, pool]) => {
    const pricing = poolPricing(config, id)
    return {
      pool: id,
      model: pool.model,
      tier: pool.tier,
      inputPerMTok: pricing.input_per_mtok ?? 0,
      outputPerMTok: pricing.output_per_mtok ?? 0,
      priced: (pricing.input_per_mtok ?? 0) > 0 || (pricing.output_per_mtok ?? 0) > 0,
    }
  })
}
