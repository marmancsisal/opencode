/**
 * CAAO — condition matcher.
 *
 * One grammar shared by classification rules, policies and workflow selection.
 * Conditions never reference agents, models or providers.
 */

const NUMERIC_OPS = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
}

const LIST_SIGNALS = new Set(["touches", "capabilities", "intent", "complexity", "strategy", "understanding"])

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Word-boundary aware keyword match that also supports multi-word phrases. */
export function matchesKeyword(text, keyword) {
  const pattern = escapeRegex(String(keyword).toLowerCase().trim()).replace(/\\?\s+/g, "\\s+")
  return new RegExp(`(?<![a-z0-9])${pattern}(?![a-z0-9])`, "i").test(text)
}

export function matchedKeywords(text, keywords = []) {
  const haystack = String(text ?? "").toLowerCase()
  return keywords.filter((keyword) => matchesKeyword(haystack, keyword))
}

/** Minimal glob support: `**`, `*` and `?`. Enough for path domain detection. */
export function matchesGlob(path, glob) {
  const normalized = String(path).replace(/\\/g, "/")
  const pattern = escapeRegex(String(glob).replace(/\\/g, "/"))
    .replace(/\\\*\\\*\//g, "(?:.*/)?")
    .replace(/\\\*\\\*/g, ".*")
    .replace(/\\\*/g, "[^/]*")
    .replace(/\\\?/g, "[^/]")
  return new RegExp(`^${pattern}$`, "i").test(normalized)
}

function asArray(value) {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function matchNumeric(actual, spec) {
  // An absent numeric signal is unknown, not zero: unknown never satisfies a comparison.
  if (actual === null || actual === undefined) return false
  if (typeof spec === "number") return actual === spec
  return Object.entries(spec).every(([op, expected]) => {
    const fn = NUMERIC_OPS[op]
    if (!fn) throw new Error(`Unknown numeric operator: ${op}`)
    return fn(Number(actual), Number(expected))
  })
}

function matchSignal(key, expected, signals) {
  if (key === "always") return Boolean(expected)
  if (key === "keywords") return matchedKeywords(signals.text ?? "", asArray(expected)).length > 0
  if (key === "keywords_all") {
    const wanted = asArray(expected)
    return matchedKeywords(signals.text ?? "", wanted).length === wanted.length
  }
  if (LIST_SIGNALS.has(key)) {
    const actual = asArray(signals[key]).map(String)
    return asArray(expected).some((value) => actual.includes(String(value)))
  }
  if (typeof expected === "object" && !Array.isArray(expected)) {
    return matchNumeric(signals[key], expected)
  }
  return signals[key] === expected
}

/**
 * Evaluate a condition object.
 * Top-level keys are ANDed. `any` ORs its inner keys, `all` ANDs them, `not` negates.
 */
export function evaluate(condition, signals) {
  if (!condition || Object.keys(condition).length === 0) return false

  return Object.entries(condition).every(([key, expected]) => {
    if (key === "any") return Object.entries(expected).some(([k, v]) => matchSignal(k, v, signals))
    if (key === "all") return Object.entries(expected).every(([k, v]) => matchSignal(k, v, signals))
    if (key === "not") return !evaluate(expected, signals)
    return matchSignal(key, expected, signals)
  })
}

/** Returns the first rule whose condition matches, or the rule flagged `default`. */
export function firstMatch(rules, signals, conditionOf = (rule) => rule.when) {
  for (const rule of rules) {
    if (rule.default === true) return rule
    if (evaluate(conditionOf(rule) ?? {}, signals)) return rule
  }
  return rules.find((rule) => rule.default === true)
}
