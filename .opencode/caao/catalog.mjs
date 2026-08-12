#!/usr/bin/env node
/**
 * Materialise the company catalog on this machine: write the `mcp` block into
 * opencode.json and drop any inline skill files.
 *
 * The distribution server does this automatically after an update, but a
 * workspace with no distribution server configured used to never do it at all —
 * every MCP in catalog.yaml was declared and none of them was ever started.
 *
 *   npm run caao:catalog
 */

import { CAAO_HOME, loadConfig } from "./config.js"
import { syncCatalog } from "./catalog-sync.js"
import { repoSignals } from "./context.js"
import { diagnose, formatDiagnostics } from "./doctor.js"
import { dirname } from "node:path"

const context = repoSignals(dirname(CAAO_HOME))
const target = { repo: context.repo ?? null, team: process.env.CAAO_TEAM ?? null }
const config = loadConfig()
const result = syncCatalog(config, CAAO_HOME, target)

console.log(
  `caao: ${result.mcp.length} MCP server(s) wired into opencode.json for ` +
    `${target.repo ?? "this workspace"}${target.team ? ` / team ${target.team}` : ""}`,
)
for (const id of result.mcp) console.log(`  · ${id}`)
if (result.requiredEnv.length > 0) console.log(`\ncaao: these environment variables must be set: ${result.requiredEnv.join(", ")}`)

console.log()
console.log(formatDiagnostics(diagnose(config, target)))
