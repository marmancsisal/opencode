/**
 * CAAO — run state persistence.
 *
 * Execution state lives on disk so that a run survives a restart and can be
 * inspected after the fact. Workers never read this: only the Execution Manager.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { CAAO_HOME } from "./config.js"

const RUNS_DIR = join(CAAO_HOME, "state", "runs")
const STALE_LOCK_MS = 30_000

function ensureDir() {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true })
}

export function runPath(runId) {
  return join(RUNS_DIR, `${runId}.json`)
}

export function saveRun(run) {
  ensureDir()
  run.updatedAt = new Date().toISOString()
  const target = runPath(run.id)
  const staging = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(staging, JSON.stringify(run, null, 2), "utf8")
  renameSync(staging, target)
  return run
}

export function loadRun(runId) {
  const path = runPath(runId)
  if (!existsSync(path)) throw new Error(`CAAO: unknown run "${runId}"`)
  return JSON.parse(readFileSync(path, "utf8"))
}

export function listRuns() {
  ensureDir()
  return readdirSync(RUNS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      try {
        return JSON.parse(readFileSync(join(RUNS_DIR, file), "utf8"))
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export function newRunId() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")
  return `run-${stamp}-${randomUUID().slice(0, 8)}`
}

/** Serialize state transitions for one run without reducing DAG worker parallelism. */
export function withRunLock(runId, operation) {
  ensureDir()
  const lock = `${runPath(runId)}.lock`
  let descriptor = null
  for (let attempt = 0; attempt < 2 && descriptor === null; attempt += 1) {
    try {
      descriptor = openSync(lock, "wx")
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      let stale = false
      try {
        stale = Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS
      } catch {
        continue
      }
      if (!stale) break
      try {
        unlinkSync(lock)
      } catch {
        // Another process recovered it first; retry the exclusive create.
      }
    }
  }
  if (descriptor === null) throw new Error(`CAAO: run "${runId}" is busy; retry the state transition`)
  try {
    return operation()
  } finally {
    closeSync(descriptor)
    if (existsSync(lock)) unlinkSync(lock)
  }
}
