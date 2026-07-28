// Pure parser for `gh pr view --json state,url,title,number` (a single JSON
// object) or a `gh pr list --json …` array. No IO. Returns a normalized
// { state, url, title, number } | null. `state` is uppercased to one of
// OPEN|MERGED|CLOSED (or null if unrecognized); a PR with no usable url is null
// (nothing to link to).

export function parsePr(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const obj = Array.isArray(data) ? data[0] : data;
  if (!obj || typeof obj !== "object") return null;

  const url = typeof obj.url === "string" ? obj.url : null;
  if (!url) return null;

  return {
    state: normalizeState(obj.state),
    url,
    title: typeof obj.title === "string" ? obj.title : "",
    number: typeof obj.number === "number" ? obj.number : null,
  };
}

function normalizeState(s) {
  const v = String(s || "").toUpperCase();
  return v === "OPEN" || v === "MERGED" || v === "CLOSED" ? v : null;
}
