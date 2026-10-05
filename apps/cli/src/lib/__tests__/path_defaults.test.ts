/** Defaults offered by the `paths:` prompts (`sandbox config`, `sandbox setup`). */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

import { pathDefault } from "sandbox-core/global_config";

const saved = { ...process.env };

beforeEach(() => {
  delete process.env.SANDBOX_REPOS_ROOT;
  delete process.env.SANDBOX_WORKSPACES_ROOT;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("pathDefault", () => {
  it("prefers the stored value over the built-in", () => {
    const cfg = { paths: { repos_root: "/srv/repos", workspaces_root: "/srv/features" } };
    expect(pathDefault("repos_root", cfg)).toBe("/srv/repos");
    expect(pathDefault("workspaces_root", cfg)).toBe("/srv/features");
  });

  it("falls back to the exported env when nothing is stored", () => {
    process.env.SANDBOX_REPOS_ROOT = "/env/repos";
    expect(pathDefault("repos_root", {})).toBe("/env/repos");
  });

  it("derives the workspaces root from the repos root just answered", () => {
    // The bug: answering `/Users/x/code` still offered `~/workspace/features`.
    expect(pathDefault("workspaces_root", {}, { repos_root: "/Users/x/code" })).toBe(
      "/Users/x/code/features",
    );
  });

  it("uses the home-relative built-in when there is nothing to go on", () => {
    expect(pathDefault("repos_root", {})).toBe(path.join(os.homedir(), "workspace"));
    expect(pathDefault("workspaces_root", {})).toBe(
      path.join(os.homedir(), "workspace", "features"),
    );
  });
});
