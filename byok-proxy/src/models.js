// Catalogo modelli, filtro per utente e selezione casuale.
//
// L'utente chiede "quale modello?" e, se non lo specifica (o chiede
// "auto"/"random"), il proxy ne sceglie uno a caso tra quelli a cui l'utente
// ha diritto in base alle regole di accesso.

import crypto from "node:crypto";

const RANDOM_ALIASES = new Set(["auto", "random", "", null, undefined]);

/** Un intero uniforme in [0, n) senza bias di modulo. */
function secureRandomInt(n) {
  if (n <= 0) throw new Error("n deve essere > 0");
  if (n === 1) return 0;
  const limit = Math.floor(0xffffffff / n) * n;
  let x;
  do {
    x = crypto.randomBytes(4).readUInt32BE(0);
  } while (x >= limit);
  return x % n;
}

/** True se il modello richiesto significa "scegli tu" (random). */
export function isRandomRequest(modelId) {
  return RANDOM_ALIASES.has(modelId) || (typeof modelId === "string" && modelId.toLowerCase() === "auto");
}

/**
 * Insieme dei modelli consentiti a un utente.
 *
 * Partenza: intero catalogo. Poi si applicano le regole che corrispondono
 * all'utente (per id o gruppo):
 *  - access:"deny" rimuove i modelli elencati (o tutti, se match.models è vuoto);
 *  - access:"allow" è una whitelist: se esiste almeno una allow-rule che
 *    corrisponde all'utente, l'utente resta limitato all'unione dei modelli
 *    permessi da quelle regole (poi si applicano comunque i deny).
 *
 * Così si coprono: limite per modello, per modello su utenti specifici, per
 * modello su gruppi specifici.
 */
export function allowedModelsForUser(cfg, user) {
  const catalog = cfg.models.map((m) => m.id);
  const matchesUser = (rule) => ruleMatchesUser(rule, user);

  const denied = new Set();
  let whitelist = null; // null => nessuna whitelist attiva

  for (const rule of cfg.rules) {
    if (!rule.access || !matchesUser(rule)) continue;
    const scoped = rule.match.models.length ? rule.match.models : catalog;
    if (rule.access === "deny") {
      for (const m of scoped) denied.add(m);
    } else if (rule.access === "allow") {
      if (!whitelist) whitelist = new Set();
      for (const m of scoped) whitelist.add(m);
    }
  }

  let allowed = catalog.filter((m) => !denied.has(m));
  if (whitelist) allowed = allowed.filter((m) => whitelist.has(m));
  return allowed;
}

/** Una regola corrisponde a un utente se le dimensioni user/group combaciano. */
export function ruleMatchesUser(rule, user) {
  const { users, groups } = rule.match;
  if (users.length && !users.includes(user.id)) return false;
  if (groups.length && !groups.some((g) => user.groups.includes(g))) return false;
  return true;
}

/**
 * Risolve il modello effettivo per una richiesta.
 * @returns {{ ok:true, model:string, random:boolean } | { ok:false, status:number, message:string }}
 */
export function resolveModel(cfg, user, requestedModel) {
  const allowed = allowedModelsForUser(cfg, user);
  if (allowed.length === 0) {
    return { ok: false, status: 403, message: "Nessun modello consentito per questo utente" };
  }

  if (isRandomRequest(requestedModel)) {
    // Se c'è un default ed è consentito, preferiscilo come "random" deterministico?
    // No: l'utente ha chiesto esplicitamente il random. Scegliamo davvero a caso.
    const model = allowed[secureRandomInt(allowed.length)];
    return { ok: true, model, random: true };
  }

  if (!allowed.includes(requestedModel)) {
    return {
      ok: false,
      status: 403,
      message: `Modello "${requestedModel}" non consentito. Disponibili: ${allowed.join(", ")}`,
    };
  }
  return { ok: true, model: requestedModel, random: false };
}

export const _internal = { secureRandomInt };
