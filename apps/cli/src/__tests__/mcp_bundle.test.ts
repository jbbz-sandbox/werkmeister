/**
 * The bundled MCP server (`dist/mcp.js`, built from `../mcp/main.ts` by
 * esbuild.mjs) answers `initialize` over stdio.
 *
 * This is the one thing an `npm i -g` install relies on that no other test
 * covers: that apps/mcp and its deps (express, the MCP SDK, zod, sandbox-core)
 * bundle into self-contained ESM and boot without the monorepo around them.
 * The `test` script builds first, so the bundle is always current here.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { expect, it } from "vitest";

const CLI_ROOT = path.resolve(import.meta.dirname, "../..");

it("dist/mcp.js answers initialize over stdio", async () => {
  const entry = path.join(CLI_ROOT, "dist", "mcp.js");
  expect(fs.existsSync(entry), `${entry} missing — run npm run build`).toBe(true);

  const child = spawn(process.execPath, [entry, "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SANDBOX_ROOT: CLI_ROOT },
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  const firstLine = new Promise<string>((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(buf.slice(0, nl));
    });
    child.on("exit", (code) => reject(new Error(`exited ${code}: ${stderr}`)));
    setTimeout(() => reject(new Error(`no response in 10s: ${stderr}`)), 10_000);
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

  try {
    const reply = JSON.parse(await firstLine);
    expect(reply.result.serverInfo.name).toBe("sandbox");
  } finally {
    child.kill();
  }
}, 15_000);
