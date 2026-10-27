// Server HTTP: espone un endpoint OpenAI-compatibile da usare in Visual Studio /
// VS Code come "modello custom" (Bring Your Own Key).
//
// Flusso di una chat:
//   api key -> utente -> modello (richiesto o random tra i consentiti)
//   -> controllo limiti -> chiamata al modello come utente -> risposta
//   (streaming passthrough) -> conteggio token.

import { createServer } from "node:http";
import crypto from "node:crypto";
import { readJson, sendJson, sendError } from "./http-helpers.js";
import { readApiKey } from "./auth.js";
import { resolveModel, allowedModelsForUser } from "./models.js";
import { usageFromJson, usageFromSse } from "./provider.js";

const SSE_TAIL_LIMIT = 64 * 1024; // basta la coda per trovare l'evento usage
const LOGIN_SESSION_TTL_MS = 15 * 60 * 1000; // come la scadenza del device code GitHub

/**
 * Crea il request handler. Dipendenze iniettate per facilitare i test.
 */
export function createApp({ cfg, store, limiter, provider, deviceFlow, deviceSessions = new Map() }) {
  const defaultGroups = cfg.oauth.defaultGroups ?? [];

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && path === "/healthz") {
        return sendJson(res, 200, { status: "ok", provider: cfg.provider.name });
      }
      if (req.method === "GET" && path === "/login") {
        return sendLoginPage(res);
      }
      if (req.method === "POST" && path === "/login/start") {
        return await handleLoginStart(req, res, { deviceFlow, deviceSessions });
      }
      if (req.method === "POST" && path === "/login/poll") {
        return await handleLoginPoll(req, res, { deviceFlow, deviceSessions, store, defaultGroups });
      }

      // Da qui in poi serve l'autenticazione via api key.
      const apiKey = readApiKey(req.headers);
      const user = store.resolveByApiKey(apiKey);
      if (!user) {
        return sendError(res, 401, "API key assente o non valida. Apri /login per ottenerne una.", {
          type: "authentication_error",
        });
      }

      if (req.method === "GET" && path === "/v1/models") {
        return handleListModels(res, { cfg, user });
      }
      if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
        return await handleChat(req, res, { cfg, user, limiter, provider });
      }

      return sendError(res, 404, `Rotta non trovata: ${req.method} ${path}`, { type: "not_found" });
    } catch (e) {
      const status = e.status ?? 500;
      return sendError(res, status, e.message ?? "Errore interno", { type: "proxy_error" });
    }
  };
}

function handleListModels(res, { cfg, user }) {
  const allowed = allowedModelsForUser(cfg, user);
  const data = allowed.map((id) => ({ id, object: "model", owned_by: cfg.provider.name }));
  // Esponiamo anche "auto": il client può selezionarlo per farci scegliere a caso.
  data.unshift({ id: "auto", object: "model", owned_by: cfg.provider.name });
  return sendJson(res, 200, { object: "list", data });
}

async function handleChat(req, res, { cfg, user, limiter, provider }) {
  const body = await readJson(req);
  const requested = body.model ?? cfg.defaultModel;
  const stream = body.stream === true;

  const resolved = resolveModel(cfg, user, requested);
  if (!resolved.ok) {
    return sendError(res, resolved.status, resolved.message, { type: "model_error" });
  }
  const model = resolved.model;

  // Senza credenziale non si chiama nulla: rispondi prima di consumare quota.
  if (!provider.getCredential(user)?.token && !provider.refreshCredentials) {
    return sendError(res, 401, "Utente senza token GitHub: deve autenticarsi (apri /login) prima di usare i modelli.", {
      type: "authentication_error",
    });
  }

  const gate = limiter.tryConsume(cfg, user, model);
  if (!gate.ok) {
    return sendError(res, 429, gate.message, {
      type: "rate_limit_exceeded",
      headers: { "Retry-After": String(gate.retryAfterSec) },
    });
  }

  // Abort propagato se il client chiude la connessione.
  const ac = new AbortController();
  res.on("close", () => ac.abort());

  let upstream;
  try {
    upstream = await provider.dispatch({
      user,
      model,
      body,
      stream,
      clientHeaders: req.headers,
      signal: ac.signal,
    });
  } catch (e) {
    const status = e.status ?? 502;
    return sendError(res, status, e.message ?? "Errore upstream", { type: "upstream_error" });
  }

  const response = upstream.response;

  // Errore upstream: rilancia status e body così il client vede l'errore reale.
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    res.writeHead(response.status, {
      "Content-Type": response.headers.get("content-type") || "application/json",
      "X-Selected-Model": model,
    });
    return res.end(text);
  }

  if (stream) {
    return await pumpStream(res, response, { cfg, user, model, limiter });
  }

  // Non streaming: materializza, conta i token, rilancia.
  const json = await response.json().catch(() => ({}));
  limiter.addTokens(cfg, user, model, usageFromJson(json));
  return sendJson(res, 200, json, { "X-Selected-Model": model });
}

