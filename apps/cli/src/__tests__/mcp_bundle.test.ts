/**
 * The bundled MCP server (`dist/mcp.js`, built from `../werkmeister-mcp/src/main.ts` by
 * esbuild.mjs) answers `initialize` over stdio.
 *
 * This is the one thing an `npm i -g` install relies on that no other test
 * covers: that apps/werkmeister-mcp and its deps (express, the MCP SDK, zod, werkmeister-core)
 * bundle into self-contained ESM and boot without the monorepo around them.
 * The `test` script builds first, so the bundle is always current here.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it, onTestFinished } from "vitest";

const CLI_ROOT = path.resolve(import.meta.dirname, "../..");

it("dist/mcp.js answers initialize over stdio", async () => {
  const entry = path.join(CLI_ROOT, "dist", "mcp.js");
  expect(fs.existsSync(entry), `${entry} missing — run pnpm run build`).toBe(true);

  const child = spawn(process.execPath, [entry, "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WERKMEISTER_ROOT: CLI_ROOT },
  });
  onTestFinished(() => void child.kill());
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  const firstLine = new Promise<string>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(buf.slice(0, nl));
    });
    // No timer of its own: the suite's testTimeout is the one deadline. A 10 s timer here fired
    // first whenever load slowed the 3.5 MB bundle's boot (#206).
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
  });

  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "mcp_bundle.test", version: "0" },
      },
    }) + "\n",
  );

  const reply = JSON.parse(await firstLine);
  expect(reply.result.serverInfo.name).toBe("werkmeister");
});
