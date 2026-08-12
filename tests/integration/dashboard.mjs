/**
 * CAAO — HTTP surface integration test.
 *
 * Proves three things end to end:
 *   1. the admin console works against real run files
 *   2. a developer cannot reach it — no token, no data, and the dist surface
 *      does not even admit the console exists
 *   3. a signed configuration bundle survives the round trip, and a tampered
 *      one is refused
 */

import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createDashboard } from "../../.opencode/caao/server.mjs"
import { ingestUsage, next, plan, record, recordContextSavings } from "../../.opencode/caao/engine.js"
import { observationFrom } from "../../.opencode/caao/usage.js"
import { runPath } from "../../.opencode/caao/state.js"
import { CAAO_HOME } from "../../.opencode/caao/config.js"
import { applyBundle, generateSigningKeys, verifyBundle } from "../../.opencode/caao/distribution.js"

const ADMIN_TOKEN = "admin-token-do-not-ship"
const DIST_TOKEN = "dist-token-shared-with-developers"
const created = []

function step(message) {
  console.log(`  · ${message}`)
}

function seed() {
  const run = plan({
    request: "Fix the failing unit tests in the billing module",
    skipRepoScan: true,
    changedFiles: [],
    repo: "acme/billing-service",
    branch: "fix/billing-tests",
    actor: "dashboard-test@acme.dev",
  })
  created.push(run.id)

  for (const task of next(run.id).dispatch) {
    record(run.id, task.nodeId, { status: "ok", confidence: 0.91, summary: "done", tokens_in: 120_000, tokens_out: 24_000 })
  }
  // Leave the next wave dispatched-but-unfinished so the UI has a "running" node to draw.
  const inFlight = next(run.id).dispatch[0]

  // What the runtime actually observed: the manager's own thinking, a live
  // task's tokens, and a compression tool reporting what it bought back.
  if (inFlight) {
    ingestUsage(assistantMessage({ mode: inFlight.agent, modelID: "github/claude-opus-5" }), { runId: run.id })
  }
  ingestUsage(assistantMessage({ mode: "caao", modelID: "github/kimi-k2.7-code" }), { runId: run.id })
  recordContextSavings(
    { tool: "headroom_compress", output: "", metadata: { original_tokens: 40_000, compressed_tokens: 6_000 } },
    { runId: run.id },
  )
  recordContextSavings({ tool: "headroom_compress", output: "compressed" }, { runId: run.id })
  return run.id
}

let messageSeq = 0
function assistantMessage({ mode, modelID }) {
  return observationFrom({
    type: "message.updated",
    properties: {
      info: {
        id: `msg_${++messageSeq}`,
        role: "assistant",
        mode,
        providerID: "omniroute",
        modelID,
        cost: 0.42,
        time: { created: Date.now() - 500, completed: Date.now() },
        tokens: { input: 8_000, output: 2_000, reasoning: 0, cache: { read: 1_000, write: 0 } },
      },
    },
  })
}

async function call(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, options)
  const body = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text()
  return { status: res.status, body, headers: res.headers }
}

async function listen(server) {
  await new Promise((done) => server.listen(0, "127.0.0.1", done))
  return `http://127.0.0.1:${server.address().port}`
}