/** Passthrough dello stream SSE, con conteggio token dalla coda. */
async function pumpStream(res, response, { cfg, user, model, limiter }) {
  res.writeHead(200, {
    "Content-Type": response.headers.get("content-type") || "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Selected-Model": model,
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      tail += decoder.decode(value, { stream: true });
      if (tail.length > SSE_TAIL_LIMIT) tail = tail.slice(-SSE_TAIL_LIMIT);
    }
  } finally {
    res.end();
  }
  limiter.addTokens(cfg, user, model, usageFromSse(tail));
}

async function handleLoginStart(req, res, { deviceFlow, deviceSessions }) {
  const d = await deviceFlow.requestDeviceCode();
  // Pulizia pigra delle sessioni scadute, così la mappa non cresce senza limite.
  const now = Date.now();
  for (const [h, s] of deviceSessions) {
    if (now - s.createdAt > LOGIN_SESSION_TTL_MS) deviceSessions.delete(h);
  }
  // Non esponiamo il device_code grezzo: diamo un handle opaco da ripassare al poll.
  const handle = `dev_${crypto.randomBytes(16).toString("hex")}`;
  deviceSessions.set(handle, { deviceCode: d.deviceCode, createdAt: now });
  return sendJson(res, 200, {
    handle,
    userCode: d.userCode,
    verificationUri: d.verificationUri,
    interval: d.interval,
    expiresIn: d.expiresIn,
    instructions: `Apri ${d.verificationUri} e inserisci il codice ${d.userCode}, poi richiama /login/poll.`,
  });
}

async function handleLoginPoll(req, res, { deviceFlow, deviceSessions, store, defaultGroups }) {
  const { handle } = await readJson(req);
  const session = handle && deviceSessions.get(handle);
  if (!session || Date.now() - session.createdAt > LOGIN_SESSION_TTL_MS) {
    if (session) deviceSessions.delete(handle);
    return sendError(res, 400, "handle di login sconosciuto o scaduto", { type: "login_error" });
  }
  const result = await deviceFlow.pollToken(session.deviceCode);
  if (result.status === "pending") return sendJson(res, 200, { status: "pending" });
  if (result.status === "slow_down") return sendJson(res, 200, { status: "pending", interval: result.interval });
  if (result.status !== "ok") {
    deviceSessions.delete(handle);
    return sendError(res, 400, `login fallito: ${result.error}`, { type: "login_error" });
  }

  const ghUser = await deviceFlow.fetchUser(result.accessToken);
  const { apiKey, user } = store.upsertDeviceUser({
    githubId: ghUser.githubId,
    login: ghUser.login,
    githubToken: result.accessToken,
    groups: defaultGroups,
  });
  deviceSessions.delete(handle);
  return sendJson(res, 200, {
    status: "ok",
    apiKey,
    login: user.login,
    message: "Incolla questa API key in Visual Studio come chiave del modello custom.",
  });
}

function sendLoginPage(res) {
  const html = `<!doctype html><html lang="it"><meta charset="utf-8">
<title>Login BYOK proxy</title>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;line-height:1.5">
<h1>Accesso al proxy</h1>
<p>Clicca "Avvia" per ottenere un codice GitHub, autorizzalo, poi ricevi la tua API key.</p>
<button id="go">Avvia</button>
<pre id="out"></pre>
<script>
const out = document.getElementById('out');
document.getElementById('go').onclick = async () => {
  const s = await (await fetch('/login/start', {method:'POST'})).json();
  out.textContent = s.instructions;
  const poll = setInterval(async () => {
    const r = await (await fetch('/login/poll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:s.handle})})).json();
    if (r.status === 'ok') { clearInterval(poll); out.textContent = 'API key: ' + r.apiKey; }
  }, (s.interval||5)*1000);
};
</script></body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/** Avvia un server http reale con l'app data. */
export function startServer(app, { host, port }) {
  const server = createServer(app);
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}
