/**
 * CAAO — centralised configuration distribution.
 *
 * A platform team owns the four registries, the catalog and the Execution
 * Manager prompt. Developers must run exactly those files, without anyone
 * copy-pasting YAML into a hundred repositories.
 *
 * The unit of distribution is a **bundle**: the managed files, plus a version
 * that is the SHA-256 of their content. Nobody bumps a version number by hand —
 * if the bytes are identical the version is identical, so "is this machine up to
 * date" is a string comparison rather than a judgement call.
 *
 * Bundles are signed with Ed25519. This is not ceremony: these files decide
 * which model runs with which tools and what the Execution Manager is told to
 * do. A compromised distribution server that could push arbitrary agent
 * instructions would be remote code execution by proxy. Developers verify every
 * bundle against a public key they already trust and refuse anything else.
 */

import { createHash, generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"

/**
 * The only files the platform team owns. Agent definitions are deliberately
 * absent: they are generated deterministically from these, so shipping them
 * would be shipping a derived artefact that can go stale.
 */
export const MANAGED_FILES = [
  "capabilities.yaml",
  "providers.yaml",
  "policies.yaml",
  "workflows.yaml",
  "catalog.yaml",
  "prompts/execution-manager.md",
]

const OPTIONAL_FILES = new Set(["catalog.yaml"])

/** Stable serialisation, so the same content always hashes to the same version. */
function canonical(files) {
  return JSON.stringify(Object.keys(files).sort().map((name) => [name, files[name]]))
}

export function bundleVersion(files) {
  return createHash("sha256").update(canonical(files)).digest("hex").slice(0, 16)
}

export function readManagedFiles(root) {
  const files = {}
  for (const name of MANAGED_FILES) {
    try {
      files[name] = readFileSync(join(root, name), "utf8")
    } catch (error) {
      if (!OPTIONAL_FILES.has(name)) throw new Error(`CAAO: managed file "${name}" is missing from ${root}`)
    }
  }
  return files
}

/**
 * `channel` lets a platform team roll out gradually: canary machines follow
 * `canary`, everyone else stays on `stable` until it is promoted.
 */
export function buildBundle(root, { channel = "stable", notes = "" } = {}) {
  const files = readManagedFiles(root)
  return {
    schema: 1,
    channel,
    notes,
    generatedAt: new Date().toISOString(),
    version: bundleVersion(files),
    files,
  }
}

/** Only the content is signed — timestamps and notes must not affect the signature. */
function signedPayload(bundle) {
  return Buffer.from(`${bundle.schema}:${bundle.channel}:${bundle.version}:${canonical(bundle.files)}`, "utf8")
}

export function signBundle(bundle, privateKeyPem) {
  return cryptoSign(null, signedPayload(bundle), privateKeyPem).toString("base64")
}

/**
 * Verification is deliberately strict and returns a reason rather than a
 * boolean: a developer whose update was refused needs to know whether the key
 * is wrong or the content was tampered with.
 */
export function verifyBundle(bundle, signature, publicKeyPem, { expectedChannel = null } = {}) {
  if (!bundle || typeof bundle !== "object") return { ok: false, reason: "bundle is not an object" }
  if (bundle.schema !== 1) return { ok: false, reason: `unsupported bundle schema ${bundle.schema}` }
  if (expectedChannel && bundle.channel !== expectedChannel) {
    return { ok: false, reason: `bundle channel "${bundle.channel}" does not match expected channel "${expectedChannel}"` }
  }
  if (!bundle.files || typeof bundle.files !== "object") return { ok: false, reason: "bundle carries no files" }

  for (const name of Object.keys(bundle.files)) {
    if (!MANAGED_FILES.includes(name)) return { ok: false, reason: `bundle contains an unmanaged file "${name}"` }
  }
  for (const name of MANAGED_FILES) {
    if (!(name in bundle.files) && !OPTIONAL_FILES.has(name)) return { ok: false, reason: `bundle is missing "${name}"` }
  }
  if (bundleVersion(bundle.files) !== bundle.version) return { ok: false, reason: "bundle version does not match its content" }

  if (!publicKeyPem) return { ok: false, reason: "no trusted public key configured" }
  if (!signature) return { ok: false, reason: "bundle is not signed" }

  let valid = false
  try {
    valid = cryptoVerify(null, signedPayload(bundle), publicKeyPem, Buffer.from(signature, "base64"))
  } catch (error) {
    return { ok: false, reason: `signature could not be checked: ${error.message}` }
  }
  return valid ? { ok: true, reason: "signature verified" } : { ok: false, reason: "signature does not match the trusted key" }
}

/** Refuses to write outside the managed set, whatever the server claims to be sending. */
function targetPath(root, name) {
  const target = resolve(root, name)
  const base = resolve(root)
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`CAAO: refusing to write outside ${base}`)
  return target
}

/**
 * Writes only what actually differs, via a temporary file and a rename, so an
 * interrupted update never leaves half a YAML file on disk.
 */
export function applyBundle(bundle, root) {
  const changed = []
  const previous = {}
  for (const [name, content] of Object.entries(bundle.files)) {
    if (!MANAGED_FILES.includes(name)) continue
    const target = targetPath(root, name)
    let current = null
    try {
      current = readFileSync(target, "utf8")
    } catch {
      current = null
    }
    if (current === content) continue

    previous[name] = current
    mkdirSync(dirname(target), { recursive: true })
    const staging = `${target}.caao-tmp`
    writeFileSync(staging, content, "utf8")
    renameSync(staging, target)
    changed.push(name)
  }
  return { version: bundle.version, channel: bundle.channel, changed, previous }
}

/** Restore the exact managed-file state that existed before an unsuccessful apply. */
export function rollbackBundle(applied, root) {
  for (const name of [...(applied.changed ?? [])].reverse()) {
    const target = targetPath(root, name)
    const previous = applied.previous?.[name]
    if (previous === null || previous === undefined) {
      if (existsSync(target)) unlinkSync(target)
      continue
    }

    const staging = `${target}.caao-tmp`
    writeFileSync(staging, previous, "utf8")
    renameSync(staging, target)
  }
}

/** For the platform team: `npm run caao:keygen`. */
export function generateSigningKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  }
}
