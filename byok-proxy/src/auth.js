// GitHub OAuth device flow.
//
// Serve una volta per utente, solo per sapere CHI è: l'utente autorizza l'app
// OAuth dell'organizzazione, il proxy legge il suo account GitHub (id, login) e
// gli consegna un'api key personale da incollare in Visual Studio come chiave
// del modello custom. Il token GitHub ottenuto viene usato solo per leggere
// l'identità e poi scartato: i modelli si chiamano con la credenziale Azure del
// servizio.

import { extractBearer } from "./http-helpers.js";

const USER_AGENT = "byok-proxy/0.1";

export class DeviceFlow {
  constructor(oauth, { fetchImpl = fetch } = {}) {
    this.oauth = oauth;
    this.fetch = fetchImpl;
  }

  _requireClientId() {
    if (!this.oauth.clientId) {
      throw new Error(
        "GITHUB_OAUTH_CLIENT_ID non configurato: il device flow non può partire. " +
          "Registra una OAuth App (device flow) nell'organizzazione e impostane il client id."
      );
    }
  }

  /** Avvia il flow: ritorna codice utente, URL di verifica, intervallo di polling. */
  async requestDeviceCode() {
    this._requireClientId();
    const res = await this.fetch(this.oauth.deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: this.oauth.clientId,
        scope: this.oauth.scopes,
      }),
    });
    if (!res.ok) throw new Error(`device code: HTTP ${res.status}`);
    const d = await res.json();
    return {
      deviceCode: d.device_code,
      userCode: d.user_code,
      verificationUri: d.verification_uri,
      interval: d.interval ?? 5,
      expiresIn: d.expires_in ?? 900,
    };
  }

  /**
   * Un singolo poll dello scambio token.
   * @returns {{status:"pending"} | {status:"slow_down", interval:number}
   *   | {status:"ok", accessToken:string, refreshToken?:string}
   *   | {status:"error", error:string}}
   */
  async pollToken(deviceCode) {
    const res = await this.fetch(this.oauth.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: this.oauth.clientId,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    // GitHub risponde 200 anche con gli errori "in corso"; leggi il body una volta.
    const text = await res.text();
    let d;
    try {
      d = JSON.parse(text);
    } catch {
      return { status: "error", error: `risposta non JSON: ${text.slice(0, 120)}` };
    }
    if (d.access_token) {
      return { status: "ok", accessToken: d.access_token, refreshToken: d.refresh_token };
    }
    if (d.error === "authorization_pending") return { status: "pending" };
    if (d.error === "slow_down") return { status: "slow_down", interval: d.interval ?? 5 };
    return { status: "error", error: d.error_description || d.error || "errore sconosciuto" };
  }

  /** Legge l'identità dell'utente dal token GitHub. */
  async fetchUser(accessToken) {
    const res = await this.fetch(this.oauth.userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    });
    if (!res.ok) throw new Error(`user info: HTTP ${res.status}`);
    const d = await res.json();
    return { githubId: d.id, login: d.login, name: d.name, email: d.email };
  }
}

/** Estrae l'api key da header Authorization o x-api-key / api-key. */
export function readApiKey(headers) {
  const bearer = extractBearer(headers.authorization || headers.Authorization);
  if (bearer) return bearer;
  return headers["x-api-key"] || headers["api-key"] || null;
}
