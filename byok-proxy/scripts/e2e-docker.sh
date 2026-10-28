#!/usr/bin/env bash
# Test end-to-end dell'immagine Docker contro un finto Azure AI Foundry in HTTPS.
#
#   bash scripts/e2e-docker.sh
#
# Costruisce l'immagine (i test unitari girano nella build), poi avvia il
# container reale con hardening (filesystem in sola lettura, nessuna capability,
# utente non privilegiato) e verifica:
#   1. auth a chiave: chat, streaming, deployment, limiti, 429 di Azure, login
#      GitHub, dashboard e API admin;
#   2. persistenza e spegnimento pulito: richiesta inviata subito prima dello
#      stop -> ancora presente dopo il riavvio;
#   3. auth Entra ID (service principal) e Managed Identity, con cache del token;
#   4. config errata -> il container si ferma con un messaggio chiaro.
# Richiede: docker, node >= 22, openssl. Usa la rete dell'host.

set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-byok-proxy:e2e}
NAME=byok-e2e
VOLUME=byok-e2e-data
PROXY_PORT=18787
MOCK_PORT=19443
PROXY=http://127.0.0.1:$PROXY_PORT
MOCK=https://127.0.0.1:$MOCK_PORT
ADMIN=e2e-admin-token
WORK=$(mktemp -d)
MOCK_PID=""

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { printf '\n== %s ==\n' "$*"; }
fail() { echo "ERRORE: $*"; echo "--- log container:"; docker logs "$NAME" 2>&1 | tail -30 || true; exit 1; }

step "Certificati di test per il finto Azure"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=byok-e2e-ca" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" \
  -keyout "$WORK/ca.key" -out "$WORK/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" -keyout "$WORK/srv.key" -out "$WORK/srv.csr" 2>/dev/null
printf 'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > "$WORK/ext.cnf"
openssl x509 -req -in "$WORK/srv.csr" -CA "$WORK/ca.pem" -CAkey "$WORK/ca.key" -CAcreateserial \
  -days 1 -extfile "$WORK/ext.cnf" -out "$WORK/srv.pem" 2>/dev/null
chmod 644 "$WORK/ca.pem"
echo "ok"

step "Avvio finto Azure su $MOCK"
node tests/e2e/mock-azure.mjs "$MOCK_PORT" "$WORK/srv.pem" "$WORK/srv.key" > "$WORK/mock.log" 2>&1 &
MOCK_PID=$!
for _ in $(seq 1 50); do curl -s --cacert "$WORK/ca.pem" "$MOCK/__state" >/dev/null && break; sleep 0.1; done
curl -sf --cacert "$WORK/ca.pem" "$MOCK/__state" >/dev/null || { cat "$WORK/mock.log"; echo "mock non partito"; exit 1; }
echo "ok"

step "Build dell'immagine $IMAGE (con test unitari)"
docker build --network host -q -t "$IMAGE" . >/dev/null
docker image inspect "$IMAGE" --format 'dimensione: {{.Size}} byte, utente: {{.Config.User}}'

run_proxy() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --network host \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true --memory 512m \
    -e PORT="$PROXY_PORT" -e ADMIN_TOKEN="$ADMIN" -e GITHUB_OAUTH_CLIENT_ID=Iv1.e2e \
    -e NODE_EXTRA_CA_CERTS=/certs/ca.pem \
    -v "$WORK/ca.pem:/certs/ca.pem:ro" \
    -v "$PWD/tests/e2e/config.e2e.json:/config/config.json:ro" \
    -v "$VOLUME:/data" \
    "$@" "$IMAGE" >/dev/null
}

