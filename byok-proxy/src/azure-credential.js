// Credenziali per Azure AI Foundry, senza SDK.
//
// Tre modalità:
//  - "key"               chiave API della risorsa, inviata nell'header `api-key`;
//  - "entra"             service principal (client credentials) su Microsoft Entra ID:
//                        AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET;
//  - "managed-identity"  identità gestita: endpoint locale di Azure Container Apps /
//                        App Service (IDENTITY_ENDPOINT + IDENTITY_HEADER) oppure IMDS
//                        delle VM/AKS. AZURE_CLIENT_ID opzionale (identità user-assigned).
//
// I token Entra durano circa un'ora: li teniamo in cache e li rinnoviamo 5 minuti
// prima della scadenza. Richieste concorrenti condividono lo stesso rinnovo
// (single-flight), così un picco di traffico non genera un picco di richieste a Entra.

const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_SCOPE = "https://ai.azure.com/.default";
const IMDS_URL = "http://169.254.169.254/metadata/identity/oauth2/token";

function scopeToResource(scope) {
  return scope.replace(/\/\.default$/, "");
}

/** Base comune: cache del token + single-flight. */
class CachedTokenCredential {
  constructor({ fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.token = null; // { value, expiresAt }
    this.inflight = null;
  }

  /** Header di autorizzazione per la richiesta al modello. */
  async headers() {
    return { Authorization: `Bearer ${await this.getToken()}` };
  }

  async getToken() {
    if (this.token && this.token.expiresAt - this.now() > REFRESH_MARGIN_MS) return this.token.value;
    if (!this.inflight) {
      this.inflight = this._fetchToken()
        .then((t) => {
          this.token = t;
          return t.value;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  async _json(res, what) {
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!res.ok || !data?.access_token) {
      // Niente body nel messaggio: potrebbe contenere dettagli sensibili.
      const code = data?.error ? ` (${data.error})` : "";
      throw Object.assign(new Error(`${what}: impossibile ottenere il token Azure, HTTP ${res.status}${code}`), {
        status: 502,
      });
    }
    return data;
  }
}

/** Service principal: client credentials su Entra ID. */
export class ClientSecretCredential extends CachedTokenCredential {
  constructor({ tenantId, clientId, clientSecret, scope = DEFAULT_SCOPE, authorityHost = "https://login.microsoftonline.com", ...rest }) {
    super(rest);
    if (!tenantId || !clientId || !clientSecret) {
      throw new Error("Auth Entra: servono AZURE_TENANT_ID, AZURE_CLIENT_ID e AZURE_CLIENT_SECRET");
    }
    this.url = `${authorityHost.replace(/\/+$/, "")}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    this.body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    }).toString();
  }

  async _fetchToken() {
    const res = await this.fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: this.body,
      signal: AbortSignal.timeout(15_000),
    });
    const d = await this._json(res, "Entra ID");
    return { value: d.access_token, expiresAt: this.now() + Number(d.expires_in ?? 3600) * 1000 };
  }
}

/** Identità gestita: Container Apps / App Service, oppure IMDS. */
export class ManagedIdentityCredential extends CachedTokenCredential {
  constructor({ clientId = null, scope = DEFAULT_SCOPE, identityEndpoint = null, identityHeader = null, imdsUrl = IMDS_URL, ...rest } = {}) {
    super(rest);
    this.clientId = clientId;
    this.resource = scopeToResource(scope);
    this.identityEndpoint = identityEndpoint;
    this.identityHeader = identityHeader;
    this.imdsUrl = imdsUrl;
  }

  async _fetchToken() {
    let url;
    let headers;
    if (this.identityEndpoint && this.identityHeader) {
      // Azure Container Apps / App Service
      url = new URL(this.identityEndpoint);
      url.searchParams.set("api-version", "2019-08-01");
      url.searchParams.set("resource", this.resource);
      if (this.clientId) url.searchParams.set("client_id", this.clientId);
      headers = { "X-IDENTITY-HEADER": this.identityHeader };
    } else {
      // VM, VMSS, AKS (IMDS)
      url = new URL(this.imdsUrl);
      url.searchParams.set("api-version", "2018-02-01");
      url.searchParams.set("resource", this.resource);
      if (this.clientId) url.searchParams.set("client_id", this.clientId);
      headers = { Metadata: "true" };
    }
    const res = await this.fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    const d = await this._json(res, "Managed Identity");
    // expires_on: secondi epoch (stringa o numero); expires_in come ripiego.
    const expiresAt = d.expires_on
      ? Number(d.expires_on) * 1000
      : this.now() + Number(d.expires_in ?? 3600) * 1000;
    return { value: d.access_token, expiresAt };
  }
}

/** Chiave API statica. */
export class ApiKeyCredential {
  constructor(key, header = "api-key") {
    if (!key) throw new Error("Auth key: chiave API mancante");
    this.key = key;
    this.header = header;
  }

  async headers() {
    return this.header === "authorization" ? { Authorization: `Bearer ${this.key}` } : { [this.header]: this.key };
  }
}

/**
 * Crea la credenziale giusta dalla config del provider + variabili d'ambiente.
 * @param {object} p config.provider normalizzata
 * @param {object} [env] (iniettabile nei test)
 */
export function createCredential(p, env = process.env, deps = {}) {
  const scope = p.scope || DEFAULT_SCOPE;
  switch (p.auth) {
    case "key":
      return new ApiKeyCredential(env[p.apiKeyEnv], p.type === "openai-compatible" ? "authorization" : "api-key");
    case "entra":
      return new ClientSecretCredential({
        tenantId: env.AZURE_TENANT_ID,
        clientId: env.AZURE_CLIENT_ID,
        clientSecret: env.AZURE_CLIENT_SECRET,
        authorityHost: env.AZURE_AUTHORITY_HOST || "https://login.microsoftonline.com",
        scope,
        ...deps,
      });
    case "managed-identity":
      return new ManagedIdentityCredential({
        clientId: env.AZURE_CLIENT_ID || null,
        identityEndpoint: env.IDENTITY_ENDPOINT || null,
        identityHeader: env.IDENTITY_HEADER || null,
        imdsUrl: env.AZURE_IMDS_URL || IMDS_URL,
        scope,
        ...deps,
      });
    default:
      throw new Error(`provider.auth non valido: "${p.auth}" (usa key, entra o managed-identity)`);
  }
}
