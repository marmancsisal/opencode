// Provider: inoltra la chat al servizio di modelli.
//
// Due tipi:
//  - "azure-foundry"      Azure AI Foundry / Azure OpenAI, API v1
//                         (`<endpoint>/openai/v1/chat/completions`, niente api-version).
//                         Il campo `model` del body è il NOME DEL DEPLOYMENT: ogni modello
//                         pubblico in config può puntare a un deployment diverso.
//                         Auth: chiave API, Entra ID o Managed Identity (azure-credential.js).
//  - "openai-compatible"  qualsiasi endpoint OpenAI-compatibile con chiave Bearer
//                         (OpenAI, gateway interni, vLLM, ...).
//
// L'identità dell'utente la gestisce il proxy (api key personale -> cliente): verso
// il provider si usa una credenziale di servizio. Limiti e metriche per utente sono
// applicati prima di arrivare qui.

import { createCredential } from "./azure-credential.js";

/** Header della risposta upstream utili al client (es. per gestire il 429). */
const PASS_HEADERS = ["retry-after", "retry-after-ms", "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens"];

export function chatCompletionsUrl(p) {
  if (p.type === "openai-compatible") return p.baseUrl;
  // Accetta l'endpoint della risorsa con o senza /openai/v1 finale.
  const base = p.endpoint.replace(/\/+$/, "").replace(/\/openai\/v1$/, "");
  return `${base}/openai/v1/chat/completions`;
}

export class ModelProvider {
  /**
   * @param {object} cfg config normalizzata
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {object} [opts.credential] credenziale già costruita (test)
   * @param {object} [opts.env] variabili d'ambiente (test)
   */
  constructor(cfg, { fetchImpl = fetch, credential, env = process.env } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.url = chatCompletionsUrl(cfg.provider);
    if (!/^https:\/\//i.test(this.url) && !cfg.provider.allowHttp) {
      throw new Error(`L'endpoint del provider deve essere https: ${this.url}`);
    }
    this.credential = credential ?? createCredential(cfg.provider, env, { fetchImpl });
    /** id pubblico del modello -> deployment */
    this.deployments = new Map(cfg.models.map((m) => [m.id, m.deployment ?? m.id]));
  }

  deploymentFor(model) {
    return this.deployments.get(model) ?? model;
  }

  /** Corpo della richiesta: modello -> deployment, usage richiesto in streaming. */
  buildBody(model, clientBody, stream) {
    const src = clientBody && typeof clientBody === "object" ? clientBody : {};
    const body = { ...src, model: this.deploymentFor(model), stream };
    if (stream) {
      body.stream_options = { ...(src.stream_options ?? {}), include_usage: true };
    } else {
      delete body.stream_options; // non ammesso senza stream
    }
    return body;
  }

  /**
   * Invia la richiesta e restituisce la Response web dell'upstream: il server
   * decide se farne passthrough (stream) o materializzarla.
   * @returns {Promise<{response: Response}>}
   */
  async dispatch({ model, body, stream, signal }) {
    const auth = await this.credential.headers();
    const timeout = AbortSignal.timeout(this.cfg.provider.timeoutMs);
    const response = await this.fetch(this.url, {
      method: "POST",
      headers: {
        ...auth,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
        "User-Agent": "byok-proxy/0.3",
      },
      body: JSON.stringify(this.buildBody(model, body, stream)),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    return { response };
  }

  /** Verifica all'avvio che la credenziale funzioni (per Entra/MSI ottiene un token). */
  async check() {
    await this.credential.headers();
  }
}

/** Header da riportare al client dalla risposta upstream. */
export function passthroughHeaders(response) {
  const out = {};
  for (const h of PASS_HEADERS) {
    const v = response.headers.get(h);
    if (v != null) out[h] = v;
  }
  return out;
}

/** Estrae total_tokens da un corpo di risposta non-streaming. */
export function usageFromJson(obj) {
  const u = obj?.usage;
  if (!u) return 0;
  if (Number.isFinite(u.total_tokens)) return u.total_tokens;
  const p = Number(u.prompt_tokens) || 0;
  const c = Number(u.completion_tokens) || 0;
  return p + c;
}

/**
 * Estrae total_tokens da un buffer di stream SSE OpenAI. L'uso, richiesto con
 * include_usage, arriva in uno degli ultimi eventi `data:` come { usage: {...} }.
 */
export function usageFromSse(sseText) {
  let total = 0;
  for (const line of sseText.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      const u = usageFromJson(obj);
      if (u) total = u; // l'ultimo con usage vince
    } catch {
      // chunk parziale o non-JSON: ignora
    }
  }
  return total;
}
