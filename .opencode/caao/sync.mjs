#!/usr/bin/env node
/**
 * Regenerate the capability worker agents from capabilities.yaml + providers.yaml.
 * Run after changing either file: `npm run caao:sync`.
 */

import { loadConfig } from "./config.js"
import { syncAgents } from "./agents.js"

const result = syncAgents(loadConfig())

if (result.written.length === 0) {
  console.log(`caao: ${result.total} agents already in sync`)
} else {
  console.log(`caao: regenerated ${result.written.length}/${result.total} agents`)
  for (const file of result.written) console.log(`  - ${file}`)
}
