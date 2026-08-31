/** Jira creds in the global config: `jira:` section + the `sandbox setup` report. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";

// The config command projects onto ~/.zshenv and the Claude Desktop config;
// stub both so this unit test never touches the real ones.
vi.mock("sandbox-core/global_config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sandbox-core/global_config")>();
  return { ...actual, ensureZshenvSources: () => false, patchDesktopConfig: () => false };
});

import { run as runConfig } from "../../commands/config.js";
import * as gc from "sandbox-core/global_config";
import { syncJiraToken } from "sandbox-core/machine_setup";

const FILLED = {
  base_url: "https://hgdata.atlassian.net/",
  email: "dev@hginsights.com",
  api_token: "real-token",
};

let tmp: string;
let cfgFile: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jira-cfg-"));
  cfgFile = path.join(tmp, "config.yaml");
  process.env.SANDBOX_CONFIG_FILE = cfgFile;
});
afterEach(() => {
  delete process.env.SANDBOX_CONFIG_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("loadJira", () => {
  it("reads the jira section; missing file or section → {}", () => {
    expect(gc.loadJira()).toEqual({});

    gc.save({ version: 1, paths: {}, jira: FILLED });
    expect(gc.loadJira()).toEqual(FILLED);
  });

  it("save() locks the file down — it holds a live token", () => {
    fs.writeFileSync(cfgFile, "version: 1\n"); // pre-existing 0644 file
    gc.save({ version: 1, jira: FILLED });
    expect(fs.statSync(cfgFile).mode & 0o777).toBe(0o600);
  });
});

describe("sandbox config rewrite", () => {
  it("preserves a hand-pasted jira section", async () => {
    const repos = path.join(tmp, "repos");
    fs.mkdirSync(repos);
    gc.save({ version: 1, paths: { repos_root: repos }, jira: FILLED });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await runConfig({ repos_root: repos, workspaces_root: repos, show: false, check: false });

    expect(YAML.parse(fs.readFileSync(cfgFile, "utf8")).jira).toEqual(FILLED);
  });
});

describe("syncJiraToken", () => {
  const stepFor = async (jira: Parameters<typeof syncJiraToken>[0], verifier?: any) =>
    (await syncJiraToken(jira, false, verifier))[0];

  it("absent or placeholder values are ok-with-guidance, never a failure", async () => {
    const empty = await stepFor({});
    expect(empty.ok).toBe(true);
    expect(empty.detail).toContain("jira.base_url");
    expect(empty.detail).toContain("jira.api_token");

    const placeholder = await stepFor({ ...FILLED, api_token: "PASTE_TOKEN_HERE" });
    expect(placeholder.ok).toBe(true);
    expect(placeholder.detail).toContain("jira.api_token");
  });

  it("filled creds reach the verifier with the yaml keys", async () => {
    let seen: unknown = null;
    const step = await stepFor(FILLED, (jira: unknown) => {
      seen = jira;
      return [true, "authenticated as Dev"] as [boolean, string];
    });
    expect(seen).toEqual(FILLED);
    expect(step).toMatchObject({ ok: true, detail: "authenticated as Dev" });
  });

  it("a rejected token is the only failure mode", async () => {
    const step = await stepFor(FILLED, () => [false, "HTTP 401"] as [boolean, string]);
    expect(step.ok).toBe(false);
    expect(step.detail).toContain("HTTP 401");
    expect(step.detail).toContain(cfgFile);
  });

  it("check-only skips the network and names the account", async () => {
    const verifier = vi.fn();
    const steps = await syncJiraToken(FILLED, true, verifier as any);
    expect(verifier).not.toHaveBeenCalled();
    expect(steps[0]).toMatchObject({ ok: true });
    expect(steps[0].detail).toContain(FILLED.email);
  });
});
