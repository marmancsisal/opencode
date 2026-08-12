/**
 * CAAO — HTTP surfaces.
 *
 * Two audiences, two roles, deliberately not the same server:
 *
 *   role "admin"  the console. Company-wide spend, repository names, developer
 *                 identities, every request anyone ever made. Authenticated,
 *                 loopback by default. Not for developers.
 *
 *   role "dist"   configuration distribution. Serves signed bundles of the
 *                 managed registries and the per-machine MCP/skill manifest,
 *                 and nothing else. Safe to expose to every developer because
 *                 it never reads a run file.
 *
 * A "dist" server does not merely refuse the admin routes — it answers 404, so
 * a developer's machine cannot even learn that a console exists behind it.
 */

import { createServer } from "node:http"
import { createReadStream, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { extname, isAbsolute, join, normalize, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"

import { CAAO_HOME, clearCache, loadConfig } from "./config.js"
import { listRuns, loadRun } from "./state.js"
import { overview, repositories, summarize } from "./analytics.js"
import { explain } from "./rationale.js"
import { catalog, manifestFor, validateCatalog } from "./catalog.js"
import { diagnose } from "./doctor.js"
import { priceTable } from "./pricing.js"
import { providerTable } from "./provider.js"
import { toMermaid, waves } from "./dag.js"
import { buildBundle, signBundle } from "./distribution.js"

// The console is a plain static site and deliberately lives outside .opencode:
// a developer's workspace should receive the minimum configuration, not the
// admin front-end. CAAO_DASHBOARD_DIR repoints it for a packaged deployment.
const PUBLIC_DIR = resolve(process.env.CAAO_DASHBOARD_DIR ?? join(CAAO_HOME, "..", "dashboard"))
const CATALOG_PATH = join(CAAO_HOME, "catalog.yaml")

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
}

const COOKIE = "caao_admin"
const LOGIN_ATTEMPT_LIMIT = 10
const LOGIN_WINDOW_MS = 5 * 60_000
const SESSION_TTL_MS = 12 * 60 * 60_000
/** Public on purpose: --dev refuses to bind anything but loopback, so a known password costs nothing. */
const DEV_TOKEN = "caao-dev"

function json(res, status, payload, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  })
  res.end(JSON.stringify(payload))
}

function fail(res, status, message) {
  json(res, status, { error: message })
}

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,120}$/.test(value)
}

/** Constant time, and length-safe: timingSafeEqual throws on a length mismatch. */
function secretEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function cookies(req) {
  const header = req.headers.cookie
  if (!header) return {}
  return Object.fromEntries(
    header.split(";").map((pair) => {
      const index = pair.indexOf("=")
      if (index === -1) return [pair.trim(), ""]
      let value = pair.slice(index + 1)
      try { value = decodeURIComponent(value) } catch { value = "" }
      return [pair.slice(0, index).trim(), value]
    }),
  )
}

