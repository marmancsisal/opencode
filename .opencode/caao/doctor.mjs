#!/usr/bin/env node
/**
 * Check that every MCP server and context tool this machine should be running
 * is actually usable: binary on PATH, environment variables set, entry present
 * in opencode.json.
 *
 *   npm run caao:doctor
 *
 * Exits non-zero when something is broken, so CI can gate on it.
 */

import { CAAO_HOME, loadConfig } from "./config.js"
import { repoSignals } from "./context.js"
import { diagnose, formatDiagnostics } from "./doctor.js"
import { dirname } from "node:path"

const context = repoSignals(dirname(CAAO_HOME))
const report = diagnose(loadConfig(), { repo: context.repo ?? null, team: process.env.CAAO_TEAM ?? null })

console.log(formatDiagnostics(report))
if (!report.ok) {
  console.log("\ncaao: at least one declared tool cannot start. opencode will run with fewer tools and say nothing.")
  process.exit(1)
}
