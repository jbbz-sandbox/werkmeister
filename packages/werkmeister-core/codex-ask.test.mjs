// SW-384: the Codex adapter's asks run `codex exec` with --output-schema and read the
// answer from -o, never from stdout. A fake `codex` (CODEX_BIN) records its argv.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const { askCodex, askCodexJson, askCodexStrict, codexReconcileCommand } = await import(
  "./dist/harness/codex/cli.js"
);

/**
 * A fake codex that logs argv and writes *answer* to the -o file (or exits *code*). Like the
 * real one, it reads stdin to its end before running, so an open stdin pipe would hang it:
 * here it fails after 2 s instead.
 */
function fakeCodex(answer, code = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
  const bin = path.join(dir, "codex");
  const log = path.join(dir, "argv.json");
  fs.writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(a));
const hung = setTimeout(() => { process.stderr.write("stdin left open\\n"); process.exit(3); }, 2000);
process.stdin.resume();
process.stdin.on("end", () => {
  clearTimeout(hung);
  if (${code}) { process.stderr.write("boom: not logged in\\n"); process.exit(${code}); }
  const o = a[a.indexOf("-o") + 1];
  if (${JSON.stringify(answer)} !== null) fs.writeFileSync(o, ${JSON.stringify(answer)});
});
`,
    { mode: 0o755 },
  );
  return { bin, argv: () => JSON.parse(fs.readFileSync(log, "utf-8")) };
}

// Fixture mode takes CODEX_BIN as given, so a missing fake never falls back to a real codex.
process.env.WERKMEISTER_FIXTURE = "1";
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "codex-ask-home-"));

async function withBin(fake, fn) {
  process.env.CODEX_BIN = fake.bin;
  try {
    return await fn();
  } finally {
    delete process.env.CODEX_BIN;
  }
}

test("askOrThrow returns the structured result, read-only, schema passed", async () => {
  const fake = fakeCodex(JSON.stringify({ result: "<result>hi</result>" }));
  assert.equal(await withBin(fake, () => askCodexStrict("say hi")), "hi");
  const argv = fake.argv();
  assert.equal(argv[0], "exec");
  for (const flag of ["--output-schema", "-o", "--ephemeral", "--skip-git-repo-check"])
    assert.ok(argv.includes(flag), flag);
  assert.deepEqual(argv.slice(argv.indexOf("-s"), argv.indexOf("-s") + 2), ["-s", "read-only"]);
  assert.deepEqual(argv.slice(-2), ["--", "say hi"]);
});

test("tools: true still runs read-only, never a bypassed sandbox", async () => {
  const fake = fakeCodex(JSON.stringify({ result: "ok" }));
  await withBin(fake, () => askCodex("x", { tools: true }));
  assert.ok(fake.argv().includes("read-only"));
  assert.ok(!fake.argv().some((a) => a.includes("dangerously")));
});

test("askJson parses the JSON object carried in result", async () => {
  const fake = fakeCodex(JSON.stringify({ result: '{"a":1,"b":"x"}' }));
  assert.deepEqual(await withBin(fake, () => askCodexJson("j")), { a: 1, b: "x" });
  const none = fakeCodex(JSON.stringify({ result: "no json here" }));
  assert.equal(await withBin(none, () => askCodexJson("j")), null);
});

test("a failing codex: ask is null, askOrThrow names the stderr", async () => {
  const fake = fakeCodex(null, 1);
  assert.equal(await withBin(fake, () => askCodex("x")), null);
  await assert.rejects(
    withBin(fake, () => askCodexStrict("x")),
    /codex exec failed: boom: not logged in/,
  );
});

test("no -o file written is 'no text'", async () => {
  const fake = fakeCodex(null);
  await assert.rejects(
    withBin(fake, () => askCodexStrict("x")),
    /Codex returned no text/,
  );
});

test("a missing binary says how to fix it", async () => {
  await assert.rejects(
    withBin({ bin: "/nonexistent/codex" }, () => askCodexStrict("x")),
    /Could not find the `codex` CLI/,
  );
});

test("reconcileCommand runs read-only in the quoted dir", () => {
  const cmd = codexReconcileCommand("/tmp/a b", "/tmp/a b/ctx.md", "go");
  assert.match(cmd, /^cd '\/tmp\/a b' && codex exec --skip-git-repo-check -s read-only -- /);
  assert.match(cmd, /"\$\(cat '\/tmp\/a b\/ctx\.md'\)"\$'\\n\\n''go'$/);
});