function graphOf(run) {
  const nodes = run.graph?.nodes ?? []
  const layers = waves(run.graph ?? { nodes: [] })
  const column = new Map()
  layers.forEach((wave, index) => wave.forEach((id) => column.set(id, index)))

  return {
    runId: run.id,
    maxParallel: run.graph?.maxParallel ?? 1,
    live: {
      done: nodes.filter((node) => node.status === "done").length,
      running: nodes.filter((node) => node.status === "running").length,
      pending: nodes.filter((node) => node.status === "pending").length,
      failed: nodes.filter((node) => node.status === "failed").length,
      cost: nodes.reduce((total, node) => total + (node.cost ?? 0), 0) + (run.orchestrator?.cost ?? 0),
      tokens: nodes.reduce((total, node) => total + (node.usage?.totalTokens ?? 0), 0) + (run.orchestrator?.usage?.totalTokens ?? 0),
      inputTokens: nodes.reduce((total, node) => total + (node.usage?.inputTokens ?? 0), 0) + (run.orchestrator?.usage?.inputTokens ?? 0),
      outputTokens: nodes.reduce((total, node) => total + (node.usage?.outputTokens ?? 0), 0) + (run.orchestrator?.usage?.outputTokens ?? 0),
      tokensSaved: Object.values(run.contextTools ?? {}).reduce((total, tool) => total + (tool.tokensSaved ?? 0), 0),
      widestWave: Math.max(0, ...layers.map((wave) => wave.length)),
    },
    orchestrator: {
      model: run.orchestrator?.model ?? null,
      cost: run.orchestrator?.cost ?? 0,
      inputTokens: run.orchestrator?.usage?.inputTokens ?? 0,
      outputTokens: run.orchestrator?.usage?.outputTokens ?? 0,
      tokens: run.orchestrator?.usage?.totalTokens ?? 0,
    },
    contextTools: Object.values(run.contextTools ?? {}),
    waves: layers.map((wave, index) => ({ index, nodes: wave })),
    nodes: nodes.map((node) => {
      const last = node.results?.at(-1) ?? {}
      return {
        id: node.id,
        title: node.title,
        capability: node.capability,
        phase: node.phase,
        status: node.status,
        wave: column.get(node.id) ?? null,
        model: node.provider?.model ?? null,
        pool: node.provider?.pool ?? null,
        tier: node.provider?.tier ?? null,
        escalated: Boolean(node.provider?.escalated),
        escalationReason: node.provider?.escalationReason ?? null,
        agent: node.agent ?? null,
        attempts: node.attempts ?? 0,
        confidence: last.confidence ?? null,
        verdict: last.verdict ?? null,
        summary: last.summary ?? null,
        files: [...new Set((node.results ?? []).flatMap((entry) => entry.files ?? []))],
        cost: node.cost ?? 0,
        tokens: node.usage?.totalTokens ?? 0,
        inputTokens: node.usage?.inputTokens ?? 0,
        outputTokens: node.usage?.outputTokens ?? 0,
        cachedTokens: node.usage?.cachedTokens ?? 0,
        metered: Boolean(node.usage?.metered),
        startedAt: node.startedAt ?? null,
        endedAt: node.endedAt ?? null,
        durationMs: node.startedAt && node.endedAt ? Date.parse(node.endedAt) - Date.parse(node.startedAt) : null,
        blocking: Boolean(node.blocking),
        dependsOn: node.dependsOn ?? [],
        reopenedBy: node.reopenedBy ?? null,
      }
    }),
    edges: nodes.flatMap((node) => (node.dependsOn ?? []).map((from) => ({ from, to: node.id }))),
    mermaid: toMermaid(run.graph ?? { nodes: [] }),
  }
}

function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname
  // normalize collapses ".."; the prefix check then guarantees we stayed inside.
  const target = resolve(PUBLIC_DIR, `.${normalize(requested)}`)
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) return fail(res, 403, "forbidden")
  if (!existsSync(target) || !statSync(target).isFile()) return fail(res, 404, "not found")

  res.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  })
  createReadStream(target).pipe(res)
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error("payload too large")
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new Error("invalid json body")
  }
}

