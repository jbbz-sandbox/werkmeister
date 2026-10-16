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

function commit(repo: string): string {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "x");
  return git("rev-parse", "HEAD");
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

  it("is silent outside a git checkout (a published install)", () => {
    expect(staleBuildWarning({ sha: "0123456", dirty: false }, tmp)).toBeNull();
  });

  it("is silent when the bundle carries no stamp", () => {
    commit(tmp);
    expect(staleBuildWarning(undefined, tmp)).toBeNull();
    expect(staleBuildWarning({ sha: "", dirty: false }, tmp)).toBeNull();
  });
});
