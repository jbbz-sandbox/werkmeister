/**
 * The bundle must not depend on dockerode's session-only gRPC deps being installed.
 *
 * dockerode's docker.js requires ./session, which requires `@grpc/grpc-js` and
 * `@grpc/proto-loader` at load time. The extension never opens a build session,
 * but esbuild still resolves them: with either missing from node_modules (a
 * stale volume, a pruned install) the watch build exits and the container
 * crash-loops. Run the real esbuild.mjs over a scratch project whose entry
 * requires them, with no node_modules/@grpc anywhere on the resolution path.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("esbuild.mjs bundles a require of @grpc/* that is not installed", () => {
  const root = mkdtempSync(join(tmpdir(), "vscode-esbuild-"));
  try {
    // esbuild.mjs imports ../../scripts/write-licenses.mjs and that copies the root
    // LICENSE/NOTICE, so the scratch project sits two levels below a scratch root.
    const dir = join(root, "packages", "ext");
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "fakedep"), { recursive: true });
    mkdirSync(join(root, "scripts"));
    copyFileSync(
      join(pkgDir, "../../scripts/write-licenses.mjs"),
      join(root, "scripts/write-licenses.mjs"),
    );
    writeFileSync(join(root, "LICENSE"), "root licence");
    writeFileSync(join(root, "NOTICE"), "root notice");
    // The scratch project only needs esbuild itself, never @grpc.
    const esbuildDir = dirname(
      dirname(createRequire(join(pkgDir, "package.json")).resolve("esbuild")),
    );
    symlinkSync(esbuildDir, join(dir, "node_modules", "esbuild"), "dir");
    copyFileSync(join(pkgDir, "esbuild.mjs"), join(dir, "esbuild.mjs"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    const fakedep = join(dir, "node_modules", "fakedep");
    writeFileSync(
      join(fakedep, "package.json"),
      '{"name":"fakedep","version":"1.2.3","license":"MIT","main":"index.js"}',
    );
    writeFileSync(join(fakedep, "index.js"), "module.exports = 1;");
    writeFileSync(join(fakedep, "LICENSE"), "fakedep licence text");
    writeFileSync(
      join(dir, "src", "extension.ts"),
      'require("@grpc/grpc-js");\nrequire("@grpc/proto-loader");\nrequire("fakedep");\n',
    );

    execFileSync(process.execPath, ["esbuild.mjs"], { cwd: dir, stdio: "pipe" });
    // Loading the bundle must not throw MODULE_NOT_FOUND either.
    execFileSync(process.execPath, ["dist/extension.cjs"], { cwd: dir, stdio: "pipe" });

    // vsce only finds LICENSE in the package root (SW-74).
    assert.equal(readFileSync(join(dir, "LICENSE"), "utf8"), "root licence");
    assert.equal(readFileSync(join(dir, "NOTICE"), "utf8"), "root notice");
    const third = readFileSync(join(dir, "THIRD-PARTY-LICENSES.txt"), "utf8");
    assert.match(third, /fakedep@1\.2\.3 \(MIT\)\n\nfakedep licence text/);
    assert.ok(!existsSync(join(dir, "dist", "LICENSE")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