function mutateCatalog(mutator, patchDocument) {
  const document = YAML.parseDocument(readFileSync(CATALOG_PATH, "utf8"))
  if (document.errors.length > 0) throw new Error(document.errors[0].message)
  const source = document.toJS() ?? {}
  const before = JSON.stringify(source)
  const result = mutator(source)
  validateCatalog(source)
  if (JSON.stringify(source) === before) return result
  patchDocument(document, result)
  const staging = `${CATALOG_PATH}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  writeFileSync(staging, document.toString(), "utf8")
  renameSync(staging, CATALOG_PATH)
  clearCache()
  return result
}

function toggleCatalogEntry(kind, id, enabled) {
  if (typeof enabled !== "boolean") throw new Error("enabled must be boolean")
  const result = mutateCatalog(
    (source) => {
      const index = (source[kind] ?? []).findIndex((candidate) => candidate.id === id)
      if (index === -1) throw new Error(`unknown ${kind} entry "${id}"`)
      source[kind][index].enabled = enabled
      return { entry: source[kind][index], index }
    },
    (document, changed) => document.setIn([kind, changed.index, "enabled"], enabled),
  )
  return result.entry
}

function createCatalogEntry(kind, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("entry must be an object")
  const result = mutateCatalog(
    (source) => {
      source[kind] = source[kind] ?? []
      if (source[kind].some((entry) => entry.id === input.id)) throw new Error(`${kind} entry "${input.id}" already exists`)
      const entry = { ...input, enabled: input.enabled ?? true }
      source[kind].push(entry)
      return { entry }
    },
    (document, changed) => {
      if (!document.has(kind)) document.set(kind, [])
      document.addIn([kind], changed.entry)
    },
  )
  return result.entry
}

function updateCatalogEntry(kind, id, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("entry must be an object")
  const result = mutateCatalog(
    (source) => {
      const index = (source[kind] ?? []).findIndex((entry) => entry.id === id)
      if (index === -1) throw new Error(`unknown ${kind} entry "${id}"`)
      const entry = { ...source[kind][index], ...input, id }
      source[kind][index] = entry
      return { entry, index }
    },
    (document, changed) => {
      for (const [key, value] of Object.entries(changed.entry)) document.setIn([kind, changed.index, key], value)
    },
  )
  return result.entry
}

function readKey(value) {
  if (!value) return null
  if (value.includes("BEGIN PRIVATE KEY")) return value
  const path = isAbsolute(value) ? value : join(CAAO_HOME, value)
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

export function createDashboard({
  role = "admin",
  adminToken = process.env.CAAO_ADMIN_TOKEN ?? process.env.CAAO_DASHBOARD_TOKEN ?? null,
  distToken = process.env.CAAO_DIST_TOKEN ?? null,
  signingKey = readKey(process.env.CAAO_SIGNING_KEY),
  channels = channelMap(),
  secureCookie = false,
} = {}) {
  const servesAdmin = role === "admin" || role === "both"
  const servesDist = role === "dist" || role === "both"
  const loginAttempts = new Map()
  const sessions = new Map()

  function rateLimited(req) {
    const key = req.socket.remoteAddress ?? "unknown"
    const now = Date.now()
    const record = loginAttempts.get(key) ?? { count: 0, since: now }
    if (now - record.since > LOGIN_WINDOW_MS) {
      record.count = 0
      record.since = now
    }
    record.count += 1
    loginAttempts.set(key, record)
    return record.count > LOGIN_ATTEMPT_LIMIT
  }

  /** No token configured means no admin access at all — never "open by default". */
  function sessionOf(req) {
    const id = cookies(req)[COOKIE]
    const session = id ? sessions.get(id) : null
    if (!session) return null
    if (session.expiresAt <= Date.now()) {
      sessions.delete(id)
      return null
    }
    return session
  }

  function isAdmin(req) {
    if (!adminToken) return false
    const header = req.headers["x-caao-token"]
    if (typeof header === "string" && secretEquals(header, adminToken)) return true
    return Boolean(sessionOf(req))
  }

  function canMutate(req) {
    const header = String(req.headers["x-caao-token"] ?? "")
    if (secretEquals(header, adminToken ?? "")) return true
    const session = sessionOf(req)
    return Boolean(session && secretEquals(String(req.headers["x-caao-csrf"] ?? ""), session.csrf))
  }

  return createServer(async (req, res) => {
    let url
    try {
      url = new URL(req.url, "http://localhost")
    } catch {
      return fail(res, 400, "bad request")
    }
    const path = url.pathname
    const query = url.searchParams

    try {
      // ---- distribution surface: no run data, ever -------------------------
      if (path.startsWith("/dist/")) {
        if (!servesDist) return fail(res, 404, "not found")
        if (req.method !== "GET") return fail(res, 405, "method not allowed")
        if (distToken && !secretEquals(String(req.headers["x-caao-dist-token"] ?? ""), distToken)) {
          return fail(res, 401, "a valid x-caao-dist-token header is required")
        }

        const channel = query.get("channel") || "stable"
        const root = channels[channel]
        if (!root) return fail(res, 404, `unknown channel "${channel}"`)

        if (path === "/dist/version") {
          const bundle = buildBundle(root, { channel })
          return json(res, 200, { channel, version: bundle.version, generatedAt: bundle.generatedAt })
        }

        if (path === "/dist/bundle") {
          if (!signingKey) return fail(res, 503, "this server has no signing key configured")
          const bundle = buildBundle(root, { channel, notes: process.env.CAAO_DIST_NOTES ?? "" })
          return json(res, 200, { bundle, signature: signBundle(bundle, signingKey) })
        }

        if (path === "/dist/manifest") {
          return json(res, 200, manifestFor(loadConfig(root), { repo: query.get("repo") || null, team: query.get("team") || null }))
        }

        return fail(res, 404, "unknown endpoint")
      }

      // ---- everything below is the admin console ---------------------------
      if (!servesAdmin) return fail(res, 404, "not found")

      if (!path.startsWith("/api/")) {
        if (req.method !== "GET") return fail(res, 405, "method not allowed")
        // The shell carries no data; every figure in it requires a session.
        return serveStatic(res, path)
      }

      if (path === "/api/session") {
        if (req.method === "DELETE") {
          const id = cookies(req)[COOKIE]
          if (id) sessions.delete(id)
          return json(res, 200, { ok: true }, { "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` })
        }
        if (req.method === "POST") {
          if (!adminToken) return fail(res, 503, "this server has no admin token configured")
          if (rateLimited(req)) return fail(res, 429, "too many attempts")
          const body = await readBody(req)
          if (!secretEquals(String(body.token ?? ""), adminToken)) return fail(res, 401, "invalid token")
          loginAttempts.delete(req.socket.remoteAddress ?? "unknown")
          const sessionId = randomBytes(32).toString("base64url")
          const csrf = randomBytes(32).toString("base64url")
          sessions.set(sessionId, { csrf, expiresAt: Date.now() + SESSION_TTL_MS })
          const attributes = ["HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=43200", secureCookie ? "Secure" : null]
          return json(res, 200, { ok: true, csrfToken: csrf }, { "set-cookie": `${COOKIE}=${sessionId}; ${attributes.filter(Boolean).join("; ")}` })
        }
        if (req.method === "GET") return json(res, 200, { authenticated: isAdmin(req), configured: Boolean(adminToken), csrfToken: sessionOf(req)?.csrf ?? null })
        return fail(res, 405, "method not allowed")
      }

      if (!isAdmin(req)) {
        return fail(res, 401, adminToken ? "admin authentication required" : "this server has no admin token configured")
      }

      const config = loadConfig()
      const repo = query.get("repo") || null

      if (req.method === "GET" && path === "/api/health") {
        return json(res, 200, { ok: true, role, runs: listRuns().length, mutationsEnabled: true })
      }

      if (req.method === "GET" && path === "/api/overview") {
        return json(res, 200, overview(config, listRuns(), { repo, days: Number(query.get("days") ?? 30) }))
      }

      if (req.method === "GET" && path === "/api/repos") {
        return json(res, 200, { repos: repositories(listRuns()) })
      }

      if (req.method === "GET" && path === "/api/runs") {
        const runs = listRuns()
          .filter((run) => !repo || (run.repo || run.project || "unattributed") === repo)
          .map(summarize)
        const status = query.get("status")
        return json(res, 200, { runs: status ? runs.filter((run) => run.status === status) : runs })
      }

      const runMatch = /^\/api\/runs\/([^/]+)(\/graph|\/rationale|\/report)?$/.exec(path)
      if (req.method === "GET" && runMatch) {
        const id = decodeURIComponent(runMatch[1])
        if (!safeId(id)) return fail(res, 400, "invalid run id")
        let run
        try {
          run = loadRun(id)
        } catch {
          return fail(res, 404, "unknown run")
        }
        if (runMatch[2] === "/graph") return json(res, 200, graphOf(run))
        if (runMatch[2] === "/rationale") return json(res, 200, explain(run, config))
        return json(res, 200, { summary: summarize(run), graph: graphOf(run), rationale: explain(run, config) })
      }

      if (req.method === "GET" && path === "/api/costs") {
        const data = overview(config, listRuns(), { repo, days: Number(query.get("days") ?? 30) })
        return json(res, 200, {
          currency: data.currency,
          totals: data.totals,
          budget: data.budget,
          repos: data.repos,
          models: data.models,
          capabilities: data.capabilities,
          contextTools: data.contextTools,
          actors: data.actors,
          daily: data.daily,
          prices: priceTable(config),
        })
      }

      if (req.method === "GET" && path === "/api/diagnostics") {
        return json(res, 200, diagnose(config, { repo, team: query.get("team") || process.env.CAAO_TEAM || null }))
      }

      if (req.method === "GET" && path === "/api/models") {
        return json(res, 200, { pools: priceTable(config), routing: providerTable(config) })
      }

      if (req.method === "GET" && path === "/api/catalog") {
        return json(res, 200, {
          ...catalog(config),
          diagnostics: diagnose(config, { repo, team: query.get("team") || process.env.CAAO_TEAM || null }),
          savings: overview(config, listRuns(), { repo }).contextTools,
          mutationsEnabled: true,
        })
      }

      if (req.method === "GET" && path === "/api/catalog/manifest") {
        return json(res, 200, manifestFor(config, { repo, team: query.get("team") || null }))
      }

      if (req.method === "GET" && path === "/api/distribution") {
        const published = Object.entries(channels).map(([channel, root]) => {
          const bundle = buildBundle(root, { channel })
          return { channel, root, version: bundle.version, files: Object.keys(bundle.files), generatedAt: bundle.generatedAt }
        })
        return json(res, 200, { signing: Boolean(signingKey), distTokenRequired: Boolean(distToken), channels: published })
      }

      const catalogCollection = /^\/api\/catalog\/(mcp|skills|context_tools)$/.exec(path)
      if (req.method === "POST" && catalogCollection) {
        if (!canMutate(req)) return fail(res, 401, "a valid mutation token is required")
        const body = await readBody(req)
        try {
          const entry = createCatalogEntry(catalogCollection[1], body)
          return json(res, 201, { ok: true, entry })
        } catch (error) {
          return fail(res, /already exists/.test(error.message) ? 409 : 400, error.message)
        }
      }

      const catalogItem = /^\/api\/catalog\/(mcp|skills|context_tools)\/([^/]+)$/.exec(path)
      if (req.method === "PUT" && catalogItem) {
        if (!canMutate(req)) return fail(res, 401, "a valid mutation token is required")
        const id = decodeURIComponent(catalogItem[2])
        if (!safeId(id)) return fail(res, 400, "invalid id")
        const body = await readBody(req)
        try {
          const entry = updateCatalogEntry(catalogItem[1], id, body)
          return json(res, 200, { ok: true, entry })
        } catch (error) {
          return fail(res, /unknown/.test(error.message) ? 404 : 400, error.message)
        }
      }

      const toggle = /^\/api\/catalog\/(mcp|skills|context_tools)\/([^/]+)\/toggle$/.exec(path)
      if (req.method === "POST" && toggle) {
        if (!canMutate(req)) return fail(res, 401, "a valid mutation token is required")
        const id = decodeURIComponent(toggle[2])
        if (!safeId(id)) return fail(res, 400, "invalid id")
        const body = await readBody(req)
        try {
          const entry = toggleCatalogEntry(toggle[1], id, body.enabled)
          return json(res, 200, { ok: true, id: entry.id, enabled: entry.enabled })
        } catch (error) {
          return fail(res, /unknown/.test(error.message) ? 404 : 400, error.message)
        }
      }

      return fail(res, 404, "unknown endpoint")
    } catch (error) {
      return fail(res, 500, error.message)
    }
  })
}

