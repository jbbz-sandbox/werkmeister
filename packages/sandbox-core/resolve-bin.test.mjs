import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSandboxBin } from "./dist/sandbox.js";

const SAVED = { SANDBOX_BIN: process.env.SANDBOX_BIN, SANDBOX_ROOT: process.env.SANDBOX_ROOT };

/** A temp dir holding an executable `sandbox` wrapper, like a real checkout root. */
async function fakeCheckout() {
  const dir = await mkdtemp(path.join(tmpdir(), "sandbox-root-"));
  const bin = path.join(dir, "sandbox");
  await writeFile(bin, "#!/bin/bash\nexit 0\n");
  await chmod(bin, 0o755);
  return { dir, bin };
}

beforeEach(() => {
  delete process.env.SANDBOX_BIN;
  delete process.env.SANDBOX_ROOT;
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("SANDBOX_ROOT names the checkout whose wrapper is used", async () => {
  const { dir, bin } = await fakeCheckout();
  process.env.SANDBOX_ROOT = dir;
  assert.equal(await resolveSandboxBin(), bin);
});

test("SANDBOX_BIN still wins over SANDBOX_ROOT", async () => {
  const a = await fakeCheckout();
  const b = await fakeCheckout();
  process.env.SANDBOX_BIN = a.bin;
  process.env.SANDBOX_ROOT = b.dir;
  assert.equal(await resolveSandboxBin(), a.bin);
});

test("a SANDBOX_ROOT with no wrapper falls through instead of returning a bogus path", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "sandbox-empty-"));
  process.env.SANDBOX_ROOT = empty;
  // Either a real wrapper found further down the chain, or a clean throw —
  // never the non-existent path we just pointed at.
  const found = await resolveSandboxBin().catch(() => null);
  assert.notEqual(found, path.join(empty, "sandbox"));
});

test("walks up to the checkout root that owns the CLI package", async () => {
  // Mirrors today's layout: <root>/sandbox next to <root>/apps/cli.
  const root = await mkdtemp(path.join(tmpdir(), "sandbox-walkup-"));
  await mkdir(path.join(root, "apps", "cli"), { recursive: true });
  const bin = path.join(root, "sandbox");
  await writeFile(bin, "#!/bin/bash\nexit 0\n");
  await chmod(bin, 0o755);
  assert.equal(await resolveSandboxBin({ from: path.join(root, "apps", "cli") }), bin);
});
