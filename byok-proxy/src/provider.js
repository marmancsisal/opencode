// Provider: chiamata ai modelli autenticata *come l'utente*.
//
// Questa è la logica estratta e adattata da OmniRoute (executors/github.ts):
// dall'utente si ricava la credenziale, si costruiscono gli header di
// autorizzazione, si invia il corpo in forma OpenAI e si gestisce lo streaming
// (passthrough) o la risposta intera (materializzata) distinguendo i due casi.
//
// Differenza deliberata rispetto a OmniRoute: la destinazione è l'API UFFICIALE
// GitHub Models (models.github.ai), con il token GitHub dell'utente. NON viene
// replicato il minting del token interno di Copilot né la mimica del client
// Copilot per attingere ai crediti del piano: quella parte è fuori dallo scopo.
//
// Il livello credenziali è però pluggable (needsRefresh/refreshCredentials): chi
// volesse collegare un altro backend con token a scadenza breve può farlo senza
// toccare il resto.

const DEFAULT_HEADERS_MARGIN_MS = 5 * 60 * 1000;

export class ModelProvider {
  /**
   * @param {object} cfg config normalizzata
   * @param {object} opts
   * @param {typeof fetch} [opts.fetchImpl]
   * @param {(user:object)=>({token:string, expiresAt?:number}|null)} [opts.getCredential]
   *        risolutore credenziale (default: token GitHub statico dell'utente)
   * @param {(cred:object, user:object)=>Promise<object|null>} [opts.refreshCredentials]
   */
  constructor(cfg, { fetchImpl = fetch, getCredential, refreshCredentials } = {}) {
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.baseUrl = cfg.provider.baseUrl;
    if (!/^https:\/\//i.test(this.baseUrl)) {
      throw new Error(`provider.baseUrl deve essere https: ${this.baseUrl}`);
    }
    this.getCredential =
      getCredential ??
      ((user) => (user.githubToken ? { token: user.githubToken } : null));
    this.refreshCredentials = refreshCredentials ?? null;
  }

  /** La credenziale va rinfrescata? (hook; di default no, token GitHub lungo). */
  needsRefresh(cred) {
    if (!cred) return true;
    if (cred.expiresAt) {
      const ms = typeof cred.expiresAt === "string" ? Date.parse(cred.expiresAt) : cred.expiresAt;
      if (Number.isFinite(ms) && ms - Date.now() < DEFAULT_HEADERS_MARGIN_MS) return true;
    }
    return false;
  }

  async resolveCredential(user) {
    let cred = this.getCredential(user);
    if (this.refreshCredentials && this.needsRefresh(cred)) {
      const refreshed = await this.refreshCredentials(cred, user);
      if (refreshed) cred = refreshed;
    }
    return cred;
  }

  /**
   * Header di richiesta verso il modello. L'identità è il token dell'utente.
   * x-initiator viene inoltrato quando il client lo manda (user/agent): utile
   * per backend che fatturano diversamente i turni autonomi. (Estratto da
   * OmniRoute: resolveInitiatorHeader.)
   */
  buildHeaders(token, stream, clientHeaders = {}) {
    const initiator = resolveInitiator(clientHeaders);
    return {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      "User-Agent": "byok-proxy/0.1",
      "X-Initiator": initiator,
    };
  }

  /** Costruisce il corpo in forma OpenAI con il modello risolto. */
  buildBody(resolvedModel, clientBody, stream) {
    const src = clientBody && typeof clientBody === "object" ? clientBody : {};
    const body = { ...src, model: resolvedModel, stream };
    if (stream) {
      // Chiede l'uso dei token nel chunk finale, così i contatori restano precisi.
      body.stream_options = { ...(src.stream_options ?? {}), include_usage: true };
    }
    return body;
  }

  /**
   * Invia la richiesta. Ritorna la Response web dell'upstream (per lo
   * streaming) più il modello risolto; il server decide come consegnarla.
   *
   * @returns {Promise<{response:Response}>}
   */
  async dispatch({ user, model, body, stream, clientHeaders, signal }) {
    const cred = await this.resolveCredential(user);
    if (!cred?.token) {
      const err = new Error(
        "Utente senza token GitHub: deve autenticarsi (apri /login) prima di usare i modelli."
      );
      err.status = 401;
      throw err;
    }
    const headers = this.buildHeaders(cred.token, stream, clientHeaders);
    const payload = this.buildBody(model, body, stream);

    const timeout = AbortSignal.timeout(this.cfg.provider.timeoutMs);
    const reqSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const response = await this.fetch(this.baseUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: reqSignal,
    });
    return { response };
  }
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
 * Estrae total_tokens da un buffer di stream SSE OpenAI. L'uso, se richiesto con
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

function resolveInitiator(clientHeaders) {
  let v = clientHeaders?.["x-initiator"] ?? clientHeaders?.["X-Initiator"];
  if (!v && clientHeaders) {
    for (const k in clientHeaders) {
      if (k.toLowerCase() === "x-initiator") {
        v = clientHeaders[k];
        break;
      }
    }
  }
  return v === "agent" || v === "user" ? v : "user";
}
