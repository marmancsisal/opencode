/**
 * CAAO — context-tool savings.
 *
 * Compression MCP servers (headroom, caveman) and retrieval layers exist to buy
 * back context window. Whether they actually do is an empirical question, and
 * until it is measured they are a cost with an assumed benefit.
 *
 * CAAO cannot see the uncompressed payload — by construction, the tool already
 * compressed it. So the figure is taken from what the tool itself reports, in
 * its result metadata or in its output text, using a rule declared in
 * catalog.yaml. A tool that reports nothing is shown as "not reported", never
 * as a number somebody invented.
 */

const NUMBER = /^-?\d+(\.\d+)?$/

function pathValue(source, path) {
  return String(path)
    .split(".")
    .reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), source)
}

function firstNumber(sources, paths = []) {
  for (const path of paths) {
    for (const source of sources) {
      if (!source || typeof source !== "object") continue
      const value = pathValue(source, path)
      if (typeof value === "number" && Number.isFinite(value)) return value
      if (typeof value === "string" && NUMBER.test(value.trim())) return Number(value.trim())
    }
  }
  return null
}

function fromPattern(pattern, output) {
  if (!pattern || typeof output !== "string") return {}
  let regex
  try {
    regex = new RegExp(pattern)
  } catch {
    return {}
  }
  const match = regex.exec(output)
  if (!match?.groups) return {}
  const read = (name) => (match.groups[name] !== undefined && NUMBER.test(match.groups[name]) ? Number(match.groups[name]) : null)
  return { before: read("before"), after: read("after"), saved: read("saved") }
}

/**
 * opencode namespaces MCP tools with the server id (`headroom_headroom_compress`,
 * `caveman*compress`), and the separator has changed between releases. Match on
 * the declared tool name appearing as a whole segment rather than on equality.
 */
export function toolBelongsTo(entry, toolName) {
  if (!entry || typeof toolName !== "string" || toolName === "") return false
  const declared = [...(entry.savings?.tools ?? []), ...(entry.tools ?? [])]
  const segments = toolName.split(/[_*./-]+/).filter(Boolean)
  const normalised = toolName.toLowerCase()

  for (const candidate of declared) {
    const name = String(candidate).toLowerCase()
    if (normalised === name) return true
    if (normalised.endsWith(name) || normalised.startsWith(`${name}`)) return true
  }
  return segments[0]?.toLowerCase() === String(entry.id).toLowerCase()
}

/**
 * The savings one tool call reports. `reported: false` means the call happened
 * but the tool published no figure — the dashboard says so rather than
 * pretending the saving was zero.
 */
export function extractSavings(entry, { tool, output = "", metadata = null } = {}) {
  if (!toolBelongsTo(entry, tool)) return null

  const rule = entry.savings ?? {}
  const sources = [metadata, metadata?.stats, metadata?.savings, metadata?.usage]
  const patterned = fromPattern(rule.pattern, output)

  const before = firstNumber(sources, rule.metadata?.before ?? DEFAULT_PATHS.before) ?? patterned.before
  const after = firstNumber(sources, rule.metadata?.after ?? DEFAULT_PATHS.after) ?? patterned.after
  const savedDirect = firstNumber(sources, rule.metadata?.saved ?? DEFAULT_PATHS.saved) ?? patterned.saved

  const saved =
    savedDirect !== null && savedDirect !== undefined
      ? savedDirect
      : before !== null && before !== undefined && after !== null && after !== undefined
        ? before - after
        : null

  return {
    id: entry.id,
    tool,
    tokensBefore: before ?? null,
    tokensAfter: after ?? null,
    tokensSaved: saved === null || saved === undefined ? null : Math.max(0, Math.round(saved)),
    reported: saved !== null && saved !== undefined,
  }
}

/** Key names compression tools use in practice, tried before the declared ones. */
const DEFAULT_PATHS = {
  before: ["original_tokens", "originalTokens", "tokens_before", "tokensBefore", "input_tokens", "before"],
  after: ["compressed_tokens", "compressedTokens", "tokens_after", "tokensAfter", "output_tokens", "after"],
  saved: ["tokens_saved", "tokensSaved", "saved_tokens", "savedTokens", "saved"],
}

/** The catalog entry, if any, that owns a tool call. */
export function ownerOf(contextTools, toolName) {
  return contextTools.find((entry) => entry.enabled !== false && toolBelongsTo(entry, toolName)) ?? null
}
