/**
 * CAAO — workflow builder and DAG runtime.
 *
 * The builder never produces a sequence. It produces a phase-layered graph in
 * which every node that can run concurrently does run concurrently.
 */

import { capability as getCapability } from "./config.js"
import { resolveProvider } from "./provider.js"

const TERMINAL = new Set(["done", "expanded", "skipped"])

function orderedPhases(config) {
  const declared = config.workflows.execution?.phase_order
  if (declared?.length) return declared
  return Object.entries(config.capabilities.phases ?? {})
    .sort((a, b) => a[1] - b[1])
    .map(([phase]) => phase)
}

function makeNode(config, capabilityId, extra = {}, signals = null) {
  const capability = getCapability(config, capabilityId)
  const provider = resolveProvider(config, capabilityId, { signals })
  return {
    id: extra.id ?? capabilityId,
    capability: capabilityId,
    title: capability.title,
    phase: capability.phase,
    phaseRank: capability.phaseRank,
    agent: provider.agent,
    parallelizable: capability.parallelizable !== false,
    mutates: Boolean(capability.mutates),
    contextScope: capability.context,
    confidenceFloor: capability.confidence_floor,
    outputs: capability.outputs ?? [],
    mayRequest: capability.may_request ?? [],
    objective: capability.worker?.objective ?? capability.intent,
    checklist: capability.worker?.checklist ?? [],
    outputContract: capability.worker?.output_contract ?? "summary, confidence",
    dependsOn: [],
    status: "pending",
    attempts: 0,
    results: [],
    provider,
    providerHistory: [],
    ...extra,
  }
}

export function buildGraph(config, { capabilities, strategy, signals = null }) {
  const phases = orderedPhases(config)
  const phaseDeps = config.workflows.execution?.phase_depends_on ?? {}
  const selected = [...capabilities].sort((a, b) => {
    const ra = phases.indexOf(getCapability(config, a).phase)
    const rb = phases.indexOf(getCapability(config, b).phase)
    return ra === rb ? capabilities.indexOf(a) - capabilities.indexOf(b) : ra - rb
  })

  const nodes = []
  const layers = []
  const phaseExit = new Map()
  let previousPhaseExit = []

  for (const phase of phases) {
    const inPhase = selected.filter((id) => getCapability(config, id).phase === phase)
    if (inPhase.length === 0) continue

    const declared = phaseDeps[phase]
    const upstream = declared
      ? declared.flatMap((dependency) => phaseExit.get(dependency) ?? [])
      : previousPhaseExit
    // A phase whose declared inputs are all absent still may not start from nothing.
    const entryDeps = declared && upstream.length === 0 ? previousPhaseExit : upstream

    const serial = inPhase.filter((id) => getCapability(config, id).parallelizable === false)
    const parallel = inPhase.filter((id) => getCapability(config, id).parallelizable !== false)

    const subLayers = serial.map((id) => [id])
    if (parallel.length > 0) subLayers.push(parallel)

    let previousSubLayer = entryDeps
    for (const subLayer of subLayers) {
      const layerNodes = subLayer.map((id) => {
        const node = makeNode(config, id, {}, signals)
        node.dependsOn = [...previousSubLayer]
        node.layer = layers.length
        return node
      })
      // explicit capability-level dependencies
      for (const node of layerNodes) {
        for (const required of getCapability(config, node.capability).requires ?? []) {
          if (selected.includes(required) && !node.dependsOn.includes(required)) node.dependsOn.push(required)
        }
      }
      nodes.push(...layerNodes)
      layers.push(layerNodes.map((node) => node.id))
      previousSubLayer = layerNodes.map((node) => node.id)
    }

    phaseExit.set(phase, previousSubLayer)
    previousPhaseExit = previousSubLayer
  }

  if (strategy.expand_plan) {
    const hasPlanPhase = nodes.some((node) => node.phase === "plan")
    for (const node of nodes) {
      if (hasPlanPhase && node.phase === "build") node.expandable = true
    }
  }

  return {
    strategy: strategy.id,
    maxParallel: strategy.max_parallel ?? 1,
    expandLimit: strategy.expand_limit ?? null,
    signals,
    nodes,
    layers,
  }
}

