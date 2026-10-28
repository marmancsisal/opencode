// Finto Azure AI Foundry + Entra ID + Managed Identity + GitHub OAuth, in HTTPS.
// Serve ai test end-to-end del container (scripts/e2e-docker.sh): il proxy gira
// nell'immagine reale e parla con questo server come parlerebbe con Azure.
//
//   node tests/e2e/mock-azure.mjs <porta> <cert.pem> <key.pem>
//
// Variabili: MOCK_API_KEY, MOCK_DEPLOYMENTS (csv), MOCK_CLIENT_ID, MOCK_CLIENT_SECRET,
// MOCK_IDENTITY_HEADER. GET /__state restituisce chiamate e contatori; POST /__reset li azzera.

import { createServer } from "node:https";
import { readFileSync } from "node:fs";

const [port, certPath, keyPath] = process.argv.slice(2);
const API_KEY = process.env.MOCK_API_KEY || "mock-azure-key";
const DEPLOYMENTS = new Set((process.env.MOCK_DEPLOYMENTS || "mini-prod,full-prod,throttled").split(","));
const CLIENT_ID = process.env.MOCK_CLIENT_ID || "e2e-client";
const CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET || "e2e-secret";
const IDENTITY_HEADER = process.env.MOCK_IDENTITY_HEADER || "e2e-identity-header";

let state;
const reset = () => {
  state = { chats: [], entraTokens: 0, msiTokens: 0, githubDevice: 0, issued: new Set(), polls: 0 };
};
reset();

const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
};
const body = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

const server = createServer({ cert: readFileSync(certPath), key: readFileSync(keyPath) }, async (req, res) => {
  const url = new URL(req.url, "https://mock");
  const raw = await body(req);

  // ---- stato per le verifiche ----
  if (url.pathname === "/__state") {
    return json(res, 200, { ...state, issued: state.issued.size });
  }
  if (url.pathname === "/__reset") {
    reset();
    return json(res, 200, { ok: true });
  }

  // ---- Entra ID: client credentials ----
  const tokenPath = /^\/([^/]+)\/oauth2\/v2\.0\/token$/.exec(url.pathname);
  if (req.method === "POST" && tokenPath) {
    const f = new URLSearchParams(raw);
    if (f.get("grant_type") !== "client_credentials" || f.get("client_id") !== CLIENT_ID || f.get("client_secret") !== CLIENT_SECRET) {
      return json(res, 401, { error: "invalid_client", error_description: "credenziali errate" });
    }
    if (f.get("scope") !== "https://ai.azure.com/.default") return json(res, 400, { error: "invalid_scope" });
    state.entraTokens++;
    const t = `entra-${tokenPath[1]}-${state.entraTokens}`;
    state.issued.add(t);
    return json(res, 200, { token_type: "Bearer", expires_in: 3599, access_token: t });
  }

  // ---- Managed Identity (Container Apps / App Service) ----
  if (req.method === "GET" && url.pathname === "/msi/token") {
    if (req.headers["x-identity-header"] !== IDENTITY_HEADER) return json(res, 401, { error: "bad identity header" });
    if (url.searchParams.get("api-version") !== "2019-08-01" || url.searchParams.get("resource") !== "https://ai.azure.com") {
      return json(res, 400, { error: "bad request" });
    }
    state.msiTokens++;
    const t = `msi-${state.msiTokens}`;
    state.issued.add(t);
    return json(res, 200, { access_token: t, expires_on: String(Math.floor(Date.now() / 1000) + 3600), token_type: "Bearer" });
  }

  // ---- GitHub OAuth device flow ----
  if (req.method === "POST" && url.pathname === "/login/device/code") {
    state.githubDevice++;
    return json(res, 200, { device_code: "dc-e2e", user_code: "E2E0-0001", verification_uri: "https://github.com/login/device", interval: 1, expires_in: 900 });
  }
  if (req.method === "POST" && url.pathname === "/login/oauth/access_token") {
    state.polls++;
    return json(res, 200, state.polls === 1 ? { error: "authorization_pending" } : { access_token: "gho_e2e_user", token_type: "bearer" });
  }
  if (req.method === "GET" && url.pathname === "/user") {
    if (req.headers.authorization !== "Bearer gho_e2e_user") return json(res, 401, { message: "Bad credentials" });
    return json(res, 200, { id: 4242, login: "carla-dev", name: "Carla" });
  }

  // ---- Azure AI Foundry v1: chat completions ----
  if (req.method === "POST" && url.pathname === "/openai/v1/chat/completions") {
    if (url.searchParams.has("api-version")) return json(res, 400, { error: { code: "BadRequest", message: "v1 senza api-version" } });
    let auth = null;
    if (req.headers["api-key"]) auth = req.headers["api-key"] === API_KEY ? "api-key" : null;
    else if (req.headers.authorization?.startsWith("Bearer ")) {
      auth = state.issued.has(req.headers.authorization.slice(7)) ? "bearer" : null;
    }
    if (!auth) return json(res, 401, { error: { code: "401", message: "Access denied due to invalid subscription key or wrong API endpoint." } });

    const b = JSON.parse(raw || "{}");
    state.chats.push({ auth, model: b.model, stream: !!b.stream, includeUsage: !!b.stream_options?.include_usage, hasStreamOptions: "stream_options" in b });
    if (!DEPLOYMENTS.has(b.model)) {
      return json(res, 404, { error: { code: "DeploymentNotFound", message: `The API deployment ${b.model} does not exist.` } });
    }
    if (b.model === "throttled") {
      return json(res, 429, { error: { code: "429", message: "Requests have exceeded the token rate limit." } }, { "retry-after": "3" });
    }
    const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 };
    if (b.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      for (const piece of ["Ciao", " da", " Azure"]) {
        chunk({ id: "c1", object: "chat.completion.chunk", model: b.model, choices: [{ index: 0, delta: { content: piece } }] });
      }
      chunk({ id: "c1", object: "chat.completion.chunk", model: b.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      if (b.stream_options?.include_usage) chunk({ id: "c1", object: "chat.completion.chunk", model: b.model, choices: [], usage });
      res.end("data: [DONE]\n\n");
      return;
    }
    return json(res, 200, {
      id: "c1",
      object: "chat.completion",
      model: b.model,
      choices: [{ index: 0, message: { role: "assistant", content: "Ciao da Azure" }, finish_reason: "stop" }],
      usage,
    });
  }

  json(res, 404, { error: "not found", path: url.pathname });
});

server.listen(Number(port), "127.0.0.1", () => console.log(`mock-azure in ascolto su https://127.0.0.1:${port}`));
