/**
 * SW-446: `machine tokens` lists tokens with no workspace folder and leaves them alone
 * without --remove. Runs the built CLI against a temp HOME, never the real tokens.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const MAIN = path.resolve(fileURLToPath(import.meta.url), "../../../dist/main.js");
const run = promisify(execFile);

// One per prefix the core tests leaked before SW-433.
const LEAKED = [
  "create-copy-ws-a1B2c3",
  "jit-snap-ws-a1B2c3",
  "record-init-a1B2c3",
  "switch-init-ws2-a1B2c3",
  "init-registry-a1B2c3",
  "init-branch-fragment-a1B2c3",
  "mcp-ws-a1B2c3",
  "create-default-a1B2c3",
  "create-origin-a1B2c3",
];

it("lists the stale tokens, removes only them with --remove, and refuses a root with no workspaces", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tokens-cli-"));
  try {
    const root = path.join(home, "features");
    const tokens = path.join(home, ".werkmeister", "tokens");
    fs.mkdirSync(path.join(root, "live-ws"), { recursive: true });
    fs.mkdirSync(tokens, { recursive: true });
    for (const name of [...LEAKED, "live-ws"]) fs.writeFileSync(path.join(tokens, name), "t\n");
    const cfg = path.join(home, "config.yaml");
    fs.writeFileSync(cfg, `version: 1\npaths:\n  workspaces_root: ${root}\n`);
    const tokensCmd = (...args: string[]) =>
      run(process.execPath, [MAIN, "machine", "tokens", ...args], {
        env: { ...process.env, HOME: home, WERKMEISTER_CONFIG_FILE: cfg },
      });
    const before = fs.readdirSync(tokens).sort();

    const listed = (await tokensCmd()).stdout;
    expect(listed).toContain(`${LEAKED.length} stale token(s)`);
    for (const name of LEAKED) expect(listed).toContain(name);
    expect(fs.readdirSync(tokens).sort()).toEqual(before);

    expect((await tokensCmd("--remove")).stdout).toContain(`Removed ${LEAKED.length} token(s)`);
    expect(fs.readdirSync(tokens)).toEqual(["live-ws"]);

    fs.rmSync(path.join(root, "live-ws"), { recursive: true });
    await expect(tokensCmd("--remove")).rejects.toMatchObject({ code: 1 });
    expect(fs.readdirSync(tokens)).toEqual(["live-ws"]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