export function expandNode(graph, nodeId, subtasks, config) {
  const parent = graph.nodes.find((node) => node.id === nodeId)
  if (!parent) throw new Error(`CAAO: unknown node "${nodeId}"`)
  if (!parent.expandable) throw new Error(`CAAO: node "${nodeId}" is not expandable under strategy "${graph.strategy}"`)
  if (parent.status === "expanded") throw new Error(`CAAO: node "${nodeId}" is already expanded`)
  if (!Array.isArray(subtasks) || subtasks.length === 0) throw new Error(`CAAO: node "${nodeId}" needs at least one subtask`)
  if (graph.expandLimit && subtasks.length > graph.expandLimit) {
    throw new Error(`CAAO: strategy "${graph.strategy}" allows at most ${graph.expandLimit} workers, got ${subtasks.length}`)
  }

  const children = subtasks.map((subtask, index) => {
    const capabilityId = subtask.capability ?? parent.capability
    const id = `${nodeId}:${subtask.id ?? index + 1}`
    return makeNode(
      config,
      capabilityId,
      {
        id,
        title: subtask.title ?? `${capabilityId} unit ${index + 1}`,
        layer: parent.layer,
        parent: nodeId,
        inputs: subtask.inputs ?? [],
        scopeFiles: subtask.files ?? [],
        brief: subtask.description ?? subtask.title ?? "",
      },
      graph.signals,
    )
  })

  const localIds = new Map(subtasks.map((subtask, index) => [String(subtask.id ?? index + 1), children[index].id]))
  if (localIds.size !== subtasks.length || new Set(children.map((child) => child.id)).size !== children.length) {
    throw new Error(`CAAO: node "${nodeId}" has duplicate subtask ids`)
  }
  children.forEach((child, index) => {
    const declared = subtasks[index].depends_on ?? subtasks[index].dependsOn ?? []
    if (!Array.isArray(declared)) throw new Error(`CAAO: subtask "${child.id}" dependencies must be an array`)
    const unknown = declared.filter((ref) => !localIds.has(String(ref)))
    if (unknown.length > 0) throw new Error(`CAAO: subtask "${child.id}" depends on unknown subtask "${unknown[0]}"`)
    const internal = declared.map((ref) => localIds.get(String(ref)))
    if (internal.includes(child.id)) throw new Error(`CAAO: subtask "${child.id}" cannot depend on itself`)
    child.dependsOn = internal.length > 0 ? internal : [...parent.dependsOn]
  })

  // Reject cycles before mutating the parent or downstream graph.
  const childById = new Map(children.map((child) => [child.id, child]))
  const visiting = new Set()
  const visited = new Set()
  const visit = (id) => {
    if (visiting.has(id)) throw new Error(`CAAO: expanded subtasks contain a dependency cycle at "${id}"`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dep of childById.get(id)?.dependsOn ?? []) if (childById.has(dep)) visit(dep)
    visiting.delete(id)
    visited.add(id)
  }
  children.forEach((child) => visit(child.id))

  parent.status = "expanded"
  parent.expandedInto = children.map((child) => child.id)

  for (const node of graph.nodes) {
    if (!node.dependsOn.includes(nodeId)) continue
    node.dependsOn = node.dependsOn.filter((dep) => dep !== nodeId).concat(parent.expandedInto)
  }

  const insertAt = graph.nodes.indexOf(parent) + 1
  graph.nodes.splice(insertAt, 0, ...children)
  return children
}

export function readyNodes(graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const missing = graph.nodes.flatMap((node) => node.dependsOn.filter((dep) => !byId.has(dep)).map((dep) => `${node.id} -> ${dep}`))
  if (missing.length > 0) throw new Error(`CAAO: graph has unknown dependencies: ${missing.join(", ")}`)
  const available = Math.max(0, (graph.maxParallel ?? 1) - graph.nodes.filter((node) => node.status === "running").length)
  return graph.nodes
    .filter((node) => node.status === "pending")
    .filter((node) => node.dependsOn.every((dep) => TERMINAL.has(byId.get(dep).status)))
    .slice(0, available)
}

/**
 * Everything that consumed the output of a reopened node is stale. Nodes already
 * finished go back to pending; nodes still in flight are flagged so their result
 * is discarded on arrival instead of validating code that no longer exists.
 */
export function resetDownstream(graph, rootIds, reopenedBy) {
  const dependents = new Map()
  for (const node of graph.nodes) {
    for (const dep of node.dependsOn) {
      if (!dependents.has(dep)) dependents.set(dep, [])
      dependents.get(dep).push(node.id)
    }
  }

  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const seen = new Set(rootIds)
  const queue = [...rootIds]
  const affected = []

  while (queue.length > 0) {
    for (const childId of dependents.get(queue.shift()) ?? []) {
      if (seen.has(childId)) continue
      seen.add(childId)
      queue.push(childId)

      const child = byId.get(childId)
      if (!child) continue
      if (child.status === "done") {
        child.status = "pending"
        child.reopenedBy = reopenedBy
        affected.push(childId)
      } else if (child.status === "running") {
        child.stale = true
        child.reopenedBy = reopenedBy
        affected.push(childId)
      }
    }
  }

  return affected
}

/**
 * The waves a graph will actually execute in, ignoring the parallelism budget.
 * Wave count is the critical path; node count divided by it is the achievable
 * speed-up. Used by the recap to show whether the run was really parallel.
 */
export function waves(graph) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const depth = new Map()

  const depthOf = (id, guard = new Set()) => {
    if (depth.has(id)) return depth.get(id)
    if (guard.has(id)) throw new Error(`CAAO: graph contains a dependency cycle at "${id}"`)
    guard.add(id)
    const node = byId.get(id)
    if (!node) throw new Error(`CAAO: graph references unknown node "${id}"`)
    const value = node?.dependsOn.length ? Math.max(...node.dependsOn.map((dep) => depthOf(dep, guard) + 1)) : 0
    guard.delete(id)
    depth.set(id, value)
    return value
  }

  const grouped = []
  for (const node of graph.nodes) {
    if (node.status === "expanded") continue
    const level = depthOf(node.id)
    grouped[level] = grouped[level] ?? []
    grouped[level].push(node.id)
  }
  return grouped.filter(Boolean)
}

export function isComplete(graph) {
  return graph.nodes.every((node) => TERMINAL.has(node.status) || node.status === "failed")
}

export function toMermaid(graph) {
  const lines = ["flowchart TD"]
  const safe = (value) => String(value ?? "").replace(/["\r\n]/g, " ")
  const label = (node) => `${safe(node.id)}["${safe(node.title)}<br/>${safe(node.provider?.model)}"]`
  for (const node of graph.nodes) {
    if (node.status === "expanded") continue
    if (node.dependsOn.length === 0) lines.push(`  start((request)) --> ${label(node)}`)
    for (const dep of node.dependsOn) {
      const parent = graph.nodes.find((candidate) => candidate.id === dep)
      lines.push(`  ${parent ? label(parent) : dep} --> ${label(node)}`)
    }
  }
  return lines.join("\n")
}
