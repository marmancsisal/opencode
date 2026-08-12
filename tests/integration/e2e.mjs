/**
 * CAAO end-to-end test.
 *
 * Repoints providers.yaml at a scripted mock provider, regenerates the agents
 * and drives a real `opencode run`. It proves two things at once:
 *   1. the orchestration loop works inside opencode, not only in unit tests
 *   2. swapping every provider is a one-file edit (provider independence)
 */

import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { startMockProvider } from "./mock-provider.mjs"
import { allCapabilities, loadConfig } from "../../.opencode/caao/config.js"
import { report } from "../../.opencode/caao/engine.js"
import { listRuns } from "../../.opencode/caao/state.js"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const OPENCODE_DIR = join(ROOT, ".opencode")
const PROVIDERS = join(OPENCODE_DIR, "providers.yaml")
const CONFIG = join(OPENCODE_DIR, "opencode.json")
const PORT = 21999
const REQUEST = "Fix the failing unit tests in the billing module"

const MOCK_PROVIDERS = `version: 1
defaults:
  strategy: balanced
  timeout_ms: 60000
  max_attempts: 2
strategies:
  fastest: { rank_by: [-speed, cost] }
  cheapest: { rank_by: [cost, -speed] }
  highest_reasoning: { rank_by: [-reasoning, -quality] }
  highest_quality: { rank_by: [-quality, -reasoning] }
  balanced: { rank_by: [-quality, cost] }
  declared: { rank_by: [] }
pools:
  mock:
    tier: standard
    model: omniroute/mock-1
    traits: { reasoning: 5, quality: 5, speed: 5, cost: 1 }
    temperature: 0
bindings:
${allCapabilities(loadConfig())
  .map((capability) => `  ${capability.id}:\n    strategy: declared\n    candidates: [mock]`)
  .join("\n")}
`

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))
}

/**
 * Resolve a bare command against PATH/PATHEXT so it can be spawned without a
 * shell. Installations expose `opencode` as either a native .exe or a .cmd shim.
 */
function resolveExecutable(command) {
  if (process.platform !== "win32" || command.includes("/") || command.includes("\\")) return command
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
  for (const directory of (process.env.PATH ?? "").split(";").filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return command
}

function run(command, args, options = {}) {
  return new Promise((done) => {
    // Never concatenate test arguments through a shell: requests are attacker-
    // influenced strings and Windows exposes npm binaries through .cmd shims.
    const executable = resolveExecutable(command)
    const batch = /\.(cmd|bat)$/i.test(executable)
    // stdin must be closed, not merely unused: `opencode run` reads piped input
    // when stdin is not a TTY, and an open-but-silent pipe hangs it forever.
    const stdio = ["ignore", "pipe", "pipe"]
    const child = batch
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", executable, ...args], { cwd: ROOT, shell: false, stdio, ...options })
      : spawn(executable, args, { cwd: ROOT, shell: false, stdio, ...options })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (piece) => (stdout += piece))
    child.stderr.on("data", (piece) => (stderr += piece))
    // A missing binary must be reported, not thrown: an unhandled 'error' event
    // kills the runner before it can restore the registries it swapped out.
    child.on("error", (error) => done({ code: 127, stdout, stderr: `${stderr}${error.message}\n` }))
    child.on("close", (code) => done({ code, stdout, stderr }))
  })
}

