/**
 * CAAO — opencode integration plugin.
 *
 * Exposes the orchestration engine to the Execution Manager as tools.
 * Capability workers are generated as agent files by `npm run caao:sync`
 * (see ../caao/agents.js): opencode only honours per-agent tool restrictions
 * declared in the agent definition itself, not ones injected at runtime.
 */

import { tool } from "@opencode-ai/plugin"

import { loadConfig } from "../caao/config.js"
import { detectDrift } from "../caao/agents.js"
import { providerTable, resolveProvider } from "../caao/provider.js"
import { allCapabilities } from "../caao/config.js"
import { detectDomains } from "../caao/classify.js"
import { repoSignals } from "../caao/context.js"
import { catalog, manifestFor } from "../caao/catalog.js"
import { diagnose } from "../caao/doctor.js"
import { observationFrom } from "../caao/usage.js"
import { distributionSettings, distributionState, updateOnStartup } from "../caao/update.js"
import {
  expand,
  ingestUsage,
  listRuns,
  merge,
  next,
  plan,
  record,
  recordContextSavings,
  report,
  status,
  toMermaid,
  triageBrief,
} from "../caao/engine.js"

const z = tool.schema

function jsonResult(title, payload) {
  return { title, output: JSON.stringify(payload, null, 2), metadata: { caao: true } }
}