wait_healthy() {
  for _ in $(seq 1 60); do
    st=$(docker inspect -f '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo missing)
    [ "$st" = healthy ] && { echo "container healthy"; return 0; }
    [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] && fail "il container si è fermato"
    sleep 1
  done
  fail "il container non è diventato healthy"
}

checks() { NODE_EXTRA_CA_CERTS="$WORK/ca.pem" node tests/e2e/checks.mjs "$1" "$PROXY" "$MOCK" "$ADMIN"; }
reset_mock() { curl -sf --cacert "$WORK/ca.pem" -X POST "$MOCK/__reset" >/dev/null; }

# ---------------------------------------------------------------------------
step "1. Auth a chiave API: funzioni complete"
docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
run_proxy -e AZURE_FOUNDRY_API_KEY=mock-azure-key
wait_healthy
checks full || fail "verifiche funzionali"

step "Hardening del container"
user=$(docker inspect -f '{{.Config.User}}' "$NAME")
ro=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$NAME")
caps=$(docker inspect -f '{{.HostConfig.CapDrop}}' "$NAME")
uid=$(docker top "$NAME" -o pid,uid | awk 'NR>1 {print $2; exit}')
echo "utente immagine: $user · uid processo: $uid · rootfs sola lettura: $ro · cap drop: $caps"
[ "$uid" = 65532 ] && [ "$ro" = true ] || fail "hardening non applicato"
echo "  ✓ processo non privilegiato su filesystem in sola lettura"

# ---------------------------------------------------------------------------
step "2. Persistenza e spegnimento pulito"
before=$(checks count)
# Una richiesta e subito dopo SIGTERM: l'evento è ancora nel buffer in memoria.
curl -s -o /dev/null -H "Authorization: Bearer byok_e2e_alice_key" -H "Content-Type: application/json" \
  -d '{"model":"gpt-4.1-mini","messages":[{"role":"user","content":"ultima"}]}' "$PROXY/v1/chat/completions"
docker stop -t 15 "$NAME" >/dev/null
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
docker logs "$NAME" 2>&1 | grep -q "SIGTERM: arresto in corso" || fail "spegnimento non gestito"
[ "$code" = 0 ] || fail "exit code allo stop: $code"
echo "  ✓ SIGTERM gestito, exit code 0"
docker start "$NAME" >/dev/null
wait_healthy
after=$(checks count)
echo "richieste registrate: prima $before, dopo il riavvio $after"
[ "$after" -eq $((before + 1)) ] || fail "la richiesta inviata prima dello stop è andata persa"
echo "  ✓ dati conservati nel volume, nessun evento perso allo stop"

# ---------------------------------------------------------------------------
step "3a. Auth Entra ID (service principal)"
reset_mock
run_proxy -e AZURE_AUTH=entra -e AZURE_TENANT_ID=e2e-tenant -e AZURE_CLIENT_ID=e2e-client \
  -e AZURE_CLIENT_SECRET=e2e-secret -e AZURE_AUTHORITY_HOST="$MOCK"
wait_healthy
checks entra || fail "verifiche Entra"

step "3b. Auth Managed Identity (Azure Container Apps)"
reset_mock
run_proxy -e AZURE_AUTH=managed-identity -e IDENTITY_ENDPOINT="$MOCK/msi/token" -e IDENTITY_HEADER=e2e-identity-header
wait_healthy
checks managed-identity || fail "verifiche Managed Identity"

# ---------------------------------------------------------------------------
step "4. Configurazione errata: il container si ferma con un messaggio chiaro"
run_proxy -e AZURE_AUTH=entra -e AZURE_TENANT_ID=e2e-tenant -e AZURE_CLIENT_ID=e2e-client \
  -e AZURE_CLIENT_SECRET=sbagliato -e AZURE_AUTHORITY_HOST="$MOCK"
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = false ] && break; sleep 0.5; done
code=$(docker inspect -f '{{.State.ExitCode}}' "$NAME")
msg=$(docker logs "$NAME" 2>&1 | grep "avvio fallito" || true)
echo "exit code $code: $msg"
[ "$code" = 1 ] && echo "$msg" | grep -q "invalid_client" || fail "errore di config non riportato"
echo "$msg" | grep -q "sbagliato" && fail "il segreto compare nei log"
echo "  ✓ avvio rifiutato, errore leggibile, nessun segreto nei log"

step "TUTTO OK"
