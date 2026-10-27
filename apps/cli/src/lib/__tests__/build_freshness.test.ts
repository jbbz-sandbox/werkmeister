import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REBUILD_COMMAND, staleBuildWarning } from "../build_freshness.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "build-freshness-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    encoding: "utf8",
  }).trim();
}

function commit(repo: string): string {
  git(repo, "init", "-q");
  git(repo, "commit", "-q", "--allow-empty", "-m", "x");
  return git(repo, "rev-parse", "HEAD");
}

/** Commit *rel* (relative to *repo*) and return the new HEAD. */
function commitFile(repo: string, rel: string): string {
  git(repo, "init", "-q");
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), rel);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", rel);
  return git(repo, "rev-parse", "HEAD");
}

describe("staleBuildWarning", () => {
  it("is silent when the build matches HEAD", () => {
    const head = commit(tmp);
    expect(staleBuildWarning({ sha: head, dirty: true }, tmp)).toBeNull();
  });

  it("names both SHAs and the rebuild command when HEAD moved", () => {
    const head = commit(tmp);
    const old = "0123456789abcdef0123456789abcdef01234567";
    const warning = staleBuildWarning({ sha: old, dirty: true }, tmp);
    expect(warning).toContain("built from 0123456 (+uncommitted changes)");
    expect(warning).toContain(`is at ${head.slice(0, 7)}`);
    expect(warning).toContain(REBUILD_COMMAND);
  });

  // SW-128: turbo keys the build cache on the bundle's inputs, not HEAD, so a
  // docs-only commit replays a dist stamped with the older SHA.
  it("is silent when HEAD moved only outside the bundle's sources", () => {
    const built = commitFile(tmp, "apps/cli/src/main.ts");
    commitFile(tmp, "docs/guide.md");
    commitFile(tmp, "plugins/werkmeister/skills/x/SKILL.md");
    expect(staleBuildWarning({ sha: built, dirty: false }, tmp)).toBeNull();
  });

  it("warns when a bundled source changed since the build", () => {
    const built = commitFile(tmp, "apps/cli/src/main.ts");
    commitFile(tmp, "packages/werkmeister-core/src/lifecycle.ts");
    expect(staleBuildWarning({ sha: built, dirty: false }, tmp)).toContain("built from");
  });

  it("is silent outside a git checkout (a published install)", () => {
    expect(staleBuildWarning({ sha: "0123456", dirty: false }, tmp)).toBeNull();
  });

  it("is silent when the bundle carries no stamp", () => {
    commit(tmp);
    expect(staleBuildWarning(undefined, tmp)).toBeNull();
    expect(staleBuildWarning({ sha: "", dirty: false }, tmp)).toBeNull();
  });
});
