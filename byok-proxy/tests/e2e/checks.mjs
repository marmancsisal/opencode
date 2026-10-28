// Verifiche end-to-end contro il container in esecuzione.
//
//   node tests/e2e/checks.mjs <scenario> <proxyUrl> <mockUrl> <adminToken>
//
// scenario: "full"  (auth a chiave: tutte le funzioni)
//           "entra" / "managed-identity" (auth a token: chat, stream, cache del token)
//           "count" (stampa solo il numero di richieste registrate)
// Richiede NODE_EXTRA_CA_CERTS col certificato del mock per parlare col mock.

const [scenario, proxy, mock, adminToken] = process.argv.slice(2);
let failures = 0;
let passed = 0;

function check(cond, label, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label}${detail ? `  →  ${detail}` : ""}`);
  }
}

const chat = (key, body, extra = {}) =>
  fetch(`${proxy}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra },
    body: JSON.stringify({ messages: [{ role: "user", content: "ciao" }], ...body }),
  });
const admin = (path, opts = {}) =>
  fetch(`${proxy}/admin/api${path}`, { ...opts, headers: { Authorization: `Bearer ${adminToken}`, ...(opts.headers || {}) } });
const mockState = () => fetch(`${mock}/__state`).then((r) => r.json());
const lastChat = async () => (await mockState()).chats.at(-1);

const ALICE = "byok_e2e_alice_key";
const BOB = "byok_e2e_bob_key";

if (scenario === "count") {
  const o = await (await admin("/overview?days=1")).json();
  console.log(o.usage.requests);
  process.exit(0);
}

const expectedAuth = scenario === "full" ? "api-key" : "bearer";
console.log(`\n▶ scenario ${scenario} (auth verso Azure: ${expectedAuth})`);

// ---- base ----
const h = await fetch(`${proxy}/healthz`);
check(h.status === 200, "healthz 200");

const noKey = await fetch(`${proxy}/v1/models`);
check(noKey.status === 401, "senza api key -> 401");

const models = await (await fetch(`${proxy}/v1/models`, { headers: { Authorization: `Bearer ${ALICE}` } })).json();
const ids = models.data.map((m) => m.id);
check(["auto", "gpt-4.1-mini", "gpt-4.1", "slow-model"].every((m) => ids.includes(m)), "/v1/models elenca auto + modelli", ids.join(","));

// ---- chat non stream ----
const r1 = await chat(ALICE, { model: "gpt-4.1-mini" });
const j1 = await r1.json();
check(r1.status === 200 && j1.choices?.[0]?.message?.content === "Ciao da Azure", "chat non-stream 200 con risposta di Azure", `${r1.status} ${JSON.stringify(j1).slice(0, 120)}`);
check(r1.headers.get("x-selected-model") === "gpt-4.1-mini", "header X-Selected-Model");
let c = await lastChat();
check(c?.model === "mini-prod", "ad Azure arriva il nome del deployment (mini-prod)", c?.model);
check(c?.auth === expectedAuth, `ad Azure arriva l'auth giusta (${expectedAuth})`, c?.auth);
check(c?.hasStreamOptions === false, "nessun stream_options nelle richieste non-stream");

// ---- streaming ----
const r2 = await chat(ALICE, { model: "gpt-4.1", stream: true });
const t2 = await r2.text();
check(r2.status === 200 && /event-stream/.test(r2.headers.get("content-type") || ""), "stream: 200 text/event-stream");
check(t2.includes('"Ciao"') && t2.includes(" Azure") && t2.includes("[DONE]"), "stream: tutti i chunk arrivano al client fino a [DONE]");
c = await lastChat();
check(c?.model === "full-prod" && c?.includeUsage === true, "stream: deployment full-prod e include_usage richiesto ad Azure", JSON.stringify(c));

// ---- auto ----
const r3 = await chat(ALICE, { model: "auto" });
await r3.arrayBuffer();
check(r3.status === 200 || r3.status === 429, "model auto risolto");
check(["gpt-4.1-mini", "gpt-4.1", "slow-model"].includes(r3.headers.get("x-selected-model")), "auto sceglie un modello consentito", r3.headers.get("x-selected-model"));

