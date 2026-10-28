# syntax=docker/dockerfile:1.7
#
# Immagine di produzione di byok-proxy.
#
#  - stage "test": esegue l'intera suite di test; se un test fallisce la build si
#    ferma. Nessuna dipendenza npm da installare, quindi nessun accesso alla rete.
#  - stage finale: distroless nonroot (niente shell, niente package manager),
#    utente 65532, solo il codice dell'applicazione.
#
#   docker build -t byok-proxy .

ARG NODE_BUILD_IMAGE=node:22-alpine
ARG NODE_RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot

# ---------- test ----------
FROM ${NODE_BUILD_IMAGE} AS test
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY tests ./tests
RUN node --disable-warning=ExperimentalWarning --test "tests/*.test.mjs" \
 && mkdir -p /out/data \
 && echo "ok" > /out/tests-passed

# ---------- runtime ----------
FROM ${NODE_RUNTIME_IMAGE}
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    CONFIG_PATH=/config/config.json \
    DB_PATH=/data/proxy.db

# Lega lo stage finale allo stage di test: senza test passati, niente immagine.
COPY --from=test /out/tests-passed /app/.tests-passed
# Cartella dati già di proprietà dell'utente non privilegiato (i volumi nominati
# ereditano questi permessi alla prima creazione).
COPY --from=test --chown=65532:65532 /out/data /data
COPY package.json ./
COPY src ./src

USER 65532:65532
EXPOSE 8787
VOLUME ["/data"]

# Immagine distroless: niente curl/wget, l'healthcheck è uno script Node.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/src/healthcheck.js"]

# Node è PID 1 e riceve direttamente SIGTERM: lo spegnimento scrive gli eventi
# in buffer e chiude il DB (vedi src/index.js).
ENTRYPOINT ["/nodejs/bin/node", "--disable-warning=ExperimentalWarning", "/app/src/index.js"]
