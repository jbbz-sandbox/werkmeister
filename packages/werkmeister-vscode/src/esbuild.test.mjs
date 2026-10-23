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

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("esbuild.mjs bundles a require of @grpc/* that is not installed", () => {
  const dir = mkdtempSync(join(tmpdir(), "vscode-esbuild-"));
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    // The scratch project only needs esbuild itself, never @grpc.
    const esbuildDir = dirname(
      dirname(createRequire(join(pkgDir, "package.json")).resolve("esbuild")),
    );
    symlinkSync(esbuildDir, join(dir, "node_modules", "esbuild"), "dir");
    copyFileSync(join(pkgDir, "esbuild.mjs"), join(dir, "esbuild.mjs"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(dir, "src", "extension.ts"),
      'require("@grpc/grpc-js");\nrequire("@grpc/proto-loader");\n',
    );

    execFileSync(process.execPath, ["esbuild.mjs"], { cwd: dir, stdio: "pipe" });
    // Loading the bundle must not throw MODULE_NOT_FOUND either.
    execFileSync(process.execPath, ["dist/extension.cjs"], { cwd: dir, stdio: "pipe" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
