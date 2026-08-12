/**
 * CAAO — request classification.
 *
 * Two layers. The keyword rules are a cheap, deterministic *prior*. The `triage`
 * capability supplies a *semantic verdict* produced by a model that actually read
 * the request. This module fuses them according to policies.classification.semantic,
 * so the amount of trust placed in the model is itself a declared policy — not a
 * hardcoded assumption. The fusion is pure, which keeps it reproducible and
 * testable without any model call.
 */

import { evaluate, firstMatch, matchedKeywords, matchesGlob } from "./match.js"

const RULE_META = new Set(["id", "default", "reason"])

function conditionOf(rule) {
  return Object.fromEntries(Object.entries(rule).filter(([key]) => !RULE_META.has(key)))
}

export function detectDomains(config, { text = "", files = [] } = {}) {
  const domains = config.policies.classification?.domains ?? {}
  const haystack = String(text).toLowerCase()
  const detected = []

  for (const [id, definition] of Object.entries(domains)) {
    const byKeyword = matchedKeywords(haystack, definition.keywords ?? [])
    const byPath = files.filter((file) => (definition.paths ?? []).some((glob) => matchesGlob(file, glob)))
    if (byKeyword.length > 0 || byPath.length > 0) {
      detected.push({ id, keywords: byKeyword, files: byPath })
    }
  }
  return detected
}

/**
 * Accepts either a parsed object or the raw JSON blob a triage worker returned,
 * possibly wrapped in prose or a fenced code block.
 */
export function normalizeTriage(triage) {
  if (!triage) return null
  let parsed = triage
  if (typeof triage === "string") {
    const match = triage.match(/\{[\s\S]*\}/)
    if (!match) return null
    try {
      parsed = JSON.parse(match[0])
    } catch {
      return null
    }
  }
  if (typeof parsed !== "object") return null

  const confidence = Number(parsed.confidence)
  return {
    intent: parsed.intent ?? null,
    complexity: parsed.complexity ?? null,
    domains: Array.isArray(parsed.domains) ? parsed.domains.map(String) : [],
    rationale: parsed.rationale ?? "",
    ambiguities: Array.isArray(parsed.ambiguities) ? parsed.ambiguities : [],
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
  }
}

function bandFor(semantic, confidence) {
  const bands = semantic.bands ?? []
  return bands.find((band) => confidence >= Number(band.min ?? 0)) ?? bands.at(-1) ?? { id: "guessed", adopt: "keywords" }
}

function raise(order, complexity, steps) {
  const index = order.indexOf(complexity)
  if (index < 0) return complexity
  return order[Math.min(order.length - 1, index + steps)]
}

function higher(order, a, b) {
  return order.indexOf(a) >= order.indexOf(b) ? a : b
}

/**
 * Fuses the keyword prior with the semantic verdict. How much the verdict is
 * trusted is declared in policies.yaml, never decided here.
 */
function fuse(config, prior, triage) {
  const semantic = config.policies.classification?.semantic ?? {}
  const order = semantic.complexity_order ?? ["trivial", "medium", "high", "critical"]

  if (!semantic.enabled || !triage) {
    return {
      ...prior,
      understanding: triage ? "guessed" : "keywords-only",
      confidence: triage ? triage.confidence : null,
      evidence: {
        source: "keywords",
        reason: semantic.enabled ? "no triage verdict supplied" : "semantic classification disabled",
        prior,
      },
    }
  }

  const band = bandFor(semantic, triage.confidence)
  const disagrees = Boolean(triage.intent) && triage.intent !== prior.intent
  const adopt = disagrees && band.adopt === "semantic" && band.id !== "confident"
    ? (semantic.on_disagreement ?? "conservative")
    : band.adopt

  let intent = prior.intent
  let complexity = prior.complexity

  if (adopt === "semantic") {
    intent = triage.intent ?? prior.intent
    complexity = triage.complexity ?? prior.complexity
  } else if (adopt === "conservative") {
    intent = triage.intent ?? prior.intent
    complexity = higher(order, prior.complexity, triage.complexity ?? prior.complexity)
  }

  if (band.raise_complexity) complexity = raise(order, complexity, Number(band.raise_complexity))

  const domains =
    (semantic.domains ?? "union") === "union"
      ? [...new Set([...prior.domains, ...triage.domains])]
      : triage.domains

  return {
    intent,
    complexity,
    domains,
    understanding: band.id,
    confidence: triage.confidence,
    evidence: {
      source: adopt,
      band: band.id,
      confidence: triage.confidence,
      disagreement: disagrees ? { keywords: prior.intent, semantic: triage.intent } : null,
      raised: band.raise_complexity ? `+${band.raise_complexity}` : null,
      rationale: triage.rationale,
      ambiguities: triage.ambiguities,
      prior,
      semantic: { intent: triage.intent, complexity: triage.complexity, domains: triage.domains },
    },
  }
}

export function classify(config, input = {}) {
  const request = String(input.request ?? "")
  const changedFiles = input.changedFiles ?? []
  const text = [request, ...changedFiles].join("\n")

  const keywordDomains = detectDomains(config, { text: request, files: changedFiles })
  const base = {
    text: text.toLowerCase(),
    request,
    touches: keywordDomains.map((domain) => domain.id),
    changed_files: input.changedFiles ? changedFiles.length : (input.changed_files ?? 0),
  }

  const rules = config.policies.classification ?? {}
  const intentRule = firstMatch(rules.intents ?? [], base, conditionOf)
  const complexityRule = firstMatch(rules.complexity ?? [], { ...base, intent: intentRule?.id ?? "implement" }, conditionOf)

  const prior = {
    intent: intentRule?.id ?? "implement",
    complexity: complexityRule?.id ?? "medium",
    domains: keywordDomains.map((domain) => domain.id),
  }

  const fusion = fuse(config, prior, normalizeTriage(input.triage))

  const intent = input.intent ?? fusion.intent
  const complexity = input.complexity ?? fusion.complexity
  const domains = fusion.domains.map(
    (id) => keywordDomains.find((domain) => domain.id === id) ?? { id, keywords: [], files: [], via: "semantic" },
  )

  return {
    ...base,
    touches: fusion.domains,
    intent,
    complexity,
    understanding: fusion.understanding,
    classification_confidence: fusion.confidence,
    domains,
    evidence: {
      intent: { rule: intentRule?.id ?? null, overridden: Boolean(input.intent) },
      complexity: { rule: complexityRule?.id ?? null, overridden: Boolean(input.complexity) },
      semantic: fusion.evidence,
      domains: domains.map((domain) => ({
        id: domain.id,
        via: domain.via ?? (domain.keywords.length > 0 ? "request" : domain.files.length > 0 ? "paths" : "semantic"),
        matched: domain.keywords.length > 0 ? domain.keywords : domain.files,
      })),
    },
  }
}

export { evaluate }
