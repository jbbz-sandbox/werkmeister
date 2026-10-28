/** the `config` command. */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as YAML from "yaml";

// Stub the two side-effecting projections so the unit test never touches the
// real ~/.zshenv or the Desktop config.
vi.mock("werkmeister-core/global_config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("werkmeister-core/global_config")>();
  return { ...actual, ensureZshenvSources: () => false, patchDesktopConfig: () => false };
});

import * as gc from "werkmeister-core/global_config";
import { run } from "../../commands/config.js";
import { getSandboxRoot } from "../config.js";

let tmp: string;
let cfgFile: string;

function args(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { repos_root: null, workspaces_root: null, show: false, check: false, ...overrides };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfg-"));
  cfgFile = path.join(tmp, "config.yaml");
  process.env.WERKMEISTER_CONFIG_FILE = cfgFile;
});
afterEach(() => {
  delete process.env.WERKMEISTER_CONFIG_FILE;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("config command", () => {
  it("non-interactive flags write yaml and env.sh", async () => {
    const repos = path.join(tmp, "repos");
    const ws = path.join(tmp, "ws");
    fs.mkdirSync(repos);
    fs.mkdirSync(ws);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run(args({ repos_root: repos, workspaces_root: ws }));

    const saved = YAML.parse(fs.readFileSync(cfgFile, "utf8"));
    expect(saved.paths.repos_root).toBe(repos);
    expect(saved.paths.workspaces_root).toBe(ws);
    // werkmeister_root is self-derived, not taken from a flag.
    expect(saved.paths.werkmeister_root).toBe(String(getSandboxRoot()));

    const envSh = gc.envShPath();
    expect(fs.existsSync(envSh)).toBe(true);
    // tmp paths only contain shlex-safe chars, so they render unquoted.
    expect(fs.readFileSync(envSh, "utf8")).toContain(`export WERKMEISTER_REPOS_ROOT=${repos}`);
  });

  it("check exit codes: no config → drift → exit(1)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    await expect(run(args({ check: true }))).rejects.toThrow("exit:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("preserves the sections it never prompts for", async () => {
    // Regression: `sandbox config` rebuilds the YAML from scratch, so any
    // section it doesn't know about gets dropped. `ingress:` (owned by
    // `sandbox setup`) and `jira:` (hand-pasted) must both survive a run.
    const repos = path.join(tmp, "repos");
    const ws = path.join(tmp, "ws");
    fs.mkdirSync(repos);
    fs.mkdirSync(ws);
    gc.save({
      paths: { repos_root: repos, workspaces_root: ws },
      ingress: { local_domain: "keep.me.test", certs_dir: "/custom/certs" },
      jira: { base_url: "https://x.atlassian.net", email: "a@b.c", api_token: "tok" },
      overrides: { services_yaml: "/custom/services.yaml" },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await run(args({ repos_root: repos, workspaces_root: ws }));

    const saved = YAML.parse(fs.readFileSync(cfgFile, "utf8"));
    expect(saved.ingress.local_domain).toBe("keep.me.test");
    expect(saved.ingress.certs_dir).toBe("/custom/certs");
    expect(saved.jira.api_token).toBe("tok");
    expect(saved.overrides.services_yaml).toBe("/custom/services.yaml");
  });

  it("no arguments prints the config and writes nothing", async () => {
    // Regression (SW-136): the bare form used to rebuild config.yaml, env.sh,
    // ~/.zshenv and the Desktop config from defaults.
    gc.save({ paths: { repos_root: "/custom/repos" } });
    const before = fs.readFileSync(cfgFile, "utf8");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    const zsh = vi.spyOn(gc, "ensureZshenvSources");
    const desktop = vi.spyOn(gc, "patchDesktopConfig");

    await run(args());

    expect(fs.readFileSync(cfgFile, "utf8")).toBe(before);
    expect(fs.existsSync(gc.envShPath())).toBe(false);
    expect(zsh).not.toHaveBeenCalled();
    expect(desktop).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("/custom/repos");
  });

  it("show reports origin", async () => {
    gc.save({ paths: { repos_root: "/custom/repos" } });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    await run(args({ show: true }));
    const out = logs.join("\n");
    expect(out).toContain("/custom/repos");
    expect(out).toContain("(YAML)"); // repos_root came from YAML
    expect(out).toContain("(default)"); // workspaces_root fell back to default
  });
});
