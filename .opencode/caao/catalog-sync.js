/** Materialise the signed company catalog on a developer workspace. */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { randomBytes } from "node:crypto"

import { manifestFor } from "./catalog.js"

const MANAGED_SKILL_MARKER = "<!-- managed by caao:catalog -->"

function readJson(path, fallback = {}) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  const staging = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  writeFileSync(staging, content, "utf8")
  renameSync(staging, path)
}

function safeTarget(root, relative) {
  const base = resolve(root)
  const target = resolve(root, relative)
  if (target === base || !target.startsWith(base + sep)) throw new Error(`CAAO: unsafe catalog target "${relative}"`)
  return target
}

export function syncCatalog(config, root, { repo = null, team = null } = {}) {
  const manifest = manifestFor(config, { repo, team })
  const opencodePath = join(root, "opencode.json")
  const statePath = join(root, "state", "catalog.json")
  const opencode = readJson(opencodePath)
  const previous = readJson(statePath, { managedMcp: [] })
  const previousSkills = new Set(previous.skills ?? [])
  const mcp = { ...(opencode.mcp ?? {}) }

  for (const id of previous.managedMcp ?? []) delete mcp[id]
  Object.assign(mcp, manifest.opencode.mcp)
  opencode.mcp = mcp
  atomicWrite(opencodePath, `${JSON.stringify(opencode, null, 2)}\n`)

  const skills = []
  for (const skill of manifest.skills) {
    if (typeof skill.content !== "string") continue
    const target = safeTarget(root, skill.file)
    const existing = existsSync(target) ? readFileSync(target, "utf8") : null
    if (existing !== null && !existing.startsWith(MANAGED_SKILL_MARKER) && !previousSkills.has(skill.file)) {
      throw new Error(`CAAO: refusing to overwrite developer-owned skill "${skill.file}"`)
    }
    const content = skill.content.endsWith("\n") ? skill.content : `${skill.content}\n`
    atomicWrite(target, `${MANAGED_SKILL_MARKER}\n${content}`)
    skills.push(skill.file)
  }
  for (const previousSkill of previous.skills ?? []) {
    if (skills.includes(previousSkill)) continue
    const obsolete = safeTarget(root, previousSkill)
    if (existsSync(obsolete) && readFileSync(obsolete, "utf8").startsWith(MANAGED_SKILL_MARKER)) unlinkSync(obsolete)
  }

  atomicWrite(
    statePath,
    `${JSON.stringify({ generatedAt: manifest.generatedAt, repo, team, managedMcp: Object.keys(manifest.opencode.mcp), skills }, null, 2)}\n`,
  )
  return { mcp: Object.keys(manifest.opencode.mcp), skills, requiredEnv: manifest.requiredEnv }
}
