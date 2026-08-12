/**
 * CAAO — central MCP & skill distribution.
 *
 * A platform team declares MCP servers and skills once in catalog.yaml; every
 * developer machine resolves its own slice of that catalog based on the
 * repository it is working in and the team it belongs to.
 *
 * The catalog is data, not code: this module only filters it and renders the
 * `mcp` block opencode expects. Secrets are never stored — entries reference
 * environment variable names via the `{env:NAME}` placeholder, which is
 * resolved by opencode at launch, not here.
 */

const ENV_PLACEHOLDER = /\{env:([A-Z0-9_]+)\}/g

function entries(catalog, kind) {
  const defaults = catalog?.defaults ?? {}
  return (catalog?.[kind] ?? []).map((entry) => ({
    scope: defaults.scope ?? "all",
    enabled: defaults.enabled ?? true,
    ...entry,
    kindGroup: kind,
  }))
}

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

function contextMcp(entry) {
  if (!entry.mcp) return null
  return { id: entry.id, title: entry.title, enabled: entry.enabled, scope: entry.scope, owner: entry.owner, ...entry.mcp }
}

/** `all`, `{repos: []}` or `{teams: []}` — anything else is a configuration error. */
export function matchesScope(scope, { repo = null, team = null } = {}) {
  if (!scope || scope === "all") return true
  if (typeof scope === "string") return scope === "all"
  const repos = scope.repos ?? []
  const teams = scope.teams ?? []
  if (repos.length === 0 && teams.length === 0) return true
  if (repos.length > 0 && repo && repos.includes(repo)) return true
  if (teams.length > 0 && team && teams.includes(team)) return true
  return false
}

function requiredEnv(entry) {
  const found = new Set()
  const walk = (value) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(ENV_PLACEHOLDER)) found.add(match[1])
      return
    }
    if (Array.isArray(value)) return value.forEach(walk)
    if (value && typeof value === "object") return Object.values(value).forEach(walk)
  }
  walk(entry.command)
  walk(entry.environment)
  walk(entry.headers)
  walk(entry.url)
  return [...found]
}

/** The whole catalog, annotated — this is what the admin dashboard lists. */
export function catalog(config) {
  const source = config.catalog ?? {}
  const mcp = entries(source, "mcp").map((entry) => ({
    ...entry,
    requiredEnv: requiredEnv(entry),
    scopeLabel: scopeLabel(entry.scope),
  }))
  const skills = entries(source, "skills").map((entry) => ({
    ...entry,
    scopeLabel: scopeLabel(entry.scope),
  }))
  const contextTools = entries(source, "context_tools").map((entry) => ({
    ...entry,
    requiredEnv: requiredEnv(entry.mcp ?? entry),
    scopeLabel: scopeLabel(entry.scope),
  }))

  return {
    version: source.version ?? 1,
    mcp,
    skills,
    contextTools,
    totals: {
      mcp: mcp.length,
      mcpEnabled: mcp.filter((entry) => entry.enabled).length,
      skills: skills.length,
      skillsEnabled: skills.filter((entry) => entry.enabled).length,
      contextTools: contextTools.length,
      contextToolsEnabled: contextTools.filter((entry) => entry.enabled).length,
      owners: [...new Set([...mcp, ...skills, ...contextTools].map((entry) => entry.owner).filter(Boolean))],
    },
  }
}

export function scopeLabel(scope) {
  if (!scope || scope === "all") return "all developers"
  if (scope.repos?.length > 0 && scope.teams?.length > 0) {
    return `repos ${scope.repos.join(", ")} + teams ${scope.teams.join(", ")}`
  }
  if (scope.repos?.length > 0) return `repos ${scope.repos.join(", ")}`
  if (scope.teams?.length > 0) return `teams ${scope.teams.join(", ")}`
  return "all developers"
}

/**
 * What a specific machine should receive. `repo` is the owner/name slug CAAO
 * already derives from the git remote, so a developer never has to declare it.
 */
export function manifestFor(config, { repo = null, team = null } = {}) {
  const full = catalog(config)
  const applies = (entry) => entry.enabled && matchesScope(entry.scope, { repo, team })

  const mcp = full.mcp.filter(applies)
  const skills = full.skills.filter(applies)
  const contextTools = full.contextTools.filter(applies)
  const contextMcpEntries = contextTools.map(contextMcp).filter(Boolean)

  return {
    generatedAt: new Date().toISOString(),
    target: { repo, team },
    mcp,
    skills,
    contextTools,
    excluded: {
      mcp: full.mcp.filter((entry) => !applies(entry)).map((entry) => ({ id: entry.id, reason: exclusion(entry, repo, team) })),
      skills: full.skills.filter((entry) => !applies(entry)).map((entry) => ({ id: entry.id, reason: exclusion(entry, repo, team) })),
      contextTools: full.contextTools.filter((entry) => !applies(entry)).map((entry) => ({ id: entry.id, reason: exclusion(entry, repo, team) })),
    },
    requiredEnv: [...new Set([...mcp, ...contextTools].flatMap((entry) => entry.requiredEnv ?? []))],
    opencode: { mcp: mcpBlock([...mcp, ...contextMcpEntries]) },
  }
}

