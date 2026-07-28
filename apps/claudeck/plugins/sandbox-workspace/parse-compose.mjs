// Pure parser for `docker compose ps --format json`. No IO. Compose v2 emits
// either newline-delimited JSON objects (one per container, newer) or a single
// JSON array (older) — handle both. Returns a normalized
// [{ service, state, health, ports }] where health ∈
// healthy|starting|unhealthy|running|down and ports is a sorted int[] of
// published host ports.

export function parseComposePs(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  return parseRows(text).map(normalize).filter(Boolean);
}

function parseRows(text) {
  // Single JSON value (array on older compose, or one object).
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : [v];
  } catch {
    // NDJSON: one object per line; skip anything unparseable.
    const out = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* best-effort: ignore junk lines */
      }
    }
    return out;
  }
}

function normalize(o) {
  if (!o || typeof o !== "object") return null;
  const service = o.Service || o.Name || null;
  if (!service) return null;
  const state = o.State || "unknown";
  return {
    service,
    state,
    health: normalizeHealth(state, o.Health),
    ports: extractPorts(o.Publishers),
  };
}

function normalizeHealth(state, health) {
  const h = String(health || "").toLowerCase();
  if (h === "healthy" || h === "starting" || h === "unhealthy") return h;
  return String(state || "").toLowerCase() === "running" ? "running" : "down";
}

function extractPorts(publishers) {
  if (!Array.isArray(publishers)) return [];
  const seen = new Set();
  for (const p of publishers) {
    const pub = Number(p?.PublishedPort);
    if (pub > 0) seen.add(pub);
  }
  return [...seen].sort((a, b) => a - b);
}
