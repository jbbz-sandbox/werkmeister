import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const tsconfigPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "tsconfig.json");

/** The files this package's tsconfig would compile if the package lived at `dir`. */
function includedFiles(dir) {
  const { config, error } = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  assert.equal(error, undefined);
  return ts.parseJsonConfigFileContent(config, ts.sys, dir).fileNames;
}

// #219: a .ts file nothing imports, in a subdirectory the include list never
// named, must still be compiled — not silently dropped while tsc exits 0.
// Parsed against a temp dir so the dev container's `tsc --watch` never sees it.
test("tsconfig include picks up unimported .ts files in new subdirectories", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "tsconfig-include-"));
  try {
    const files = ["src/index.ts", "src/issue_trackers/linear.ts", "src/new_dir/deep/orphan.ts"];
    for (const f of [...files, "dist/index.d.ts", "node_modules/x/index.ts"]) {
      await mkdir(path.dirname(path.join(dir, f)), { recursive: true });
      await writeFile(path.join(dir, f), "export {};\n");
    }
    const got = includedFiles(dir)
      .map((f) => path.relative(dir, f))
      .sort();
    assert.deepEqual(got, files.sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
