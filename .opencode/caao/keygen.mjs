#!/usr/bin/env node
/**
 * Platform team only: mint the Ed25519 pair used to sign configuration bundles.
 *
 * The private key stays on the distribution server. The public key ships to
 * every developer machine — it is not a secret, and it is the only thing
 * standing between a compromised config server and arbitrary agent
 * instructions running on a hundred laptops.
 *
 * Usage: node .opencode/caao/keygen.mjs [outputDirectory]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { generateSigningKeys } from "./distribution.js"

const target = resolve(process.argv[2] ?? "caao-keys")
const privatePath = join(target, "caao-signing.key")
const publicPath = join(target, "caao-signing.pub")

if (existsSync(privatePath)) {
  console.error(`caao: ${privatePath} already exists. Refusing to overwrite a signing key.`)
  process.exit(1)
}

const { publicKey, privateKey } = generateSigningKeys()
mkdirSync(target, { recursive: true })
writeFileSync(privatePath, privateKey, { encoding: "utf8", mode: 0o600 })
writeFileSync(publicPath, publicKey, "utf8")

console.log(`caao: signing key pair written to ${target}`)
console.log(`  private  ${privatePath}   → distribution server only, never commit this`)
console.log(`  public   ${publicPath}    → ship to every developer machine`)
console.log("")
console.log("On the distribution server:")
console.log(`  $env:CAAO_SIGNING_KEY = "${privatePath}"`)
console.log("  npm run caao:dist")
console.log("")
console.log("On a developer machine, in .opencode/distribution.json:")
console.log(`  { "url": "https://caao.internal.acme.dev", "channel": "stable", "publicKey": "caao-signing.pub" }`)
