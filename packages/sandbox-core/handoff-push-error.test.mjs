// A rejected handoff push must say *why*: git prints the remote URL first and
// the `! [rejected] ... (non-fast-forward)` line after it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectingReporter, withReporter } from "./dist/reporter.js";
import { commitAndPush } from "./dist/sandbox.js";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();

test("a non-fast-forward push reports the rejected line, not the remote URL", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "push-"));
  const origin = path.join(tmp, "origin.git");
  git(tmp, "init", "--bare", "-b", "main", origin);
  const clone = (name) => { const d = path.join(tmp, name); git(tmp, "clone", "-q", origin, d); return d; };
  const a = clone("a");
  fs.writeFileSync(path.join(a, "f"), "1"); git(a, "add", "f"); git(a, "commit", "-qm", "base"); git(a, "push", "-q", "origin", "main");
  const b = clone("b");
  for (const [d, txt] of [[a, "from a"], [b, "from b"]]) {
    git(d, "checkout", "-qb", "u/ws"); fs.writeFileSync(path.join(d, "g"), txt); git(d, "add", "g"); git(d, "commit", "-qm", txt);
  }
  git(b, "push", "-q", "origin", "u/ws");

  const r = await withReporter(collectingReporter(), () => commitAndPush(a));
  assert.equal(r.ok, false);
  assert.match(r.message, /^a: push failed — ! \[rejected\] u\/ws -> u\/ws \((fetch first|non-fast-forward)\)$/);
});
