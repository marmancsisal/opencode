/**
 * CAAO — MCP and context-tool diagnostics.
 *
 * The catalog says what a machine *should* have. This module reports what it
 * actually has: whether the binary exists, whether the environment variables
 * the entry references are set, and whether the entry ever reached
 * opencode.json. A declared-but-unresolvable MCP is the most common failure in
 * this system and it fails silently — opencode simply has fewer tools.
 *
 * Read-only and offline by default: a diagnostic that starts servers or calls
 * out to the network is a diagnostic nobody runs.
 */

import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"

import { CAAO_HOME } from "./config.js"
import { catalog, manifestFor } from "./catalog.js"

const WINDOWS = process.platform === "win32"

/** Resolve a bare command against PATH the way a shell would, without running it. */
export function resolveExecutable(command, env = process.env) {
  if (typeof command !== "string" || command === "") return null
  if (command.includes("/") || command.includes("\\")) {
    return existsSync(command) ? command : null
  }

  const extensions = WINDOWS ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""]
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      try {
        if (!statSync(candidate).isFile()) continue
        if (!WINDOWS) accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here, or not executable — keep looking.
      }
    }
  }
  return null
}

function missingEnv(entry, env) {
  return (entry.requiredEnv ?? []).filter((name) => !env[name])
}

function readMcpBlock(root) {
  try {
    return JSON.parse(readFileSync(join(root, "opencode.json"), "utf8").replace(/^\uFEFF/, "")).mcp ?? {}
  } catch {
    return {}
  }
}

/**
 * `npx -y @scope/pkg` is resolvable as long as npx is; the package is fetched on
 * first use. Checking the package itself would mean hitting the registry.
 */
function commandProbe(command) {
  const binary = command?.[0]
  const resolved = resolveExecutable(binary)
  if (resolved) return { binary, resolved, ok: true }
  return { binary: binary ?? null, resolved: null, ok: false }
}

function checkEntry(entry, { env, wired, kind }) {
  const problems = []
  const notes = []

  const remote = entry.kind === "remote" || entry.mcp?.kind === "remote"
  const command = entry.command ?? entry.mcp?.command ?? null
  const url = entry.url ?? entry.mcp?.url ?? null

  let probe = { binary: null, resolved: null, ok: true }
  if (remote) {
    if (!/^https:\/\//i.test(url ?? "")) problems.push("declares no https url")
    else notes.push(`remote endpoint ${url}`)
  } else if (Array.isArray(command) && command.length > 0) {
    probe = commandProbe(command)
    if (!probe.ok) problems.push(`command "${probe.binary}" is not on PATH`)
  } else {
    problems.push("declares neither a command nor a url")
  }

  const absent = missingEnv(entry, env)
  if (absent.length > 0) problems.push(`environment variable(s) not set: ${absent.join(", ")}`)

  if (!wired.includes(entry.id)) problems.push("not present in opencode.json — run `npm run caao:catalog`")

  return {
    id: entry.id,
    kind,
    title: entry.title ?? entry.id,
    transport: remote ? "remote" : "local",
    command: Array.isArray(command) ? command.join(" ") : null,
    url,
    binary: probe.binary,
    resolvedBinary: probe.resolved,
    requiredEnv: entry.requiredEnv ?? [],
    missingEnv: absent,
    wired: wired.includes(entry.id),
    tools: entry.tools ?? [],
    install: entry.install ?? null,
    setup: entry.setup ?? null,
    status: problems.length === 0 ? "ok" : "broken",
    problems,
    notes,
  }
}

/**
 * One report for every MCP server and context tool this machine should be
 * running. `ok` is true only when every enabled entry is usable, which is the
 * question a developer actually has.
 */
export function diagnose(config, { repo = null, team = null, env = process.env, root = CAAO_HOME } = {}) {
  const manifest = manifestFor(config, { repo, team })
  const wired = Object.keys(readMcpBlock(root))

  const checks = [
    ...manifest.mcp.map((entry) => checkEntry(entry, { env, wired, kind: "mcp" })),
    ...manifest.contextTools.map((entry) => checkEntry(entry, { env, wired, kind: "context_tool" })),
  ]

  const full = catalog(config)
  const skipped = [
    ...full.mcp.filter((entry) => !manifest.mcp.some((live) => live.id === entry.id)),
    ...full.contextTools.filter((entry) => !manifest.contextTools.some((live) => live.id === entry.id)),
  ].map((entry) => ({ id: entry.id, reason: entry.enabled ? "out of scope for this repository or team" : "disabled in the catalog" }))

  return {
    generatedAt: new Date().toISOString(),
    target: { repo, team },
    ok: checks.every((check) => check.status === "ok"),
    totals: {
      checked: checks.length,
      ok: checks.filter((check) => check.status === "ok").length,
      broken: checks.filter((check) => check.status === "broken").length,
      skipped: skipped.length,
    },
    checks,
    skipped,
  }
}

export function formatDiagnostics(report) {
  const lines = [`CAAO diagnostics — ${report.totals.ok}/${report.totals.checked} usable, ${report.totals.skipped} not applicable here`, ""]
  for (const check of report.checks) {
    lines.push(`${check.status === "ok" ? "  ok  " : "  ✗   "}${check.id}  (${check.kind}, ${check.transport})`)
    if (check.command) lines.push(`        command: ${check.command}${check.resolvedBinary ? ` → ${check.resolvedBinary}` : ""}`)
    if (check.url) lines.push(`        url: ${check.url}`)
    for (const problem of check.problems) lines.push(`        · ${problem}`)
    if (check.status !== "ok" && check.install) lines.push(`        install: ${check.install}`)
    if (check.status !== "ok" && check.setup) lines.push(`        setup:   ${check.setup}`)
  }
  if (report.skipped.length > 0) {
    lines.push("", "  not applicable to this machine:")
    for (const entry of report.skipped) lines.push(`        ${entry.id} — ${entry.reason}`)
  }
  return lines.join("\n")
}
