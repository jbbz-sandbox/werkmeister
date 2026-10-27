import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { resolveSandboxBin } from "./dist/sandbox.js";

const SAVED = {
  WERKMEISTER_BIN: process.env.WERKMEISTER_BIN,
  WERKMEISTER_ROOT: process.env.WERKMEISTER_ROOT,
};

/** A temp dir holding an executable `werkmeister` wrapper, like a real checkout root. */
async function fakeCheckout() {
  const dir = await mkdtemp(path.join(tmpdir(), "w9r-root-"));
  const bin = path.join(dir, "werkmeister");
  await writeFile(bin, "#!/bin/bash\nexit 0\n");
  await chmod(bin, 0o755);
  return { dir, bin };
}

beforeEach(() => {
  delete process.env.WERKMEISTER_BIN;
  delete process.env.WERKMEISTER_ROOT;
});

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test("WERKMEISTER_ROOT names the checkout whose wrapper is used", async () => {
  const { dir, bin } = await fakeCheckout();
  process.env.WERKMEISTER_ROOT = dir;
  assert.equal(await resolveSandboxBin(), bin);
});

test("WERKMEISTER_BIN still wins over WERKMEISTER_ROOT", async () => {
  const a = await fakeCheckout();
  const b = await fakeCheckout();
  process.env.WERKMEISTER_BIN = a.bin;
  process.env.WERKMEISTER_ROOT = b.dir;
  assert.equal(await resolveSandboxBin(), a.bin);
});

test("a WERKMEISTER_ROOT with no wrapper falls through instead of returning a bogus path", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "w9r-empty-"));
  process.env.WERKMEISTER_ROOT = empty;
  // Either a real wrapper found further down the chain, or a clean throw —
  // never the non-existent path we just pointed at.
  const found = await resolveSandboxBin().catch(() => null);
  assert.notEqual(found, path.join(empty, "werkmeister"));
});

test("walks up to the checkout root that owns the CLI package", async () => {
  // Mirrors today's layout: the wrapper is <root>/apps/cli/werkmeister.
  const root = await mkdtemp(path.join(tmpdir(), "w9r-walkup-"));
  await mkdir(path.join(root, "apps", "cli"), { recursive: true });
  const bin = path.join(root, "apps", "cli", "werkmeister");
  await writeFile(bin, "#!/bin/bash\nexit 0\n");
  await chmod(bin, 0o755);
  assert.equal(await resolveSandboxBin({ from: path.join(root, "apps", "cli") }), bin);
});
