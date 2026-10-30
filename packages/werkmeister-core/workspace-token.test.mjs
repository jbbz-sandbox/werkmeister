// SW-184: a workspace's daemon token lives on the host (~/.werkmeister/tokens/<name>)
// and in the workspace (.werkmeister/token, for a container that mounts it).
// os.homedir() honours HOME, so each test gets its own.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const { mintWorkspaceToken, revokeWorkspaceToken, tokensDir, workspaceTokenFile } = await import(
  "./dist/workspace_token.js"
);

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
