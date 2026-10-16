/**
 * `overrides.workspace_repo` / `overrides.github_org` — the two GitHub
 * locations `sandbox setup` configures.
 *
 * Neither has a built-in owner any more: the sandbox is run by whichever org
 * installs it, so an unconfigured machine must resolve to nothing rather than
 * to someone else's account.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as gc from "sandbox-core/global_config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gh-cfg-"));
  process.env.SANDBOX_CONFIG_FILE = path.join(tmp, "config.yaml");
});
afterEach(() => {
  delete process.env.SANDBOX_CONFIG_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadWorkspaceRepo", () => {
  it("is empty on an unconfigured machine", () => {
    expect(gc.loadWorkspaceRepo()).toBe("");
  });

  it("reads overrides.workspace_repo", () => {
    gc.save({ overrides: { workspace_repo: " acme/sandbox-workspace " } });
    expect(gc.loadWorkspaceRepo()).toBe("acme/sandbox-workspace");
  });
});

describe("loadGithubOrg", () => {
  it("falls back to the workspace repo's owner", () => {
    gc.save({ overrides: { workspace_repo: "acme/sandbox-workspace" } });
    expect(gc.loadGithubOrg()).toBe("acme");
  });

  it("prefers an explicit github_org — the service repos may live elsewhere", () => {
    gc.save({ overrides: { workspace_repo: "octocat/sandbox-workspace", github_org: "acme" } });
    expect(gc.loadGithubOrg()).toBe("acme");
  });

  it("is empty when neither is set, so callers link nothing rather than guess", () => {
    expect(gc.loadGithubOrg()).toBe("");
  });
});
