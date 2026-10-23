// Smoke test for lib/localhost-form: the blocking collect server — page serve,
// /api/tool dispatch (workspace-form-schema roundtrip), submit + cancel + open
// passthrough, and the localOnly host guard. No browser is opened.
//   npm run build && node lib/localhost-form.smoke.mjs
import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { promptViaLocalhostForm } = await import(
  path.join(pkgRoot, "dist", "lib", "localhost-form.js")
);

const bundle = {
  schema: { type: "object", properties: { feature: { type: "string" } } },
  uiSchema: {},
  formData: { feature: "smoke" },
  title: "Smoke Test",
};

// The server logs its URL to stderr; capture it instead of scraping.
function captureUrl() {
  return new Promise((resolve) => {
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      const m = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (m) {
        process.stderr.write = orig;
        resolve(m[0]);
      }
      return orig(chunk, ...rest);
    };
  });
}

async function tool(url, name, args) {
  return fetch(url + "api/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, arguments: args ?? {} }),
  });
}

// 1. Submit path: page served, bundle roundtrips, create-workspace settles.
{
  const urlP = captureUrl();
  const resultP = promptViaLocalhostForm(bundle, { open: false, timeoutMs: 10_000 });
  const url = await urlP;

  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="app">/);

  const schemaRes = await tool(url, "workspace-form-schema");
  assert.deepEqual((await schemaRes.json()).structuredContent, bundle);

  // Guard: a foreign Origin is refused.
  const evil = await fetch(url + "api/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ name: "workspace-form-schema", arguments: {} }),
  });
  assert.equal(evil.status, 403);

  const unknown = await tool(url, "nope");
  assert.equal(unknown.status, 400);

  const submit = await tool(url, "create-workspace", {
    formData: { feature: "smoke" },
    open: false,
  });
  assert.match((await submit.json()).structuredContent.output, /Submitted/);

  const result = await resultP;
  assert.deepEqual(result, {
    status: "submitted",
    formData: { feature: "smoke" },
    open: false,
  });
}

// 2. Cancel path.
{
  const urlP = captureUrl();
  const resultP = promptViaLocalhostForm(bundle, { open: false, timeoutMs: 10_000 });
  const url = await urlP;
  await tool(url, "cancel-form");
  assert.deepEqual(await resultP, { status: "cancelled" });
}

// 3. Timeout path.
{
  const resultP = promptViaLocalhostForm(bundle, { open: false, timeoutMs: 100 });
  assert.deepEqual(await resultP, { status: "timeout" });
}

console.log("localhost-form smoke OK");