/** Skill guidance selected for one worker and one repository. */
export function skillInstructionsFor(config, capabilityId, target = {}) {
  return manifestFor(config, target).skills
    .filter((entry) => !entry.capabilities?.length || entry.capabilities.includes(capabilityId))
    .map(({ id, title, version, file, content }) => ({ id, title, version: version ?? null, file, content: content ?? null }))
}

function exclusion(entry, repo, team) {
  if (!entry.enabled) return "disabled in the catalog"
  return `out of scope for ${repo ?? "this repository"}${team ? ` / team ${team}` : ""} (${scopeLabel(entry.scope)})`
}

/** Renders the `mcp` object opencode.json expects. */
export function mcpBlock(mcpEntries) {
  const block = Object.create(null)
  for (const entry of mcpEntries) {
    block[entry.id] =
      entry.kind === "remote"
        ? { type: "remote", url: entry.url, enabled: true, ...(entry.headers ? { headers: entry.headers } : {}) }
        : { type: "local", command: entry.command ?? [], enabled: true, ...(entry.environment ? { environment: entry.environment } : {}) }
  }
  return block
}

/** Fails loudly rather than silently shipping a half-declared server. */
export function validateCatalog(source = {}) {
  const problems = []
  const seen = new Set()

  const validateCommon = (entry, kind) => {
    if (!entry.id) problems.push(`a ${kind} entry has no id`)
    else if (!SAFE_ID.test(entry.id)) problems.push(`${kind} id "${entry.id}" is invalid`)
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") problems.push(`${kind} "${entry.id}" enabled must be boolean`)
    const scope = entry.scope
    if (scope && scope !== "all") {
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) problems.push(`${kind} "${entry.id}" has an invalid scope`)
      else {
        for (const key of Object.keys(scope)) if (!["repos", "teams"].includes(key)) problems.push(`${kind} "${entry.id}" has unknown scope key "${key}"`)
        for (const key of ["repos", "teams"]) if (scope[key] !== undefined && !Array.isArray(scope[key])) problems.push(`${kind} "${entry.id}" scope.${key} must be an array`)
      }
    }
  }
  const validateSecrets = (entry, kind) => {
    const containers = [entry.environment, entry.headers]
    for (const container of containers) {
      for (const [key, value] of Object.entries(container ?? {})) {
        if (/(token|secret|password|authorization|api.?key)/i.test(key) && !String(value).includes("{env:")) {
          problems.push(`${kind} "${entry.id}" must reference an environment placeholder for ${key}`)
        }
      }
    }
  }

  for (const entry of source.mcp ?? []) {
    validateCommon(entry, "mcp")
    validateSecrets(entry, "mcp")
    if (seen.has(`mcp:${entry.id}`)) problems.push(`duplicate mcp id "${entry.id}"`)
    seen.add(`mcp:${entry.id}`)
    if (!["local", "remote"].includes(entry.kind)) problems.push(`mcp "${entry.id}" must declare kind local or remote`)
    if (entry.kind === "local" && (!Array.isArray(entry.command) || entry.command.length === 0 || entry.command.some((part) => typeof part !== "string"))) problems.push(`mcp "${entry.id}" is local but has no command array or contains invalid arguments`)
    if (entry.kind === "remote" && !/^https:\/\//i.test(entry.url ?? "")) problems.push(`mcp "${entry.id}" has no url or does not use https`)
  }

  for (const entry of source.skills ?? []) {
    validateCommon(entry, "skill")
    if (seen.has(`skill:${entry.id}`)) problems.push(`duplicate skill id "${entry.id}"`)
    seen.add(`skill:${entry.id}`)
    if (!entry.file) problems.push(`skill "${entry.id}" has no file`)
    if (entry.file && (entry.file.includes("..") || entry.file.startsWith("/") || /^[A-Za-z]:/.test(entry.file))) problems.push(`skill "${entry.id}" file must be a relative safe path`)
    if (entry.content !== undefined && typeof entry.content !== "string") problems.push(`skill "${entry.id}" content must be a string`)
  }

  for (const entry of source.context_tools ?? []) {
    validateCommon(entry, "context tool")
    if (seen.has(`context_tool:${entry.id}`)) problems.push(`duplicate context tool id "${entry.id}"`)
    seen.add(`context_tool:${entry.id}`)
    if (!["compression", "knowledge_graph"].includes(entry.category)) problems.push(`context tool "${entry.id}" has an invalid category`)
    if (entry.mcp) {
      validateSecrets({ id: entry.id, ...entry.mcp }, "context tool")
      if (!["local", "remote"].includes(entry.mcp.kind)) problems.push(`context tool "${entry.id}" mcp must declare kind local or remote`)
      if (entry.mcp.kind === "local" && (!Array.isArray(entry.mcp.command) || entry.mcp.command.length === 0)) problems.push(`context tool "${entry.id}" has no mcp command`)
      if (entry.mcp.kind === "remote" && !/^https:\/\//i.test(entry.mcp.url ?? "")) problems.push(`context tool "${entry.id}" must use an https mcp url`)
    }
  }

  if (problems.length > 0) throw new Error(`CAAO catalog is invalid:\n- ${problems.join("\n- ")}`)
  return source
}
