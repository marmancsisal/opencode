/**
 * CAAO — the developer side of centralised configuration.
 *
 * A developer never edits the registries and never runs a copy step by hand.
 * Their machine asks the company distribution server "what is the current
 * bundle for my channel?", verifies the signature, writes the files and
 * regenerates the agents. If the server is unreachable the machine keeps
 * working on the last verified bundle — an outage must not stop anyone coding.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

import { CAAO_HOME, clearCache, loadConfig } from "./config.js"
import { syncAgents } from "./agents.js"
import { applyBundle, rollbackBundle, verifyBundle } from "./distribution.js"
import { syncCatalog } from "./catalog-sync.js"
import { repoSignals } from "./context.js"

const BOOTSTRAP = "distribution.json"
const STATE = join("state", "distribution.json")

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

/**
 * A machine must know where to fetch from *before* it has any configuration, so
 * this one file is bootstrap, not distributed content. Environment variables win
 * so CI and canary machines can be pointed elsewhere without editing anything.
 */
export function distributionSettings(root = CAAO_HOME) {
  const file = readJson(join(root, BOOTSTRAP)) ?? {}
  const key = process.env.CAAO_CONFIG_KEY ?? file.publicKey ?? null

  return {
    url: (process.env.CAAO_CONFIG_URL ?? file.url ?? "").replace(/\/$/, ""),
    channel: process.env.CAAO_CHANNEL ?? file.channel ?? "stable",
    token: process.env.CAAO_CONFIG_TOKEN ?? file.token ?? null,
    publicKey: resolveKey(key, root),
    autoUpdate: envFlag("CAAO_AUTO_UPDATE") ?? file.autoUpdate ?? true,
    checkIntervalMinutes: Number(process.env.CAAO_CHECK_INTERVAL ?? file.checkIntervalMinutes ?? 60),
    timeoutMs: Number(process.env.CAAO_CONFIG_TIMEOUT ?? file.timeoutMs ?? 2500),
    enabled: Boolean(process.env.CAAO_CONFIG_URL ?? file.url),
  }
}

function envFlag(name) {
  const value = process.env[name]
  if (value === undefined) return undefined
  return value !== "0" && value.toLowerCase() !== "false"
}

/** The key may be inline PEM or a path to it; a path keeps it out of git history. */
function resolveKey(key, root) {
  if (!key) return null
  if (key.includes("BEGIN PUBLIC KEY")) return key
  const path = isAbsolute(key) ? key : join(root, key)
  return existsSync(path) ? readFileSync(path, "utf8") : null
}

export function distributionState(root = CAAO_HOME) {
  return readJson(join(root, STATE)) ?? { version: null, channel: null, appliedAt: null, lastCheckedAt: null }
}

export function saveDistributionState(state, root = CAAO_HOME) {
  const path = join(root, STATE)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  return state
}

async function request(settings, path, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? settings.timeoutMs)
  try {
    const response = await fetch(`${settings.url}${path}`, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        ...(settings.token ? { "x-caao-dist-token": settings.token } : {}),
      },
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** Cheap freshness probe: one small response, no bundle transfer. */
export async function checkVersion(root = CAAO_HOME, settings = distributionSettings(root)) {
  const remote = await request(settings, `/dist/version?channel=${encodeURIComponent(settings.channel)}`)
  const local = distributionState(root)
  return { current: local.version === remote.version, local: local.version, remote: remote.version, channel: remote.channel }
}

/**
 * Fetch, verify, write, regenerate. Returns a status rather than throwing,
 * because "the config server is down" is a normal condition on a laptop and
 * must never be fatal.
 */
export async function update(root = CAAO_HOME, { force = false, settings = distributionSettings(root) } = {}) {
  if (!settings.enabled) return { status: "disabled", reason: "no distribution url configured" }

  let payload
  try {
    payload = await request(settings, `/dist/bundle?channel=${encodeURIComponent(settings.channel)}`)
  } catch (error) {
    return { status: "unreachable", reason: error.name === "AbortError" ? "timed out" : error.message, version: distributionState(root).version }
  }

  const { bundle, signature } = payload
  const verdict = verifyBundle(bundle, signature, settings.publicKey, { expectedChannel: settings.channel })
  if (!verdict.ok) return { status: "rejected", reason: verdict.reason, version: distributionState(root).version }

  const state = distributionState(root)
  if (!force && state.version === bundle.version) {
    const config = loadConfig(root)
    const context = repoSignals(dirname(root))
    const catalog = syncCatalog(config, root, { repo: context.repo, team: process.env.CAAO_TEAM ?? null })
    saveDistributionState({ ...state, lastCheckedAt: new Date().toISOString() }, root)
    return { status: "current", version: bundle.version, channel: bundle.channel, changed: [], catalog }
  }

  const applied = applyBundle(bundle, root)
  clearCache()

  let agents = { written: [], total: 0 }
  let catalog = { mcp: [], skills: [], requiredEnv: [] }
  try {
    const config = loadConfig(root, { fresh: true })
    agents = syncAgents(config)
    const context = repoSignals(dirname(root))
    catalog = syncCatalog(config, root, { repo: context.repo, team: process.env.CAAO_TEAM ?? null })
  } catch (error) {
    rollbackBundle(applied, root)
    clearCache()
    return { status: "invalid", reason: error.message, version: bundle.version, changed: [] }
  }

  saveDistributionState(
    {
      version: bundle.version,
      channel: bundle.channel,
      appliedAt: new Date().toISOString(),
      lastCheckedAt: new Date().toISOString(),
      notes: bundle.notes ?? "",
    },
    root,
  )

  return { status: "updated", version: bundle.version, channel: bundle.channel, changed: applied.changed, agents: agents.written.length, catalog }
}

/**
 * Startup path. Throttled by `checkIntervalMinutes` so opening ten terminals
 * does not mean ten round trips, and hard-bounded by the timeout so a slow
 * network delays nobody.
 */
export async function updateOnStartup(root = CAAO_HOME) {
  const settings = distributionSettings(root)
  if (!settings.enabled || !settings.autoUpdate) return { status: "disabled" }
  if (process.env.CAAO_NO_UPDATE) return { status: "disabled", reason: "CAAO_NO_UPDATE" }

  const state = distributionState(root)
  const since = state.lastCheckedAt ? Date.now() - Date.parse(state.lastCheckedAt) : Infinity
  if (since < settings.checkIntervalMinutes * 60_000) return { status: "throttled", version: state.version }

  return update(root, { settings })
}
