// SW-184: a workspace's daemon token lives on the host (~/.werkmeister/tokens/<name>)
// and in the workspace (.werkmeister/token, for a container that mounts it).
// os.homedir() honours HOME, so each test gets its own.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const { mintWorkspaceToken, revokeWorkspaceToken, staleTokens, tokensDir, workspaceTokenFile } =
  await import("./dist/workspace_token.js");

function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ws-token-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    process.env.HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("mint writes the same token to the host and the workspace, both 0600", () => {
  withHome((home) => {
    const ws = path.join(home, "features", "proj-a");
    const token = mintWorkspaceToken("proj-a", ws);
    assert.match(token, /^[0-9a-f]{64}$/);
    for (const file of [path.join(tokensDir(), "proj-a"), workspaceTokenFile(ws)]) {
      assert.equal(fs.readFileSync(file, "utf8").trim(), token, file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, file);
    }
  });
});

test("re-minting keeps the token, and restores a deleted workspace copy", () => {
  withHome((home) => {
    const ws = path.join(home, "proj-a");
    const token = mintWorkspaceToken("proj-a", ws);
    fs.rmSync(workspaceTokenFile(ws));
    assert.equal(mintWorkspaceToken("proj-a", ws), token);
    assert.equal(fs.readFileSync(workspaceTokenFile(ws), "utf8").trim(), token);
  });
});

test("revoke deletes the host copy, so the daemon no longer knows the token", () => {
  withHome((home) => {
    mintWorkspaceToken("proj-a", path.join(home, "proj-a"));
    revokeWorkspaceToken("proj-a");
    assert.equal(fs.existsSync(path.join(tokensDir(), "proj-a")), false);
    revokeWorkspaceToken("proj-a"); // idempotent
  });
});

// SW-433: withSandboxHome left HOME real, so a core test run outside with-temp-home wrote here.
test("withSandboxHome moves ~ under its temp home, and puts it back", async () => {
  const { withSandboxHome } = await import("./fixtures.mjs");
  const before = process.env.HOME;
  await withSandboxHome((home) => {
    assert.ok(tokensDir().startsWith(home + path.sep), `${tokensDir()} is under ${home}`);
  });
  assert.equal(process.env.HOME, before);
});

// SW-446: tokens leaked before SW-433, one per prefix the core tests used, plus a live workspace.
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

function seed(home) {
  const root = path.join(home, "features");
  fs.mkdirSync(path.join(root, "live-ws"), { recursive: true });
  for (const name of [...LEAKED, "live-ws"]) mintWorkspaceToken(name, path.join(root, name));
  fs.rmSync(path.join(root, "live-ws", ".werkmeister"), { recursive: true });
  for (const name of LEAKED) fs.rmSync(path.join(root, name), { recursive: true, force: true });
  return root;
}

test("staleTokens lists every leaked prefix and not the live workspace", () => {
  withHome((home) => {
    const root = seed(home);
    assert.deepEqual(staleTokens(root), [...LEAKED].sort());
  });
});

test("staleTokens: no tokens folder is empty; an unreadable root throws", () => {
  withHome((home) => {
    fs.mkdirSync(path.join(home, "features"));
    assert.deepEqual(staleTokens(path.join(home, "features")), []);
    mintWorkspaceToken("x", path.join(home, "x"));
    assert.throws(() => staleTokens(path.join(home, "missing")));
    assert.throws(() => staleTokens(path.join(home, "features")), /no workspace folders/);
  });
});

test("machine tokens lists without --remove, deletes the stale ones with it", async () => {
  const { execFileSync } = await import("node:child_process");
  const main = new URL("../../apps/cli/dist/main.js", import.meta.url).pathname;
  withHome((home) => {
    const root = seed(home);
    const cfg = path.join(home, "config.yaml");
    fs.writeFileSync(cfg, `version: 1\npaths:\n  workspaces_root: ${root}\n`);
    const run = (...args) =>
      execFileSync(process.execPath, [main, "machine", "tokens", ...args], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, WERKMEISTER_CONFIG_FILE: cfg },
      });
    const before = fs.readdirSync(tokensDir()).sort();

    const listed = run();
    assert.match(listed, new RegExp(`${LEAKED.length} stale token\\(s\\)`));
    for (const name of LEAKED) assert.ok(listed.includes(name), name);
    assert.deepEqual(fs.readdirSync(tokensDir()).sort(), before);

    assert.match(run("--remove"), new RegExp(`Removed ${LEAKED.length} token\\(s\\)`));
    assert.deepEqual(fs.readdirSync(tokensDir()), ["live-ws"]);
  });
});
