// Healthcheck del container (l'immagine distroless non ha curl né wget).
// Esce con 0 se /healthz risponde 200 (processo vivo e DB leggibile), altrimenti 1.

const port = process.env.PORT || 8787;

fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(4000) })
  .then((r) => process.exit(r.ok ? 0 : 1))
  .catch(() => process.exit(1));
