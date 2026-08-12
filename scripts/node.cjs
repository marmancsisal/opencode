// Node 12 must be able to parse this file — it is what replaces Node 12.
// `wsl npm run <script>` from Windows never sources nvm, so npm resolves to the
// distro's ancient Node and every module fails on `??`. Re-exec on a usable one.
"use strict"

const { spawn } = require("child_process")
const { existsSync, readdirSync } = require("fs")
const { homedir } = require("os")
const { delimiter, dirname, join } = require("path")

const MINIMUM_MAJOR = 20

function parts(version) {
  return String(version).replace(/^v/, "").split(".").map(Number)
}

function newer(a, b) {
  const left = parts(a)
  const right = parts(b)
  for (let i = 0; i < 3; i += 1) {
    if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0)
  }
  return false
}

function nvmCandidate() {
  const root = join(homedir(), ".nvm", "versions", "node")
  if (!existsSync(root)) return null
  let best = null
  readdirSync(root).forEach(function (version) {
    if (parts(version)[0] < MINIMUM_MAJOR) return
    if (best === null || newer(version, best)) best = version
  })
  if (best === null) return null
  const binary = join(root, best, "bin", "node")
  return existsSync(binary) ? binary : null
}

const binary = parts(process.versions.node)[0] >= MINIMUM_MAJOR ? process.execPath : nvmCandidate()

if (binary === null) {
  console.error("CAAO: this runs on Node " + MINIMUM_MAJOR + "+, and " + process.versions.node + " is what answered.")
  console.error("      No newer install was found under ~/.nvm/versions/node either.")
  console.error("      Install one:  nvm install --lts")
  process.exit(1)
}

// Globals like `opencode` live next to the interpreter we picked, so they follow it onto PATH.
const env = Object.assign({}, process.env)
const bin = dirname(binary)
if (String(env.PATH || "").split(delimiter).indexOf(bin) === -1) {
  env.PATH = bin + delimiter + (env.PATH || "")
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit", env: env })
child.on("exit", function (code, signal) {
  process.exit(signal ? 1 : code === null ? 1 : code)
})
