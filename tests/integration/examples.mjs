// Prints the resolved orchestration for the six reference scenarios.
// Used to keep docs/EXAMPLES.md honest: `node tests/integration/examples.mjs`
import { existsSync, rmSync } from "node:fs"

import { next, plan, record, report } from "../../.opencode/caao/engine.js"
import { toMermaid, waves } from "../../.opencode/caao/dag.js"
import { runPath } from "../../.opencode/caao/state.js"

const SCENARIOS = [
  { title: "1. Rename a variable", request: "Rename the variable foo to userCount in src/report.ts", changedFiles: ["src/report.ts"] },
  { title: "2. Fix failing tests", request: "Fix the failing unit tests in the billing module", changedFiles: ["src/billing/invoice.ts", "tests/billing.test.ts"] },
  { title: "3. Implement OAuth", request: "Implement OAuth 2.0 authentication with Google and GitHub providers", changedFiles: [] },
  { title: "4. Refactor a monolith", request: "Refactor the monolith into modular services", changedFiles: [] },
  { title: "5. Generate API documentation", request: "Generate API documentation for the public REST endpoints", changedFiles: ["src/api/routes.ts"] },
  { title: "6. Optimize SQL queries", request: "Optimize the slow SQL queries in the reporting database", changedFiles: ["src/db/reports.sql"] },
]

for (const scenario of SCENARIOS) {
  const run = await plan({
    request: scenario.request,
    changedFiles: scenario.changedFiles,
    skipRepoScan: true,
    persist: false,
  })
  console.log(`\n## ${scenario.title}`)
  console.log(`request      : ${scenario.request}`)
  console.log(`intent       : ${run.signals.intent}`)
  console.log(`complexity   : ${run.signals.complexity}`)
  console.log(`domains      : ${run.signals.touches.join(", ") || "-"}`)
  for (const step of run.policyTrace) {
    console.log(`${step.stage.padEnd(13)}: ${step.policy} -> +${step.added.join(", ")}  (${step.reason})`)
  }
  console.log(`capabilities : ${run.capabilities.join(" -> ")}`)
  console.log(`strategy     : ${run.strategy.id} (rule: ${run.strategy.rule}, max_parallel: ${run.strategy.maxParallel})`)
  for (const node of run.graph.nodes) {
    console.log(`  node ${node.id.padEnd(16)} phase=${node.phase.padEnd(9)} model=${node.provider.model}${node.expandable ? " (expandable)" : ""}`)
  }
  const plan_waves = waves(run.graph)
  console.log(`waves        : ${plan_waves.length} (${plan_waves.map((wave) => wave.length).join(" -> ")} concurrent)`)
  for (const [index, wave] of plan_waves.entries()) {
    console.log(`  wave ${index + 1}: ${wave.join(" ‖ ")}`)
  }
  console.log("```mermaid")
  console.log(toMermaid(run.graph))
  console.log("```")
}

// ---------------------------------------------------------------------------
// 7. The same request, understood two different ways.

const AMBIGUOUS = "Sort out the thing with the reports"

const VERDICTS = [
  {
    title: "7a. Understood (confidence 0.88)",
    triage: {
      intent: "optimize",
      complexity: "medium",
      domains: ["database"],
      rationale: "the reporting queries are slow, the developer wants them faster",
      confidence: 0.88,
    },
  },
  {
    title: "7b. Not understood (confidence 0.35)",
    triage: {
      intent: "optimize",
      complexity: "medium",
      domains: [],
      rationale: "'the thing' could be a bug, a layout issue or a performance problem",
      ambiguities: ["which reports", "what is wrong with them"],
      confidence: 0.35,
    },
  },
]

for (const variant of VERDICTS) {
  const run = await plan({ request: AMBIGUOUS, changedFiles: [], skipRepoScan: true, persist: false, triage: variant.triage })
  console.log(`\n## ${variant.title}`)
  console.log(`request      : ${AMBIGUOUS}`)
  console.log(`understanding: ${run.signals.understanding} (confidence ${run.signals.classification_confidence})`)
  console.log(`intent       : ${run.signals.intent}`)
  console.log(`complexity   : ${run.signals.complexity}`)
  console.log(`domains      : ${run.signals.touches.join(", ") || "-"}`)
  for (const step of run.policyTrace) {
    console.log(`${step.stage.padEnd(13)}: ${step.policy} -> +${step.added.join(", ")}  (${step.reason})`)
  }
  console.log(`capabilities : ${run.capabilities.join(" -> ")}`)
  console.log(`strategy     : ${run.strategy.id}`)
  for (const node of run.graph.nodes) {
    const mark = node.provider.escalated ? `  <- escalated: ${node.provider.escalationReason}` : ""
    console.log(`  node ${node.id.padEnd(16)} model=${node.provider.model} tier=${node.provider.tier}${mark}`)
  }
}

// ---------------------------------------------------------------------------
// 8. The attribution recap of a completed run.

const demo = await plan({
  request: "Implement OAuth 2.0 authentication with Google and GitHub providers",
  changedFiles: [],
  skipRepoScan: true,
})

const RESULTS = {
  research: { summary: "surveyed the two providers", confidence: 0.9 },
  planning: { summary: "five-step plan", confidence: 0.94 },
  architecture: { summary: "token flow approved", confidence: 0.9, verdict: "pass" },
  implementation: { summary: "OAuth flow implemented", confidence: 0.86, files: ["src/auth/oauth.ts"] },
  testing: { summary: "18 tests, all green", confidence: 0.91, verdict: "pass" },
  review: { summary: "no blocking findings", confidence: 0.9, verdict: "pass" },
  security: { summary: "tokens stored server-side", confidence: 0.93, verdict: "pass" },
  documentation: { summary: "auth guide written", confidence: 0.92, files: ["docs/auth.md"] },
}

for (let guard = 0; guard < 20; guard++) {
  const dispatch = next(demo.id)
  if (!dispatch.dispatch?.length) break
  console.log(`\ndispatch wave: ${dispatch.dispatch.map((node) => node.nodeId).join(" ‖ ")}`)
  for (const node of dispatch.dispatch) {
    record(demo.id, node.nodeId, { status: "ok", ...(RESULTS[node.capability] ?? { summary: "done", confidence: 0.9 }) })
  }
}

const recap = report(demo.id)
console.log(`\n## 8. Attribution recap`)
console.log(`request      : ${recap.request}`)
console.log(`understanding: ${recap.understanding.band ?? recap.understanding.source}`)
console.log(recap.table)
console.log("\nby model:")
for (const entry of recap.models) {
  console.log(`  ${entry.model.padEnd(34)} tier=${String(entry.tier).padEnd(9)} steps=${entry.steps}  ${entry.capabilities.join(", ")}`)
}
console.log(
  `\nparallelism  : ${recap.parallelism.waves} waves, widest ${recap.parallelism.widest} concurrent ` +
    `(${recap.parallelism.concurrent.join(" -> ")}), budget ${recap.parallelism.maxParallel}`,
)

if (existsSync(runPath(demo.id))) rmSync(runPath(demo.id))
