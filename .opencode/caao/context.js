/**
 * CAAO — repository context signals.
 *
 * The Context Builder answers one question: what does this request actually
 * touch? Workers receive only that, which is what keeps token usage and
 * hallucination rates down.
 */

import { execFileSync } from "node:child_process"
import { basename } from "node:path"

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return ""
  }
}

export function changedFiles(cwd = process.cwd()) {
  const porcelain = git(["status", "--porcelain"], cwd)
  const working = porcelain
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((entry) => (entry.includes(" -> ") ? entry.split(" -> ")[1] : entry))

  const committed = git(["diff", "--name-only", "HEAD~1..HEAD"], cwd)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  return [...new Set([...working, ...committed])]
}

/**
 * `owner/name` from any git remote form: ssh, https, with or without `.git`.
 * This is the key every run is filed under, so an enterprise dashboard can show
 * one repository at a time instead of one undifferentiated stream.
 */
export function repoSlug(remote) {
  if (!remote) return null
  const cleaned = remote.trim().replace(/\.git$/, "")
  const match = cleaned.match(/[/:]([^/:]+)\/([^/]+)$/)
  return match ? `${match[1]}/${match[2]}` : null
}

export function repoSignals(cwd = process.cwd()) {
  const files = changedFiles(cwd)
  const remote = git(["remote", "get-url", "origin"], cwd).trim() || null
  const slug = repoSlug(remote)
  return {
    cwd,
    branch: git(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim() || null,
    remote,
    repo: slug,
    // A repo-less working copy still needs a stable bucket in the dashboard.
    project: slug ?? basename(cwd),
    commit: git(["rev-parse", "--short", "HEAD"], cwd).trim() || null,
    changedFiles: files,
    changed_files: files.length,
    isGitRepo: git(["rev-parse", "--is-inside-work-tree"], cwd).trim() === "true",
  }
}

/**
 * Who to attribute the spend to. CAAO_ACTOR wins so CI and shared runners can
 * declare themselves; otherwise the git identity, which is what a developer
 * machine already has configured.
 */
export function actor(cwd = process.cwd()) {
  const declared = process.env.CAAO_ACTOR?.trim()
  if (declared) return declared
  const email = git(["config", "user.email"], cwd).trim()
  return email || process.env.USERNAME || process.env.USER || "unknown"
}
