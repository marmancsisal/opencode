/**
 * CAAO — declarative configuration loader.
 *
 * capabilities.yaml / providers.yaml / policies.yaml / workflows.yaml are the
 * only source of truth. Nothing in the engine hardcodes a workflow.
 */

import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
import { validateCatalog } from "./catalog.js"

const HERE = dirname(fileURLToPath(import.meta.url))
export const CAAO_HOME = resolve(HERE, "..")

const FILES = {
  capabilities: "capabilities.yaml",
  providers: "providers.yaml",
  policies: "policies.yaml",
  workflows: "workflows.yaml",
}

// Optional: a workspace without a catalog is still a valid workspace.
const OPTIONAL_FILES = {
  catalog: "catalog.yaml",
}

const cache = new Map()

function readYaml(root, file) {
  const path = join(root, file)
  try {
    return YAML.parse(readFileSync(path, "utf8")) ?? {}
  } catch (error) {
    throw new Error(`CAAO: cannot load ${file} from ${root}: ${error.message}`)
  }
}

function readOptionalYaml(root, file) {
  try {
    readFileSync(join(root, file), "utf8")
  } catch {
    return null
  }
  return readYaml(root, file)
}

/** Fails loudly on a configuration that would produce a nonsensical graph. Exported so tests can prove it. */
export function validateConfig(config) {
  const problems = []
  const capabilityIds = Object.keys(config.capabilities.capabilities ?? {})
  if (capabilityIds.length === 0) problems.push("capabilities.yaml declares no capabilities")

  const phases = config.capabilities.phases ?? {}
  for (const [id, capability] of Object.entries(config.capabilities.capabilities ?? {})) {
    if (!capability.phase) problems.push(`capability "${id}" has no phase`)
    else if (!(capability.phase in phases)) problems.push(`capability "${id}" uses unknown phase "${capability.phase}"`)
    for (const required of capability.requires ?? []) {
      if (!capabilityIds.includes(required)) problems.push(`capability "${id}" requires unknown capability "${required}"`)
    }
    for (const requested of capability.may_request ?? []) {
      if (!capabilityIds.includes(requested)) problems.push(`capability "${id}" may_request unknown capability "${requested}"`)
    }
  }

  const pools = config.providers.pools ?? {}
  const profiles = config.providers.profiles ?? {}
  for (const [name, profile] of Object.entries(profiles)) {
    if (profile.strategy && !(profile.strategy in (config.providers.strategies ?? {}))) {
      problems.push(`provider profile "${name}" uses unknown strategy "${profile.strategy}"`)
    }
    for (const candidate of profile.candidates ?? []) {
      if (!(candidate in pools)) problems.push(`provider profile "${name}" references unknown pool "${candidate}"`)
    }
  }
  for (const [capability, binding] of Object.entries(config.providers.bindings ?? {})) {
    if (!capabilityIds.includes(capability)) problems.push(`providers.yaml binds unknown capability "${capability}"`)
    if (!(binding.strategy in (config.providers.strategies ?? {}))) {
      problems.push(`capability "${capability}" uses unknown strategy "${binding.strategy}"`)
    }
    for (const candidate of binding.candidates ?? []) {
      if (!(candidate in pools)) problems.push(`capability "${capability}" references unknown pool "${candidate}"`)
    }
    for (const override of binding.overrides ?? []) {
      if (!override.when) problems.push(`capability "${capability}" has a provider override without a "when" condition`)
      if (!override.profile && !override.candidates) {
        problems.push(`capability "${capability}" has a provider override with neither "profile" nor "candidates"`)
      }
      if (override.profile && !(override.profile in profiles)) {
        problems.push(`capability "${capability}" references unknown provider profile "${override.profile}"`)
      }
      for (const candidate of override.candidates ?? []) {
        if (!(candidate in pools)) problems.push(`capability "${capability}" override references unknown pool "${candidate}"`)
      }
    }
  }
  for (const id of capabilityIds) {
    if (!(id in (config.providers.bindings ?? {}))) problems.push(`capability "${id}" has no provider binding`)
  }

  for (const group of ["base", "augment", "post"]) {
    for (const policy of config.policies[group] ?? []) {
      for (const capability of policy.capabilities ?? []) {
        if (!capabilityIds.includes(capability)) {
          problems.push(`policy "${policy.id}" selects unknown capability "${capability}"`)
        }
      }
    }
  }

  const strategies = Object.keys(config.workflows.strategies ?? {})
  for (const rule of config.workflows.selection ?? []) {
    if (!strategies.includes(rule.strategy)) problems.push(`workflow rule "${rule.id}" uses unknown strategy "${rule.strategy}"`)
  }

  const phaseOrder = config.workflows.execution?.phase_order ?? Object.keys(phases)
  for (const phase of Object.keys(phases)) {
    if (!phaseOrder.includes(phase)) problems.push(`phase "${phase}" is declared but missing from execution.phase_order`)
  }
  for (const [phase, dependencies] of Object.entries(config.workflows.execution?.phase_depends_on ?? {})) {
    if (!phaseOrder.includes(phase)) {
      problems.push(`phase_depends_on references unknown phase "${phase}"`)
      continue
    }
    for (const dependency of dependencies ?? []) {
      if (!phaseOrder.includes(dependency)) problems.push(`phase "${phase}" depends on unknown phase "${dependency}"`)
      else if (phaseOrder.indexOf(dependency) >= phaseOrder.indexOf(phase)) {
        problems.push(`phase "${phase}" depends on "${dependency}", which does not run earlier`)
      }
    }
  }

  if (problems.length > 0) throw new Error(`CAAO configuration is invalid:\n- ${problems.join("\n- ")}`)
  validateCatalog(config.catalog ?? {})
  return config
}

export function loadConfig(root = CAAO_HOME, { fresh = false } = {}) {
  const key = resolve(root)
  if (!fresh && cache.has(key)) return cache.get(key)

  const config = validateConfig({
    root: key,
    capabilities: readYaml(key, FILES.capabilities),
    providers: readYaml(key, FILES.providers),
    policies: readYaml(key, FILES.policies),
    workflows: readYaml(key, FILES.workflows),
    catalog: readOptionalYaml(key, OPTIONAL_FILES.catalog) ?? { version: 1, mcp: [], skills: [] },
  })

  cache.set(key, config)
  return config
}

export function capability(config, id) {
  const found = config.capabilities.capabilities?.[id]
  if (!found) throw new Error(`CAAO: unknown capability "${id}"`)
  const defaults = config.capabilities.defaults ?? {}
  return {
    id,
    ...defaults,
    ...found,
    phaseRank: config.capabilities.phases[found.phase],
  }
}

export function allCapabilities(config) {
  return Object.keys(config.capabilities.capabilities ?? {}).map((id) => capability(config, id))
}

export function clearCache() {
  cache.clear()
}