async function main() {
  const backups = [PROVIDERS, CONFIG].map((file) => {
    const backup = `${file}.e2e-backup`
    copyFileSync(file, backup)
    return { file, backup }
  })

  const mock = await startMockProvider(PORT, REQUEST)
  let failure = null

  try {
    writeFileSync(PROVIDERS, MOCK_PROVIDERS, "utf8")

    const config = readJson(CONFIG)
    // Repoint the provider the workspace already declares rather than adding a
    // new one: an unknown provider id makes opencode reach out to models.dev
    // and npm, which turns a hermetic test into a network test.
    config.provider.omniroute.options.baseURL = `http://127.0.0.1:${PORT}/v1`
    config.provider.omniroute.options.apiKey = "mock"
    config.provider.omniroute.models = { "mock-1": { name: "mock-1", limit: { context: 128000, output: 8192 } } }
    config.small_model = "omniroute/mock-1"
    // The catalog's MCP servers are company tools that are not installed on a
    // test machine. opencode spends ~30s failing to start each one and the
    // orchestration under test does not depend on any of them.
    config.mcp = Object.fromEntries(Object.entries(config.mcp ?? {}).map(([id, entry]) => [id, { ...entry, enabled: false }]))
    writeFileSync(CONFIG, JSON.stringify(config, null, 2), "utf8")

    // Not "node": PATH may well answer with an older interpreter than the one
    // running this test, and the engine is written for the newer one.
    const sync = await run(process.execPath, [".opencode/caao/sync.mjs"])
    assert.equal(sync.code, 0, `caao:sync failed: ${sync.stderr}`)
    assert.match(readFileSync(join(OPENCODE_DIR, "agent", "caao-security.md"), "utf8"), /^model: omniroute\/mock-1$/m)

    const flags = ["run", "--agent", "caao", "--auto"]
    if (process.env.CAAO_E2E_LOGS) flags.push("--print-logs")
    const result = await run("opencode", [...flags, REQUEST], {
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 180000,
    })

    const output = `${result.stdout}\n${result.stderr}`
    assert.match(
      output,
      /CAAO_E2E_OK/,
      `execution manager never reached the final answer (opencode exited ${result.code}, ${mock.calls.length} model call(s) reached the mock provider).` +
        ` Re-run with CAAO_E2E_LOGS=1 for opencode's own logs.\n${output}`,
    )

    const roles = mock.calls.map((call) => call.role)
    assert.ok(roles.includes("execution-manager"), "the execution manager never ran")
    assert.ok(roles.includes("Triage"), `the triage worker never ran, roles: ${roles.join(", ")}`)
    for (const worker of ["Implementation", "Testing", "Security Review", "Architecture Review"]) {
      assert.ok(roles.includes(worker), `the ${worker} worker never ran, roles: ${roles.join(", ")}`)
    }

    const emCalls = mock.calls.filter((call) => call.role === "execution-manager").at(-1).tools
    for (const expected of ["caao_triage", "caao_plan", "caao_next", "task", "caao_record", "caao_merge", "caao_report"]) {
      assert.ok(emCalls.includes(expected), `${expected} was never called; saw ${emCalls.join(", ")}`)
    }

    const widestWave = Math.max(...mock.metrics.dispatchedWaves)
    assert.ok(widestWave >= 3, `the engine never handed out a parallel wave, waves: ${mock.metrics.dispatchedWaves.join(", ")}`)
    assert.ok(
      mock.metrics.peakWorkers >= 3,
      `opencode serialised the subagents — peak concurrent workers was ${mock.metrics.peakWorkers}, expected at least 3`,
    )

    // The point of observed accounting: nobody in the loop reported a token
    // count, and the run is still billed from what the provider actually
    // charged. Before this existed every run on the dashboard cost $0.00.
    const runFile = listRuns().find((candidate) => candidate.request === REQUEST)
    assert.ok(runFile, "the orchestrated run was not written to disk")
    const recap = report(runFile.id)
    assert.ok(
      recap.totals.tokens > 0 && recap.totals.inputTokens > 0 && recap.totals.outputTokens > 0,
      `no usage was observed from opencode: ${JSON.stringify(recap.totals)}`,
    )
    assert.ok(recap.orchestrator.usage.totalTokens > 0, "the execution manager's own token spend was not attributed to the run")
    assert.ok(
      recap.steps.some((step) => step.usage.inputTokens > 0),
      "no task was charged for the tokens its worker actually burned",
    )

    console.log(
      `\ne2e: ok — ${mock.calls.length} model calls, waves ${mock.metrics.dispatchedWaves.join(" -> ")}, ` +
        `peak ${mock.metrics.peakWorkers} workers in flight, ` +
        `${recap.totals.inputTokens} in / ${recap.totals.outputTokens} out observed ` +
        `(${recap.orchestrator.usage.totalTokens} of them orchestration), ` +
        `tools used: ${[...new Set(emCalls)].join(", ")}`,
    )
  } catch (error) {
    failure = error
  } finally {
    await mock.close()
    for (const { file, backup } of backups) {
      copyFileSync(backup, file)
      rmSync(backup)
    }
    await run(process.execPath, [".opencode/caao/sync.mjs"])
    for (const file of ["docs/api.md"]) {
      const path = join(ROOT, file)
      if (existsSync(path) && readFileSync(path, "utf8").length === 0) rmSync(path)
    }
  }

  if (failure) {
    console.error(failure.message)
    process.exit(1)
  }
}

await main()