export const CaaoPlugin = async ({ directory, worktree }) => {
  // Centrally distributed configuration is refreshed before anything reads it,
  // so a session never starts on registries the platform team has retired.
  const refresh = await updateOnStartup()
  if (refresh.status === "updated") {
    console.log(`caao: configuration updated to ${refresh.version} (${refresh.changed.length} file(s), ${refresh.agents} agents regenerated)`)
  } else if (refresh.status === "rejected") {
    console.warn(`caao: REFUSED the published configuration — ${refresh.reason}. Running the last verified bundle.`)
  } else if (refresh.status === "unreachable") {
    console.warn(`caao: configuration server unreachable (${refresh.reason}). Running ${refresh.version ?? "the local configuration"}.`)
  }

  const caao = loadConfig()
  const cwd = worktree ?? directory ?? process.cwd()
  const target = { repo: repoSignals(cwd).repo ?? null, team: process.env.CAAO_TEAM ?? null }

  // The catalog used to be materialised into opencode.json only after a
  // successful distribution update, so a workspace with no distribution server
  // declared MCP servers opencode was never told about — configured and dead.
  // Startup only reports it: rewriting the config of the process that is
  // reading it would be both invisible and too late to take effect.
  const diagnostics = diagnose(caao, target)
  for (const check of diagnostics.checks.filter((entry) => entry.status !== "ok")) {
    console.warn(`caao: ${check.id} is declared but unusable — ${check.problems.join("; ")}`)
  }

  // Token accounting needs to know which run a model call belongs to. Every
  // orchestration tool call refreshes it, which covers the whole lifetime of a
  // run without the workers having to know anything about billing.
  let activeRunId = null
  const track = (runId) => {
    if (runId) activeRunId = runId
    return runId
  }
  const contextTools = catalog(caao).contextTools

  return {
    async config(cfg) {
      cfg.model ??= resolveProvider(caao, "planning").model

      const drift = detectDrift(caao)
      if (drift.length > 0) {
        console.warn(
          `caao: ${drift.length} agent definition(s) are stale (${drift.map((a) => a.file).join(", ")}). Run "npm run caao:sync".`,
        )
      }
    },

    /**
     * The only place in the system where true token counts exist. Workers cannot
     * report their own usage — they never see it — so CAAO bills what opencode
     * observed instead of what a model claimed.
     */
    async event({ event }) {
      const observation = observationFrom(event)
      if (!observation) return
      ingestUsage(observation, { runId: activeRunId })
    },

    /** What the compression and retrieval MCPs claim to have bought back. */
    async "tool.execute.after"(input, output) {
      if (!contextTools.some((entry) => entry.enabled !== false)) return
      recordContextSavings(
        { tool: input.tool, output: output?.output ?? "", metadata: output?.metadata ?? null },
        { runId: activeRunId },
      )
    },

    tool: {
      caao_context: tool({
        description:
          "Repository context signals for a request: changed files, detected domains, branch. Cheap, read-only, safe to call before planning.",
        args: {
          request: z.string().optional().describe("the developer request, used for domain detection"),
        },
        async execute(args) {
          const repo = repoSignals(cwd)
          const domains = detectDomains(caao, { text: args.request ?? "", files: repo.changedFiles })
          return jsonResult("caao: context", { ...repo, domains })
        },
      }),

      caao_triage: tool({
        description:
          "Build the brief for the semantic triage worker. Dispatch the returned agent with the returned prompt, then feed its raw JSON answer to caao_plan as `triage`. Always do this before planning.",
        args: {
          request: z.string().describe("the developer request, verbatim"),
        },
        async execute(args) {
          const repo = repoSignals(cwd)
          const provider = resolveProvider(caao, "triage", {
            signals: { changed_files: repo.changedFiles.length, touches: [] },
          })
          return jsonResult("caao: triage", {
            agent: provider.agent,
            model: provider.model,
            prompt: triageBrief(caao, {
              request: args.request,
              changedFiles: repo.changedFiles,
              branch: repo.branch,
            }),
          })
        },
      }),

      caao_plan: tool({
        description:
          "Classify a request, resolve the required capabilities through the policy engine, select a workflow strategy and build the execution DAG. Returns a runId used by every other caao tool. Pass the triage verdict so classification is semantic, not keyword-based.",
        args: {
          request: z.string().describe("the developer request, verbatim"),
          triage: z
            .string()
            .optional()
            .describe("the raw JSON the caao-triage worker returned; omit only if triage was skipped"),
          intent: z.string().optional().describe("override the classified intent"),
          complexity: z.enum(["trivial", "medium", "high", "critical"]).optional().describe("override the classified complexity"),
        },
        async execute(args) {
          const run = plan({
            request: args.request,
            triage: args.triage,
            intent: args.intent,
            complexity: args.complexity,
            cwd,
          })
          track(run.id)
          return jsonResult(`caao: plan (${run.strategy.id})`, {
            runId: run.id,
            classification: run.signals,
            capabilities: run.capabilities,
            policyTrace: run.policyTrace,
            strategy: run.strategy,
            nodes: run.graph.nodes.map((node) => ({
              id: node.id,
              capability: node.capability,
              agent: node.agent,
              model: node.provider.model,
              tier: node.provider.tier,
              escalated: Boolean(node.provider.escalated),
              escalationReason: node.provider.escalationReason,
              dependsOn: node.dependsOn,
              expandable: Boolean(node.expandable),
            })),
            mermaid: toMermaid(run.graph),
          })
        },
      }),

      caao_next: tool({
        description:
          "Return the nodes whose dependencies are satisfied, with a ready-to-use worker brief for each. Nodes returned together are independent and must be dispatched in parallel.",
        args: { runId: z.string() },
        async execute(args) {
          return jsonResult("caao: next", next(track(args.runId)))
        },
      }),

      caao_expand: tool({
        description:
          "Expand a planning fan-out node into parallel workers using the subtasks produced by the planning capability.",
        args: {
          runId: z.string(),
          nodeId: z.string(),
          subtasks: z
            .array(
              z.object({
                id: z.string().optional(),
                title: z.string(),
                capability: z.string().optional(),
                description: z.string().optional(),
                depends_on: z.array(z.string()).optional(),
                files: z.array(z.string()).optional(),
              }),
            )
            .describe("independent units of work produced by the planner"),
        },
        async execute(args) {
          return jsonResult("caao: expand", expand(args.runId, args.nodeId, args.subtasks))
        },
      }),

      caao_record: tool({
        description:
          "Record a worker result and receive the engine decision: proceed, retry, switch provider, escalate, reopen the build phase or inject a capability.",
        args: {
          runId: z.string(),
          nodeId: z.string(),
          status: z.enum(["ok", "error", "timeout"]).default("ok"),
          confidence: z.number().min(0).max(1).optional(),
          summary: z.string().optional(),
          files: z.array(z.string()).optional().describe("files the worker changed"),
          verdict: z.enum(["pass", "fail"]).optional().describe("validation capabilities only"),
          findings_blocking: z.number().int().min(0).optional(),
          decision: z
            .enum(["retry", "switch_provider", "add_capability", "escalate_human"])
            .optional()
            .describe("advisor capability only"),
          capability: z.string().optional().describe("advisor add_capability target"),
          request_capabilities: z.array(z.string()).optional().describe("capability chaining requested by the worker"),
          tokens_in: z.number().int().min(0).optional().describe("prompt tokens the worker consumed, for cost attribution"),
          tokens_out: z.number().int().min(0).optional().describe("completion tokens the worker produced, for cost attribution"),
          tokens_cached: z.number().int().min(0).optional().describe("cached prompt tokens, billed at the reduced rate"),
        },
        async execute(args) {
          const { runId, nodeId, ...result } = args
          return jsonResult("caao: record", record(track(runId), nodeId, result))
        },
      }),

      caao_merge: tool({
        description: "Merge every worker contribution into a unified state, detect conflicts and list pending validation gates.",
        args: { runId: z.string() },
        async execute(args) {
          return jsonResult("caao: merge", merge(track(args.runId)))
        },
      }),

      caao_catalog: tool({
        description:
          "Central MCP and skill catalog: what the platform team distributes company-wide, and which entries apply to this repository or team.",
        args: {
          repo: z.string().optional().describe("owner/name slug; defaults to the current repository"),
          team: z.string().optional().describe("team name; defaults to CAAO_TEAM"),
          manifest: z.boolean().optional().describe("true returns only what this machine should receive"),
        },
        async execute(args) {
          const config = loadConfig()
          const target = {
            repo: args.repo ?? repoSignals(cwd).repo ?? null,
            team: args.team ?? process.env.CAAO_TEAM ?? null,
          }
          return args.manifest
            ? jsonResult("caao: catalog manifest", manifestFor(config, target))
            : jsonResult("caao: catalog", { ...catalog(config), target })
        },
      }),

      caao_doctor: tool({
        description:
          "Check that every MCP server and context tool this machine should be running is actually usable: binary on PATH, environment variables set, entry wired into opencode.json. Use it when a tool you expected is missing.",
        args: {
          repo: z.string().optional().describe("owner/name slug; defaults to the current repository"),
          team: z.string().optional().describe("team name; defaults to CAAO_TEAM"),
        },
        async execute(args) {
          const config = loadConfig()
          return jsonResult(
            "caao: diagnostics",
            diagnose(config, { repo: args.repo ?? target.repo, team: args.team ?? target.team }),
          )
        },
      }),

      caao_status: tool({
        description: "Full state of a run: classification, policy trace, node states, provider assignments and a mermaid graph.",
        args: { runId: z.string().optional().describe("omit to list recent runs") },
        async execute(args) {
          if (!args.runId) {
            return jsonResult("caao: runs", listRuns().slice(0, 10).map((run) => ({ id: run.id, status: run.status, request: run.request })))
          }
          return jsonResult("caao: status", status(args.runId))
        },
      }),

      caao_report: tool({
        description:
          "Attribution recap for a run: how the request was understood, which capability ran on which model, escalations, retries, confidence and timing. Use it to build the recap section of the final answer.",
        args: { runId: z.string() },
        async execute(args) {
          return jsonResult("caao: report", report(args.runId))
        },
      }),

      caao_registry: tool({
        description: "Introspect the declarative configuration: capabilities, provider bindings, policies, workflow strategies and which distributed bundle this machine is running.",
        args: {
          kind: z.enum(["capabilities", "providers", "policies", "workflows", "distribution", "all"]).default("all"),
        },
        async execute(args) {
          const views = {
            capabilities: () =>
              allCapabilities(caao).map(({ id, title, phase, intent, parallelizable, mutates, context }) => ({
                id,
                title,
                phase,
                intent,
                parallelizable,
                mutates: Boolean(mutates),
                context,
              })),
            providers: () => providerTable(caao),
            policies: () => ({ base: caao.policies.base, augment: caao.policies.augment, post: caao.policies.post }),
            workflows: () => ({ selection: caao.workflows.selection, strategies: caao.workflows.strategies }),
            distribution: () => {
              const settings = distributionSettings()
              return {
                ...distributionState(),
                source: settings.enabled ? settings.url : "local files (no distribution server configured)",
                channel: settings.channel,
                autoUpdate: settings.autoUpdate,
                trusted: Boolean(settings.publicKey),
                lastStartupCheck: refresh.status,
                diagnostics: { ok: diagnostics.ok, ...diagnostics.totals },
                unwired: diagnostics.checks.filter((check) => !check.wired).map((check) => check.id),
              }
            },
          }
          if (args.kind === "all") {
            return jsonResult("caao: registry", Object.fromEntries(Object.entries(views).map(([key, fn]) => [key, fn()])))
          }
          return jsonResult(`caao: ${args.kind}`, views[args.kind]())
        },
      }),
    },
  }
}
