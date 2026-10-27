// Piccoli helper HTTP condivisi (parsing header, lettura body, risposte JSON).

/** Estrae il token da un header "Bearer xxx" (case-insensitive sullo schema). */
export function extractBearer(value) {
  if (!value || typeof value !== "string") return null;
  const m = /^\s*bearer\s+(.+)\s*$/i.exec(value);
  return m ? m[1].trim() : null;
}

/** Legge il body di una richiesta http come stringa, con limite di dimensione. */
export function readBody(req, { limitBytes = 10 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error("body troppo grande"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function readJson(req, opts) {
  const text = await readBody(req, opts);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    throw Object.assign(new Error(`JSON non valido: ${e.message}`), { status: 400 });
  }
}

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/** Errore in forma OpenAI-compatibile, così i client (VS/Copilot) lo mostrano. */
export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: { message, type: extra.type ?? "proxy_error", ...extra } }, extra.headers ?? {});
}
