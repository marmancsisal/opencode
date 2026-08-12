#!/usr/bin/env node
/**
 * Pull the current configuration bundle from the company distribution server,
 * verify its signature, apply it and regenerate the agents.
 *
 * Usage: node .opencode/caao/update.mjs [--force] [--check]
 */

import { checkVersion, distributionSettings, distributionState, update } from "./update.js"

const settings = distributionSettings()

if (!settings.enabled) {
  console.error("caao: no distribution server configured.")
  console.error('      Set CAAO_CONFIG_URL, or create .opencode/distribution.json with {"url": "…", "publicKey": "…"}.')
  process.exit(1)
}

if (process.argv.includes("--check")) {
  const state = distributionState()
  try {
    const status = await checkVersion()
    console.log(status.current ? `caao: up to date (${status.local ?? "none"}, channel ${status.channel})` : `caao: update available — ${status.local ?? "none"} → ${status.remote}`)
    process.exit(status.current ? 0 : 2)
  } catch (error) {
    console.error(`caao: cannot reach ${settings.url} (${error.message}); staying on ${state.version ?? "the bundled configuration"}`)
    process.exit(1)
  }
}

const result = await update(undefined, { force: process.argv.includes("--force") })

switch (result.status) {
  case "updated":
    console.log(`caao: updated to ${result.version} (channel ${result.channel})`)
    for (const file of result.changed) console.log(`  ~ ${file}`)
    console.log(`  regenerated ${result.agents} agent definition(s)`)
    break
  case "current":
    console.log(`caao: already on ${result.version} (channel ${result.channel})`)
    break
  case "unreachable":
    console.error(`caao: ${settings.url} unreachable (${result.reason}) — keeping ${result.version ?? "the bundled configuration"}`)
    process.exit(1)
  case "rejected":
    console.error(`caao: REFUSED the bundle — ${result.reason}`)
    console.error("      Nothing was written. Report this to the platform team before continuing.")
    process.exit(1)
  case "invalid":
    console.error(`caao: the bundle applied but does not validate — ${result.reason}`)
    process.exit(1)
  default:
    console.error(`caao: ${result.status}${result.reason ? ` — ${result.reason}` : ""}`)
    process.exit(1)
}