/** `{"stable": "/srv/caao", "canary": "/srv/caao-canary"}`, or just this checkout. */
function channelMap() {
  const declared = process.env.CAAO_DIST_CHANNELS
  if (!declared) return { stable: CAAO_HOME }
  const parsed = JSON.parse(declared)
  return Object.fromEntries(Object.entries(parsed).map(([channel, root]) => [channel, resolve(root)]))
}

export function startDashboard({
  port = Number(process.env.CAAO_DASHBOARD_PORT ?? 20129),
  host = process.env.CAAO_DASHBOARD_HOST ?? "127.0.0.1",
  role = process.env.CAAO_ROLE ?? "admin",
  ...options
} = {}) {
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost"
  const server = createDashboard({ role, secureCookie: !loopback, ...options })
  return new Promise((done) => server.listen(port, host, () => done({ server, port: server.address().port, host, role })))
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  const role = process.argv.includes("--dist") ? "dist" : process.argv.includes("--both") ? "both" : process.env.CAAO_ROLE ?? "admin"
  const dev = process.argv.includes("--dev")
  const adminToken = process.env.CAAO_ADMIN_TOKEN ?? process.env.CAAO_DASHBOARD_TOKEN ?? (dev ? DEV_TOKEN : null)
  const host = process.env.CAAO_DASHBOARD_HOST ?? "127.0.0.1"
  const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost"

  if (dev && !loopback) {
    console.error(`CAAO: --dev is loopback-only; ${host} would publish a known password. Set CAAO_ADMIN_TOKEN instead.`)
    process.exit(1)
  }
  if (role !== "dist" && !adminToken) {
    console.error("CAAO: the admin console refuses to start without CAAO_ADMIN_TOKEN.")
    console.error("      It exposes company-wide spend, repository names and developer identities.")
    console.error('      Set one:  $env:CAAO_ADMIN_TOKEN = "…"')
    console.error("      Or, on this machine only:  npm run caao:dashboard:dev")
    process.exit(1)
  }
  if (role !== "dist" && !loopback) {
    console.warn(`CAAO: ⚠ the admin console is bound to ${host}. Put an authenticating proxy in front of it.`)
  }

  const { port } = await startDashboard({ role, host, adminToken })
  console.log(`CAAO ${role} surface  →  http://${host}:${port}`)
  if (role !== "dist") {
    if (dev && adminToken === DEV_TOKEN) console.log(`  console       sign in with  ${DEV_TOKEN}   (fixed local token — never use off this machine)`)
    else console.log(`  console       sign in with CAAO_ADMIN_TOKEN`)
  }
  if (role !== "admin") {
    console.log(`  /dist/version  channel freshness probe`)
    console.log(`  /dist/bundle   signed configuration bundle${process.env.CAAO_SIGNING_KEY ? "" : "  ⚠ no CAAO_SIGNING_KEY — bundles cannot be served"}`)
    console.log(`  /dist/manifest per-machine MCP + skills`)
  }
}
