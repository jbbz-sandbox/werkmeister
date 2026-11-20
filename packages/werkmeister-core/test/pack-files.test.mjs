// SW-714: the published tarball carries no test scaffolding, and every module it
// does carry can load: no packed file imports one `files` left out.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

const pkg = path.resolve(import.meta.dirname, "..");
// --ignore-scripts: packing must not build; the suite already runs against a built dist.
const [{ files }] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: pkg,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }),
);
const packed = new Set(files.map((f) => f.path));

test("the tarball holds no fixture modules", () => {
  assert.deepEqual(
    [...packed].filter((p) => /^dist\/fixture_(fakes|workspace)\./.test(p)),
    [],
  );
});

test("every relative import of a packed module is packed too", () => {
  const missing = [];
  for (const p of packed) {
    if (!/\.(js|d\.ts)$/.test(p)) continue;
    const text = fs.readFileSync(path.join(pkg, p), "utf8");
    for (const [, spec] of text.matchAll(/(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.posix.join(path.posix.dirname(p), spec);
      const want = p.endsWith(".d.ts") ? target.replace(/\.js$/, ".d.ts") : target;
      if (!packed.has(want)) missing.push(`${p} -> ${spec}`);
    }
  }
  assert.deepEqual(missing, []);
});
