/**
 * Seeds realistic runs across several repositories so the dashboard can be
 * demonstrated (and eyeballed) without a live provider.
 *
 * Usage:
 *   node .opencode/caao/seed-demo.mjs           seed
 *   node .opencode/caao/seed-demo.mjs --clean   remove exactly what it seeded
 */

import { existsSync, rmSync } from "node:fs"

import { listRuns, loadRun, runPath, saveRun } from "./state.js"
import { next, plan, record } from "./engine.js"

const DEMO_TAG = "demo-seed"

const SCENARIOS = [
  { request: "Fix the failing unit tests in the billing module", repo: "acme/billing-service", branch: "fix/billing-tests", actor: "ann@acme.dev", complete: 1 },
  { request: "Migrate the orders API from REST to gRPC without breaking existing clients", repo: "acme/orders-api", branch: "feat/grpc", actor: "bob@acme.dev", complete: 0.6 },
  { request: "Add rate limiting to the public search endpoint", repo: "acme/search-gateway", branch: "feat/ratelimit", actor: "cara@acme.dev", complete: 1 },
  { request: "Rotate the OAuth signing keys and update the token validation path", repo: "acme/identity", branch: "chore/key-rotation", actor: "dan@acme.dev", complete: 0.45, touches: ["auth", "crypto"] },
  { request: "Fix a typo in the changelog", repo: "acme/website", branch: "main", actor: "ann@acme.dev", complete: 1 },
  { request: "Investigate the p99 latency regression on the checkout path", repo: "acme/billing-service", branch: "perf/checkout", actor: "bob@acme.dev", complete: 0.5 },
]

function clean() {
  let removed = 0
  for (const run of listRuns()) {
    if (run.demo !== DEMO_TAG) continue
    const path = runPath(run.id)
    if (existsSync(path)) {
      rmSync(path)
      removed += 1
    }
  }
  console.log(`removed ${removed} demo run(s)`)
}

/** Plausible token counts: reasoning-heavy capabilities read and write more. */
function usage(capability) {
  const heavy = ["planning", "architecture", "security", "review", "migration"].includes(capability)
  const base = heavy ? 90_000 : 40_000
  const input = base + Math.floor(Math.random() * base * 0.6)
  return { tokens_in: input, tokens_out: Math.floor(input * 0.22), tokens_cached: Math.floor(base * 0.3) }
}

function tag(id) {
  const run = loadRun(id)
  run.demo = DEMO_TAG
  saveRun(run)
}

function seedOne(scenario) {
  const run = plan({
    request: scenario.request,
    skipRepoScan: true,
    changedFiles: [],
    repo: scenario.repo,
    branch: scenario.branch,
    actor: scenario.actor,
    ...(scenario.touches ? { touches: scenario.touches } : {}),
  })

  const target = Math.ceil(run.graph.nodes.length * scenario.complete)
  let completed = 0
  let guard = 0
  let wave = next(run.id)

  while (!wave.complete && wave.dispatch.length > 0 && completed < target && guard++ < 40) {
    for (const task of wave.dispatch) {
      if (completed >= target) break
      record(run.id, task.nodeId, {
        status: "ok",
        confidence: Number((0.78 + Math.random() * 0.2).toFixed(2)),
        summary: `${task.capability} completed`,
        files: [`src/${task.capability}.ts`],
        verdict: "pass",
        ...usage(task.capability),
      })
      completed += 1
    }
    if (completed < target) wave = next(run.id)
  }

  // Leave the following wave dispatched so the DAG shows work in flight.
  if (completed < run.graph.nodes.length) next(run.id)
  tag(run.id)
  return { id: run.id, nodes: run.graph.nodes.length, completed }
}

if (process.argv.includes("--clean")) {
  clean()
} else {
  const seeded = SCENARIOS.map(seedOne)
  const repos = new Set(SCENARIOS.map((scenario) => scenario.repo)).size
  console.log(`seeded ${seeded.length} demo run(s) across ${repos} repositories`)
  for (const entry of seeded) console.log(`  ${entry.id}  ${entry.completed}/${entry.nodes} tasks`)
  console.log(`\nremove them with: node .opencode/caao/seed-demo.mjs --clean`)
}
