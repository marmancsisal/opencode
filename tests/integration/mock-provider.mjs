/**
 * Scripted OpenAI-compatible provider used by the end-to-end test.
 *
 * It plays three roles depending on the system prompt it receives:
 *   - Execution Manager: drives the CAAO tool loop
 *   - triage worker: returns the semantic verdict
 *   - capability worker: returns a result with a confidence score
 *
 * Every request is recorded so the test can assert the orchestration actually
 * happened inside opencode and not only inside the engine unit tests. Worker
 * replies are deliberately delayed so overlapping requests are observable: the
 * peak number of workers in flight is what proves opencode really runs
 * subagents concurrently.
 */

import { createServer } from "node:http"

const MODEL = "mock-1"
const WORKER_LATENCY_MS = 250

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function chunk(delta, finish = null) {
  return {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function textResponse(res, text) {
  sse(res, chunk({ role: "assistant" }))
  sse(res, chunk({ content: text }))
  sse(res, { ...chunk({}, "stop"), usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
  res.write("data: [DONE]\n\n")
  res.end()
}

/** Emits every call in a single assistant message — this is what a parallel dispatch looks like. */
function toolResponse(res, calls) {
  sse(res, chunk({ role: "assistant" }))
  sse(
    res,
    chunk({
      tool_calls: calls.map((call, index) => ({
        index,
        id: `call_${Math.random().toString(36).slice(2, 8)}`,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    }),
  )
  sse(res, { ...chunk({}, "tool_calls"), usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })
  res.write("data: [DONE]\n\n")
  res.end()
}

function parseTool(message) {
  const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

function lastToolOutput(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "tool") return parseTool(messages[i])
  }
  return null
}

function calledTools(messages) {
  return messages
    .filter((message) => message.role === "assistant" && message.tool_calls)
    .flatMap((message) => message.tool_calls.map((call) => call.function.name))
}

function countTools(messages, name) {
  return calledTools(messages).filter((tool) => tool === name).length
}

/** The most recent caao_next result that handed out work, and how far the loop got past it. */
function currentWave(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "tool") continue
    const parsed = parseTool(messages[i])
    if (!Array.isArray(parsed?.dispatch)) continue
    const after = messages.slice(i)
    return {
      dispatch: parsed.dispatch,
      complete: Boolean(parsed.complete),
      tasks: countTools(after, "task"),
      recorded: after
        .filter((message) => message.role === "assistant" && message.tool_calls)
        .flatMap((message) => message.tool_calls)
        .filter((call) => call.function.name === "caao_record")
        .map((call) => {
          try {
            return JSON.parse(call.function.arguments).nodeId
          } catch {
            return null
          }
        }),
    }
  }
  return null
}

function runIdFrom(messages) {
  for (const message of messages) {
    if (message.role !== "tool") continue
    const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content)
    const match = text.match(/"runId":\s*"([^"]+)"/)
    if (match) return match[1]
  }
  return null
}

export function startMockProvider(port = 21999, request = "Fix the failing unit tests in the billing module") {
  const calls = []
  const metrics = { peakWorkers: 0, dispatchedWaves: [] }
  let inFlight = 0

  const server = createServer((req, res) => {
    let body = ""
    req.on("data", (piece) => (body += piece))
    req.on("end", () => {
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }))
        return
      }

      const payload = body ? JSON.parse(body) : {}
      const messages = payload.messages ?? []
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n")

      const role = system.includes("disposable CAAO worker")
        ? system.match(/executing the \*\*(.+?)\*\* capability/)?.[1] ?? "worker"
        : system.includes("Execution Manager")
          ? "execution-manager"
          : "utility"

      calls.push({ role, tools: calledTools(messages) })
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })

      if (role !== "execution-manager") {
        inFlight += 1
        metrics.peakWorkers = Math.max(metrics.peakWorkers, inFlight)
        const reply =
          role === "Triage"
            ? JSON.stringify({
                intent: "debug",
                complexity: "medium",
                domains: ["payments", "tests"],
                rationale: "a defect in the billing module is making the unit tests fail",
                ambiguities: [],
                confidence: 0.9,
              })
            : `Handled the ${role} work for the billing module.\n\nCONFIDENCE: 0.93`
        setTimeout(() => {
          inFlight -= 1
          textResponse(res, reply)
        }, WORKER_LATENCY_MS)
        return
      }

      const used = calledTools(messages)
      const last = lastToolOutput(messages)

      if (!used.includes("caao_triage")) return toolResponse(res, [{ name: "caao_triage", args: { request } }])
      if (countTools(messages, "task") === 0) {
        return toolResponse(res, [
          { name: "task", args: { description: "triage", subagent_type: last?.agent ?? "caao-triage", prompt: last?.prompt ?? "" } },
        ])
      }
      if (!used.includes("caao_plan")) {
        const verdict = typeof last?.raw === "string" ? last.raw : JSON.stringify(last ?? {})
        return toolResponse(res, [{ name: "caao_plan", args: { request, triage: verdict } }])
      }

      const runId = runIdFrom(messages)
      const wave = currentWave(messages)

      if (!wave) return toolResponse(res, [{ name: "caao_next", args: { runId } }])

      // Dispatch the whole wave in one message — this is the parallelism under test.
      if (wave.dispatch.length > 0 && wave.tasks === 0) {
        metrics.dispatchedWaves.push(wave.dispatch.length)
        return toolResponse(
          res,
          wave.dispatch.map((node) => ({
            name: "task",
            args: { description: node.capability, subagent_type: node.agent, prompt: node.prompt },
          })),
        )
      }

      const unrecorded = wave.dispatch.filter((node) => !wave.recorded.includes(node.nodeId))
      if (unrecorded.length > 0) {
        return toolResponse(
          res,
          unrecorded.map((node) => ({
            name: "caao_record",
            args: {
              runId,
              nodeId: node.nodeId,
              status: "ok",
              confidence: 0.93,
              summary: `${node.capability} completed`,
              files: node.capability === "implementation" ? ["src/billing/invoice.ts"] : [],
              verdict: "pass",
            },
          })),
        )
      }

      if (wave.dispatch.length > 0 && !wave.complete) return toolResponse(res, [{ name: "caao_next", args: { runId } }])
      if (!used.includes("caao_merge")) return toolResponse(res, [{ name: "caao_merge", args: { runId } }])
      if (!used.includes("caao_report")) return toolResponse(res, [{ name: "caao_report", args: { runId } }])

      return textResponse(res, "CAAO_E2E_OK — the billing defect was fixed, tested and reviewed.")
    })
  })

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({ server, calls, metrics, port, close: () => new Promise((done) => server.close(done)) }),
    )
  })
}