if (scenario === "entra" || scenario === "managed-identity") {
  for (let i = 0; i < 4; i++) await (await chat(ALICE, { model: "gpt-4.1-mini" })).arrayBuffer();
  const s = await mockState();
  const n = scenario === "entra" ? s.entraTokens : s.msiTokens;
  check(n === 1, `un solo token ${scenario} per tutte le richieste (cache)`, `token richiesti: ${n}`);
}

if (scenario === "full") {
  // ---- accesso per gruppo ----
  const before = (await mockState()).chats.length;
  const r4 = await chat(BOB, { model: "gpt-4.1" });
  check(r4.status === 403, "junior su gpt-4.1 -> 403");
  check((await mockState()).chats.length === before, "richiesta vietata non arriva ad Azure");

  // ---- 429 di Azure ----
  const r5 = await chat(ALICE, { model: "slow-model" });
  check(r5.status === 429 && r5.headers.get("retry-after") === "3", "429 di Azure riportato con Retry-After", `${r5.status} ${r5.headers.get("retry-after")}`);

  // ---- limite del proxy ----
  let limited = null;
  for (let i = 0; i < 8; i++) {
    const r = await chat(BOB, { model: "gpt-4.1-mini" });
    if (r.status === 429) {
      limited = await r.json();
      break;
    }
    await r.arrayBuffer();
  }
  check(limited?.error?.type === "rate_limit_exceeded", "limite rpm del gruppo junior -> 429 del proxy", JSON.stringify(limited));

  // ---- login GitHub (device flow) ----
  const start = await (await fetch(`${proxy}/login/start`, { method: "POST" })).json();
  check(!!start.handle && start.userCode === "E2E0-0001", "login: codice dispositivo");
  const poll = () => fetch(`${proxy}/login/poll`, { method: "POST", body: JSON.stringify({ handle: start.handle }) }).then((r) => r.json());
  check((await poll()).status === "pending", "login: in attesa di autorizzazione");
  const done = await poll();
  check(done.status === "ok" && /^byok_[0-9a-f]{48}$/.test(done.apiKey || ""), "login: api key personale emessa", JSON.stringify(done));
  const r6 = await chat(done.apiKey, { model: "gpt-4.1-mini" });
  await r6.arrayBuffer();
  check(r6.status === 200, "la nuova api key funziona");

  // ---- dashboard ----
  const page = await fetch(`${proxy}/admin`);
  check(page.status === 200 && /script-src 'self'/.test(page.headers.get("content-security-policy") || ""), "dashboard servita con CSP");
  const js = await fetch(`${proxy}/admin/dashboard.js`);
  check(js.status === 200 && (await js.text()).includes("renderClients"), "dashboard.js servito");
  check((await fetch(`${proxy}/admin/api/overview`)).status === 401, "API admin senza token -> 401");
  const ov = await (await admin("/overview?days=1")).json();
  check(ov.clients.total === 3, "dashboard: 3 clienti (2 da config + 1 da login)", JSON.stringify(ov.clients));
  check(ov.usage.requests >= 10 && ov.usage.errors >= 1 && ov.usage.blocked >= 2, "dashboard: richieste, errori e bloccate contate", JSON.stringify(ov.usage));
  const cl = await (await admin("/clients?q=carla")).json();
  check(cl.total === 1 && cl.data[0].login === "carla-dev" && cl.data[0].source === "device", "dashboard: ricerca cliente registrato via login");
  check(!JSON.stringify(cl).includes(done.apiKey), "dashboard: l'api key non compare mai in chiaro");
  const ev = await (await admin("/events?q=slow-model")).json();
  check(ev.data.some((e) => e.outcome === "error" && e.reason === "upstream:429"), "dashboard: evento errore 429 registrato");
  const dis = await admin(`/clients/${encodeURIComponent(cl.data[0].id)}/disable`, { method: "POST" });
  check(dis.status === 200, "dashboard: disattiva cliente");
  const r7 = await chat(done.apiKey, { model: "gpt-4.1-mini" });
  check(r7.status === 403, "cliente disattivato -> 403");
}

console.log(`\n  ${passed} superate, ${failures} fallite`);
process.exit(failures ? 1 : 0);