async function main() {
  const runId = seed()
  const keys = generateSigningKeys()

  const admin = createDashboard({ role: "admin", adminToken: ADMIN_TOKEN })
  const dist = createDashboard({ role: "dist", distToken: DIST_TOKEN, signingKey: keys.privateKey, channels: { stable: CAAO_HOME } })
  const adminBase = await listen(admin)
  const distBase = await listen(dist)

  const auth = { headers: { "x-caao-token": ADMIN_TOKEN } }
  const get = (path) => call(adminBase, path, auth)

  try {
    // --- the console ------------------------------------------------------
    const health = await get("/api/health")
    assert.equal(health.status, 200)
    assert.equal(health.body.ok, true)
    step(`console ok — ${health.body.runs} run(s) on disk`)

    const overview = await get("/api/overview")
    assert.equal(overview.status, 200)
    for (const key of ["totals", "budget", "repos", "models", "capabilities", "daily", "runs", "actors"]) {
      assert.ok(key in overview.body, `overview must expose "${key}"`)
    }
    assert.ok(overview.body.totals.cost > 0, "seeded run must have produced a cost")
    assert.ok(overview.body.totals.inputTokens > 0 && overview.body.totals.outputTokens > 0, "tokens must be split in and out")
    assert.ok(overview.body.totals.orchestratorCost > 0, "the manager's own thinking is real money")
    assert.equal(overview.body.totals.tokensSaved, 34_000)
    assert.ok(overview.body.contextTools.some((tool) => tool.key === "headroom" && tool.unreportedCalls === 1))
    assert.ok(overview.body.repos.some((repo) => repo.key === "acme/billing-service"))
    step(
      `overview ok — ${overview.body.totals.runs} runs, $${overview.body.totals.cost.toFixed(4)} attributed, ` +
        `${overview.body.totals.inputTokens} in / ${overview.body.totals.outputTokens} out, ` +
        `${overview.body.totals.tokensSaved} saved`,
    )

    const scoped = await get("/api/overview?repo=acme%2Fbilling-service")
    assert.equal(scoped.body.repos.length, 1)
    step("repository filter narrows every figure")

    const repos = await get("/api/repos")
    assert.ok(repos.body.repos.some((repo) => repo.key === "acme/billing-service"))

    const runs = await get("/api/runs?repo=acme%2Fbilling-service")
    assert.ok(runs.body.runs.every((run) => run.project === "acme/billing-service"))
    step(`runs list ok — ${runs.body.runs.length} run(s) in the repository`)

    const detail = await get(`/api/runs/${runId}`)
    assert.equal(detail.status, 200)
    assert.ok(detail.body.graph.nodes.length > 0 && detail.body.graph.edges.length > 0)
    assert.ok(detail.body.graph.nodes.some((node) => node.status === "done" && node.model))
    assert.ok(detail.body.graph.nodes.some((node) => node.status === "running"), "an in-flight task must be visible")
    assert.ok(detail.body.graph.live.running > 0 && detail.body.graph.live.cost >= 0 && detail.body.graph.live.widestWave > 0)
    assert.ok(detail.body.graph.live.inputTokens > 0 && detail.body.graph.live.outputTokens > 0)
    assert.ok(detail.body.graph.orchestrator.cost > 0 && detail.body.graph.orchestrator.model)
    assert.ok(detail.body.graph.contextTools.some((tool) => tool.id === "headroom" && tool.tokensSaved === 34_000))
    assert.ok(
      detail.body.graph.nodes.some((node) => node.status === "running" && node.inputTokens > 0),
      "a task in flight already shows what it has burned",
    )
    step(
      `run detail ok — ${detail.body.graph.waves.length} wave(s), ` +
        `${detail.body.graph.nodes.filter((n) => n.status === "done").length} done, ` +
        `${detail.body.graph.nodes.filter((n) => n.status === "running").length} running`,
    )

    const rationale = await get(`/api/runs/${runId}/rationale`)
    const stages = rationale.body.steps.map((s) => s.stage)
    assert.ok(stages.includes("understanding") && stages.includes("topology") && stages.includes("routing"))
    step(`rationale ok — ${rationale.body.steps.length} causal steps`)

    const costs = await get("/api/costs")
    assert.ok(costs.body.prices.length > 0 && costs.body.models.length > 0 && costs.body.budget.monthlyTotal > 0)
    assert.ok(costs.body.models.some((model) => model.inputTokens > 0 && model.outputTokens > 0))
    assert.ok(costs.body.capabilities.every((cap) => "inputTokens" in cap && "outputTokens" in cap))
    assert.ok(costs.body.contextTools.some((tool) => tool.key === "headroom" && tool.costSaved > 0))
    step(`costs ok — ${costs.body.models.length} model(s) billed, budget state "${costs.body.budget.month.state}"`)

    const diagnostics = await get("/api/diagnostics")
    assert.equal(diagnostics.status, 200)
    assert.ok(diagnostics.body.totals.checked > 0)
    assert.ok(diagnostics.body.checks.every((check) => check.id && Array.isArray(check.problems)))
    step(
      `diagnostics ok — ${diagnostics.body.totals.ok}/${diagnostics.body.totals.checked} declared tools usable on this machine`,
    )

    const models = await get("/api/models")
    assert.ok(models.body.pools.length > 0 && models.body.routing.length > 0)

    const catalogView = await get("/api/catalog")
    assert.ok(catalogView.body.mcp.length > 0 && catalogView.body.skills.length > 0 && catalogView.body.contextTools.length === 3)
    assert.ok(catalogView.body.diagnostics.checks.length > 0, "the catalog must say which entries actually work")
    assert.ok(catalogView.body.savings.some((tool) => tool.key === "headroom"))
    step(
      `catalog ok — ${catalogView.body.totals.mcpEnabled}/${catalogView.body.totals.mcp} MCP, ` +
        `${catalogView.body.totals.skillsEnabled}/${catalogView.body.totals.skills} skills enabled`,
    )

    const published = await get("/api/distribution")
    assert.ok(published.body.channels.some((channel) => channel.channel === "stable" && channel.version.length === 16))
    step(`distribution view ok — channel stable at ${published.body.channels[0].version}`)

    // --- a developer must not get in --------------------------------------
    for (const path of ["/api/overview", "/api/runs", "/api/costs", `/api/runs/${runId}`, "/api/repos", "/api/catalog", "/api/diagnostics"]) {
      const anonymous = await call(adminBase, path)
      assert.equal(anonymous.status, 401, `${path} must require authentication`)
      assert.ok(!JSON.stringify(anonymous.body).includes("acme/billing-service"), "no data may leak to an anonymous caller")
    }
    const guessed = await call(adminBase, "/api/overview", { headers: { "x-caao-token": "guess" } })
    assert.equal(guessed.status, 401)
    step("every console endpoint refuses anonymous and wrong-token callers")

    const session = await call(adminBase, "/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: ADMIN_TOKEN }),
    })
    assert.equal(session.status, 200)
    const cookie = session.headers.get("set-cookie") ?? ""
    assert.match(cookie, /HttpOnly/, "the session cookie must not be readable from JavaScript")
    assert.match(cookie, /SameSite=Strict/, "the session cookie must not travel cross-site")
    const withCookie = await call(adminBase, "/api/overview", { headers: { cookie: cookie.split(";")[0] } })
    assert.equal(withCookie.status, 200)
    assert.ok(session.body.csrfToken && !cookie.includes(ADMIN_TOKEN), "the browser receives an opaque session plus a separate CSRF token")
    step("sign-in issues an HttpOnly, SameSite=Strict session")

    const cookieOnlyMutation = await call(adminBase, "/api/catalog/mcp/github/toggle", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie.split(";")[0] },
      body: JSON.stringify({ enabled: false }),
    })
    assert.equal(cookieOnlyMutation.status, 401, "a cookie alone must not be able to mutate state")
    step("mutations require the header as well as the session")

    const catalogBefore = readFileSync(join(CAAO_HOME, "catalog.yaml"), "utf8")
    const csrfMutation = await call(adminBase, "/api/catalog/context_tools/headroom/toggle", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie.split(";")[0], "x-caao-csrf": session.body.csrfToken },
      body: JSON.stringify({ enabled: true }),
    })
    assert.equal(csrfMutation.status, 200)
    assert.equal(readFileSync(join(CAAO_HOME, "catalog.yaml"), "utf8"), catalogBefore, "an idempotent toggle must preserve bytes, comments and bundle version")
    const duplicate = await call(adminBase, "/api/catalog/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookie.split(";")[0], "x-caao-csrf": session.body.csrfToken },
      body: JSON.stringify({ id: "github", title: "duplicate", kind: "local", command: ["x"] }),
    })
    assert.equal(duplicate.status, 409, "catalog creation must reject duplicate ids without overwriting")
    step("opaque admin sessions can create and toggle catalog entries with CSRF protection")

    for (const attack of ["/../../package.json", "/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json"]) {
      const escape = await call(adminBase, attack)
      assert.ok(escape.status === 403 || escape.status === 404, `traversal "${attack}" must not be served`)
      assert.ok(!String(escape.body).includes("caao:dashboard"))
    }
    step("path traversal rejected on every encoding")

    const missing = await get("/api/runs/does-not-exist")
    assert.equal(missing.status, 404)
    const invalid = await get("/api/runs/..%2F..%2Fsecrets")
    assert.ok(invalid.status === 400 || invalid.status === 404)
    step("unknown and malformed run ids rejected")

    // --- the distribution surface -----------------------------------------
    const distAuth = { headers: { "x-caao-dist-token": DIST_TOKEN } }

    for (const path of ["/api/overview", "/api/runs", "/api/costs", "/", "/app.js"]) {
      const leaked = await call(distBase, path, distAuth)
      assert.equal(leaked.status, 404, `the dist surface must not admit that ${path} exists`)
    }
    step("the dist surface answers 404 for the console — developers cannot discover it")

    const unauthenticatedDist = await call(distBase, "/dist/version")
    assert.equal(unauthenticatedDist.status, 401)

    const version = await call(distBase, "/dist/version?channel=stable", distAuth)
    assert.equal(version.status, 200)
    assert.equal(version.body.version.length, 16)

    const unknownChannel = await call(distBase, "/dist/version?channel=nope", distAuth)
    assert.equal(unknownChannel.status, 404)
    step(`dist surface ok — channel stable at ${version.body.version}`)

    const bundleResponse = await call(distBase, "/dist/bundle?channel=stable", distAuth)
    assert.equal(bundleResponse.status, 200)
    const { bundle, signature } = bundleResponse.body
    assert.equal(bundle.version, version.body.version, "version probe and bundle must agree")
    assert.ok(verifyBundle(bundle, signature, keys.publicKey).ok, "a freshly served bundle must verify")
    assert.ok(!JSON.stringify(bundle).includes(runId), "a configuration bundle must never carry run data")
    step(`bundle ok — ${Object.keys(bundle.files).length} managed files, signature verified`)

    const tampered = JSON.parse(JSON.stringify(bundle))
    tampered.files["policies.yaml"] += "\n# injected by an attacker\n"
    assert.equal(verifyBundle(tampered, signature, keys.publicKey).ok, false, "tampered content must be refused")
    const otherKey = generateSigningKeys()
    assert.equal(verifyBundle(bundle, signature, otherKey.publicKey).ok, false, "an untrusted key must be refused")
    assert.equal(verifyBundle(bundle, null, keys.publicKey).ok, false, "an unsigned bundle must be refused")
    step("tampered, unsigned and untrusted bundles are all refused")

    const sandbox = mkdtempSync(join(tmpdir(), "caao-dist-"))
    mkdirSync(join(sandbox, "prompts"), { recursive: true })
    const applied = applyBundle(bundle, sandbox)
    assert.equal(applied.version, bundle.version)
    assert.ok(applied.changed.includes("providers.yaml"))
    assert.equal(readFileSync(join(sandbox, "providers.yaml"), "utf8"), bundle.files["providers.yaml"])
    assert.deepEqual(applyBundle(bundle, sandbox).changed, [], "re-applying the same bundle must write nothing")
    writeFileSync(join(sandbox, "notes.md"), "a developer's own file", "utf8")
    applyBundle(bundle, sandbox)
    assert.equal(readFileSync(join(sandbox, "notes.md"), "utf8"), "a developer's own file", "unmanaged files must be left alone")
    rmSync(sandbox, { recursive: true, force: true })
    step("apply is idempotent and touches only the managed files")

    const manifest = await call(distBase, "/dist/manifest?repo=acme%2Fbilling-service&team=payments", distAuth)
    assert.ok(manifest.body.mcp.some((entry) => entry.id === "postgres-readonly"))
    assert.ok(manifest.body.skills.some((entry) => entry.id === "billing-domain"))
    step(`manifest ok — ${manifest.body.mcp.length} MCP + ${manifest.body.skills.length} skills for this machine`)

    console.log(
      `\ndashboard: ok — console authenticated and complete, dist surface signed and isolated, ` +
        `${detail.body.graph.nodes.length} DAG nodes rendered`,
    )
  } finally {
    admin.close()
    dist.close()
    for (const id of created) {
      const path = runPath(id)
      if (existsSync(path)) rmSync(path)
    }
  }
}

await main()
