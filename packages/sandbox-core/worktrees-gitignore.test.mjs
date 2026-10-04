// `.env.<svc>` holds one service's resolved secrets (issue #100), so the
// workspace root's managed .gitignore must keep it out of the tracked repo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { writeWorkspaceGitignore } from "./dist/worktrees.js";

test("per-service secret env files are git-ignored at the workspace root", () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "wsgi-"));
  try {
    execFileSync("git", ["init", "-q", ws]);
    writeWorkspaceGitignore(ws, ["sandbox"]);
    const ignored = execFileSync("git", ["check-ignore", ".env", ".env.backend", ".env.auth-web"], {
      cwd: ws, encoding: "utf8",
    }).trim().split("\n");
    assert.deepEqual(ignored, [".env", ".env.backend", ".env.auth-web"]);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
