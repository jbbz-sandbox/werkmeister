/**
 * The `sandbox setup` steps that write to (or probe) the machine.
 *
 * Every step here is designed to be safe to re-run, and that is mostly what
 * these tests pin: seeding must never clobber a hand-edited registry, and the
 * optional steps must not fail a setup run just by being unconfigured.
 *
 * All subprocess boundaries are injected, so nothing shells out to brew,
 * openssl or sudo.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

import {
  defaultWorkspaceRepo,
  DEMO_SERVICES_REPO,
  DEMO_SERVICES_REPO_URL,
  githubOwners,
  OPTIONAL_PLUGINS,
  resolveCertScript,
  runSetup,
  syncEditorSchemas,
  syncIngressCerts,
  syncOptionalPlugin,
  syncPathDirs,
  syncRegistryConfigs,
  syncRepo,
  syncTelepresence,
  WORKSPACE_ROOT_REPO,
  type Runner,
  type Step,
} from "sandbox-core/machine_setup";
import { REGISTRY_DEFAULTS, renderSecretsEnv, renderServicesLocalYaml } from "sandbox-core/scaffold";
import { requiredSecretKeys, validateRequiredSecrets } from "sandbox-core/secrets";
import { useSandboxHome, type SandboxHome } from "./helpers/sandbox_home.js";

let home: SandboxHome;

beforeEach(() => {
  home = useSandboxHome({ fixtures: [] });
});
afterEach(() => {
  home.cleanup();
});

const detail = (steps: Step[], label: string): string =>
  steps.find((s) => s.label === label)?.detail ?? "";

/** A runner returning canned [code, output] per command prefix. */
function fakeRunner(table: Record<string, [number, string]>): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner = ((cmd: string[]) => {
    calls.push(cmd);
    for (const [prefix, result] of Object.entries(table)) {
      if (cmd.join(" ").startsWith(prefix)) return result;
    }
    return [127, "command not found"] as [number, string];
  }) as Runner & { calls: string[][] };
  runner.calls = calls;
  return runner;
}

describe("syncRegistryConfigs", () => {
  it("creates every registry file on a fresh machine — services.yaml is generated elsewhere", () => {
    const steps = syncRegistryConfigs(false, { legacyDir: null });
    expect(steps.every((s) => s.ok)).toBe(true);
    for (const name of ["services.local.yaml", "ports.yaml", "model-pricing.yaml", "secrets.env"]) {
      expect(fs.existsSync(path.join(home.dir, name)), `${name} not created`).toBe(true);
    }
    expect(fs.existsSync(path.join(home.dir, "services.yaml"))).toBe(false);
  });

  it("never overwrites an existing file — hand edits survive a re-run", () => {
    home.write("services.local.yaml", "k8s_context: hand-edited\n");
    const steps = syncRegistryConfigs(false, { legacyDir: null, k8sContext: "orbstack" });
    expect(fs.readFileSync(path.join(home.dir, "services.local.yaml"), "utf8")).toContain("hand-edited");
    expect(detail(steps, "config services.local.yaml")).toContain("present");
  });

  it("writes the wizard's k8s_context into a fresh services.local.yaml", () => {
    syncRegistryConfigs(false, { legacyDir: null, k8sContext: "kind-dev" });
    expect(fs.readFileSync(path.join(home.dir, "services.local.yaml"), "utf8")).toContain("k8s_context: kind-dev");
  });

  it("migrates a legacy infra/config checkout instead of scaffolding", () => {
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-"));
    fs.writeFileSync(path.join(legacy, "ports.yaml"), "feature_slots:\n  count: 3\n");
    try {
      const steps = syncRegistryConfigs(false, { legacyDir: legacy });
      expect(detail(steps, "config ports.yaml")).toContain("migrated");
      expect(fs.readFileSync(path.join(home.dir, "ports.yaml"), "utf8")).toContain("count: 3");
      // Copied, not moved — the old checkout may still need it.
      expect(fs.existsSync(path.join(legacy, "ports.yaml"))).toBe(true);
    } finally {
      fs.rmSync(legacy, { recursive: true, force: true });
    }
  });

  it("writes nothing in check mode and reports the missing files", () => {
    const steps = syncRegistryConfigs(true, { legacyDir: null });
    expect(fs.existsSync(path.join(home.dir, "services.local.yaml"))).toBe(false);
    expect(steps.find((s) => s.label === "config services.local.yaml")?.ok).toBe(false);
    // secrets.env is a convenience, not a prerequisite — absence is not failure.
    expect(steps.find((s) => s.label === "config secrets.env")?.ok).toBe(true);
  });

  it("seeds secrets.env owner-only — it holds live credentials once filled in", () => {
    syncRegistryConfigs(false, { legacyDir: null });
    const mode = fs.statSync(path.join(home.dir, "secrets.env")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("scaffold content", () => {
  it("seeds an empty secrets template -- required keys come from each service's own secrets: list", () => {
    const text = renderSecretsEnv();
    expect(text).not.toMatch(/^[A-Z_]+=/m);
  });

  it("ships every archetype the self-host and demo fragments reference", () => {
    expect(Object.keys(REGISTRY_DEFAULTS.archetypes)).toEqual(["node-web", "node-service", "node-tool", "mcp-client"]);
    expect(Object.keys(REGISTRY_DEFAULTS.mcp_servers)).toEqual(["context7", "sandbox"]);
  });

  it("renders a parseable services.local.yaml carrying only k8s_context", () => {
    const text = renderServicesLocalYaml("kind-dev");
    // Comments may show an example `services:` block; the DATA is only k8s_context.
    expect(parseYaml(text)).toEqual({ k8s_context: "kind-dev" });
  });
});

describe("requiredSecretKeys", () => {
  const servicesConfig = {
    "backend": {},
    "auth-web": { secrets: ["AUTH0_CLIENT_SECRET", "NEXTAUTH_SECRET"] },
  };

  it("is empty for a workspace whose services declare no secrets", () => {
    expect(requiredSecretKeys(servicesConfig, ["backend"])).toEqual([]);
  });

  it("only requires the keys declared by services actually in the workspace", () => {
    expect(requiredSecretKeys(servicesConfig, ["backend", "auth-web"])).toEqual([
      "AUTH0_CLIENT_SECRET",
      "NEXTAUTH_SECRET",
    ]);
  });

  it("validateRequiredSecrets reports only missing/empty declared keys", () => {
    const required = requiredSecretKeys(servicesConfig, ["auth-web"]);
    const missing = validateRequiredSecrets({ AUTH0_CLIENT_SECRET: "abc123" }, required);
    expect(missing).toEqual(["NEXTAUTH_SECRET"]);
  });
});

describe("syncPathDirs", () => {
  it("creates the directories the wizard just configured", () => {
    // Regression: setup prompted for these paths and then its own --check
    // reported them as drift, because nothing ever created them.
    const target = path.join(home.dir, "features");
    const steps = syncPathDirs(false, { workspaces_root: target });
    expect(steps[0].ok).toBe(true);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it("creates nothing in check mode", () => {
    const target = path.join(home.dir, "features");
    const steps = syncPathDirs(true, { workspaces_root: target });
    expect(steps[0].ok).toBe(false);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("fails when the path exists as a file", () => {
    const target = path.join(home.dir, "not-a-dir");
    fs.writeFileSync(target, "");
    expect(syncPathDirs(false, { repos_root: target })[0].ok).toBe(false);
  });

  it("ignores unset keys", () => {
    expect(syncPathDirs(false, {})).toEqual([]);
  });
});

describe("resolveCertScript", () => {
  it("finds the script inside the CLI package — the layout an npm install has", () => {
    // The published package is apps/cli alone: there is no monorepo above it to
    // walk up into, so bin/ has to resolve at the package root or `sandbox
    // setup` cannot issue a certificate on an installed CLI.
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-"));
    try {
      fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
      const script = path.join(pkg, "bin", "generate-certs.sh");
      fs.writeFileSync(script, "#!/bin/bash\n");
      expect(resolveCertScript(pkg)).toBe(script);
    } finally {
      fs.rmSync(pkg, { recursive: true, force: true });
    }
  });

  it("still walks up when bin/ sits above the CLI package", () => {
    // Kept from when bin/ lived at the monorepo root: the walk-up is what makes
    // the move above backward-compatible with an older checkout.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "monorepo-"));
    try {
      fs.mkdirSync(path.join(root, "bin"), { recursive: true });
      fs.writeFileSync(path.join(root, "bin", "generate-certs.sh"), "#!/bin/bash\n");
      const cliRoot = path.join(root, "apps", "cli");
      fs.mkdirSync(cliRoot, { recursive: true });
      expect(resolveCertScript(cliRoot)).toBe(path.join(root, "bin", "generate-certs.sh"));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null rather than a bogus path when there is no script", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "noscript-"));
    try {
      expect(resolveCertScript(empty)).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("syncIngressCerts", () => {
  it("skips cleanly when no service is routed", () => {
    const steps = syncIngressCerts(false, { hostnames: [] }, () => 0);
    expect(steps[0].ok).toBe(true);
    expect(steps[0].detail).toContain("no routed services");
  });

  it("passes every hostname to the generator as a --domain flag", () => {
    const script = path.join(home.dir, "generate-certs.sh");
    fs.writeFileSync(script, "#!/bin/bash\n");
    let received: string[] = [];
    const steps = syncIngressCerts(
      false,
      { hostnames: ["a.local.test", "b.local.test"], scriptPath: script },
      (cmd) => {
        received = cmd;
        return 0;
      },
    );
    expect(steps[0].ok).toBe(true);
    expect(received).toContain("--domain");
    expect(received).toContain("a.local.test");
    expect(received).toContain("b.local.test");
  });

  it("suppresses the sudo-requiring steps when asked", () => {
    const script = path.join(home.dir, "generate-certs.sh");
    fs.writeFileSync(script, "#!/bin/bash\n");
    let received: string[] = [];
    syncIngressCerts(
      false,
      { hostnames: ["a.local.test"], scriptPath: script, skipSudo: true },
      (cmd) => {
        received = cmd;
        return 0;
      },
    );
    expect(received).toContain("--no-trust");
    expect(received).toContain("--no-hosts");
  });

  it("fails the step when the generator errors", () => {
    const script = path.join(home.dir, "generate-certs.sh");
    fs.writeFileSync(script, "#!/bin/bash\n");
    const steps = syncIngressCerts(
      false,
      { hostnames: ["a.local.test"], scriptPath: script },
      () => 1,
    );
    expect(steps[0].ok).toBe(false);
  });
});

describe("syncOptionalPlugin", () => {
  const SPEC = OPTIONAL_PLUGINS.find((p) => p.name === "superpowers")!;
  const LABEL = "plugin superpowers (optional)";

  /** A plugins dir where *spec* is registered as installed at *version*. */
  function pluginsDir(installed: boolean): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-"));
    fs.writeFileSync(
      path.join(dir, "known_marketplaces.json"),
      JSON.stringify(installed ? { [SPEC.marketplace]: { source: SPEC.source } } : {}),
    );
    fs.writeFileSync(
      path.join(dir, "installed_plugins.json"),
      JSON.stringify(
        installed
          ? { plugins: { [`${SPEC.name}@${SPEC.marketplace}`]: [{ version: "1.2.3", installPath: dir }] } }
          : { plugins: {} },
      ),
    );
    return dir;
  }

  it("reports absent-and-unwanted as ok — declining must not fail --check", () => {
    const runner = fakeRunner({});
    const steps = syncOptionalPlugin(SPEC, pluginsDir(false), runner, false, false);
    expect(steps[0].ok).toBe(true);
    expect(steps[0].detail).toContain("not installed");
    expect(runner.calls).toEqual([]);
  });

  it("never installs in check mode, even when asked to", () => {
    const runner = fakeRunner({});
    syncOptionalPlugin(SPEC, pluginsDir(false), runner, true, true);
    expect(runner.calls.some((c) => c[0] === "claude")).toBe(false);
  });

  it("adds the marketplace and installs when the wizard said yes", () => {
    const runner = fakeRunner({
      "claude plugin marketplace add": [0, ""],
      "claude plugin install": [0, ""],
    });
    const steps = syncOptionalPlugin(SPEC, pluginsDir(false), runner, false, true);
    const joined = runner.calls.map((c) => c.join(" "));
    expect(joined).toContain(`claude plugin marketplace add ${SPEC.source}`);
    expect(joined).toContain(`claude plugin install ${SPEC.name}@${SPEC.marketplace}`);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(steps.every((s) => s.label === LABEL)).toBe(true);
  });

  it("keeps an already-installed plugin current even without a fresh yes", () => {
    const runner = fakeRunner({
      "claude plugin marketplace update": [0, ""],
      "claude plugin update": [0, ""],
    });
    const steps = syncOptionalPlugin(SPEC, pluginsDir(true), runner, false, false);
    expect(runner.calls.map((c) => c.join(" "))).toContain(
      `claude plugin update ${SPEC.name}@${SPEC.marketplace}`,
    );
    expect(steps.some((s) => s.detail.includes("1.2.3"))).toBe(true);
  });

  it("marks a failed install optional so it warns instead of failing the run", () => {
    const runner = fakeRunner({
      "claude plugin marketplace add": [0, ""],
      "claude plugin install": [1, "network unreachable"],
    });
    const steps = syncOptionalPlugin(SPEC, pluginsDir(false), runner, false, true);
    const failure = steps.find((s) => !s.ok)!;
    expect(failure.optional).toBe(true);
    expect(failure.detail).toContain("network unreachable");
  });
});

describe("syncTelepresence", () => {
  const CURRENT = { "telepresence version": [0, "OSS Client: v2.30.1"] as [number, string] };
  const STALE = { "telepresence version": [0, "OSS Client: v2.19.0"] as [number, string] };
  const ABSENT = {};

  it("reports a current client as ok", () => {
    const steps = syncTelepresence(fakeRunner(CURRENT), false);
    expect(steps[0].ok).toBe(true);
    expect(steps[0].detail).toContain("2.30.1");
  });

  it("treats absence as ok — only `sandbox intercept` needs it", () => {
    const steps = syncTelepresence(fakeRunner(ABSENT), false);
    expect(steps[0].ok).toBe(true);
    expect(steps[0].detail).toContain("not installed");
  });

  it("fails on an installed-but-stale client, which misbehaves rather than degrades", () => {
    const steps = syncTelepresence(fakeRunner(STALE), false);
    expect(steps[0].ok).toBe(false);
    expect(steps[0].detail).toContain("2.19.0");
  });

  it("never installs in check mode, even when asked to", () => {
    const runner = fakeRunner(ABSENT);
    syncTelepresence(runner, true, { install: true });
    expect(runner.calls.some((c) => c[0] === "brew")).toBe(false);
  });

  it("installs via the upstream tap when asked, then verifies the result", () => {
    let installed = false;
    const runner = ((cmd: string[]) => {
      const line = cmd.join(" ");
      if (line === "telepresence version") {
        return installed ? [0, "OSS Client: v2.31.0"] : [127, "not found"];
      }
      if (line === "brew --version") return [0, "Homebrew 4.0"];
      if (line.startsWith("brew install")) {
        installed = true;
        return [0, ""];
      }
      return [127, ""];
    }) as Runner;

    const steps = syncTelepresence(runner, false, { install: true });
    expect(steps[0].ok).toBe(true);
    expect(steps[0].detail).toContain("2.31.0");
  });

  it("fails loudly when brew's formula is still below the minimum", () => {
    // The exact trap that made an earlier iteration reject brew outright: a tap
    // can report success and leave you on a version intercept can't use.
    const runner = ((cmd: string[]) => {
      const line = cmd.join(" ");
      if (line === "telepresence version") return [0, "OSS Client: v2.19.0"];
      if (line === "brew --version") return [0, "Homebrew 4.0"];
      if (line.startsWith("brew upgrade")) return [0, ""];
      return [127, ""];
    }) as Runner;

    const steps = syncTelepresence(runner, false, { install: true });
    expect(steps[0].ok).toBe(false);
    expect(steps[0].detail).toContain("still <");
  });

  it("falls back to the direct download when Homebrew is absent", () => {
    const runner = fakeRunner({ "telepresence version": [127, "not found"] });
    const steps = syncTelepresence(runner, false, { install: true });
    expect(steps[0].detail).toContain("Homebrew not found");
  });

  it("marks every failure optional — a broken brew must not fail machine setup", () => {
    // Regression: an unwritable Homebrew (or any environmental install failure)
    // used to make `sandbox setup` exit 1 over a prerequisite documented as
    // optional and needed only by `sandbox intercept`.
    const runner = ((cmd: string[]) => {
      const line = cmd.join(" ");
      if (line === "telepresence version") return [127, "not found"];
      if (line === "brew --version") return [0, "Homebrew 4.0"];
      if (line.startsWith("brew install")) {
        return [1, "Error: /usr/local/Homebrew is not writable.\n✔︎ JSON API"];
      }
      return [127, ""];
    }) as Runner;

    const steps = syncTelepresence(runner, false, { install: true });
    expect(steps[0].ok).toBe(false);
    expect(steps[0].optional).toBe(true);
    // The useful line survives; the progress-spinner noise does not.
    expect(steps[0].detail).toContain("not writable");
    expect(steps[0].detail).not.toContain("✔︎");
  });
});

describe("severity", () => {
  it("keeps optional failures out of the exit-code count", () => {
    // The rule commands/setup.ts applies: only `!ok && !optional` fails a run.
    const steps: Step[] = [
      { label: "a", ok: true, detail: "" },
      { label: "b", ok: false, detail: "", optional: true },
      { label: "c", ok: false, detail: "" },
    ];
    expect(steps.filter((s) => !s.ok && !s.optional)).toHaveLength(1);
    expect(steps.filter((s) => !s.ok && s.optional)).toHaveLength(1);
  });
});

describe("syncRepo", () => {
  const spec = {
    name: DEMO_SERVICES_REPO,
    url: DEMO_SERVICES_REPO_URL,
    missingConsequence: "The demo backend/frontend services will not start until it is cloned there.",
  };

  it("clones the spec's own url, not a hardcoded one", () => {
    // Regression guard for the generalization: this used to be
    // syncWorkspaceRepo with the workspace repo's URL baked into the body, so
    // a second repo would have silently cloned the wrong thing.
    const runner = fakeRunner({ "git clone": [0, ""] });
    const steps = syncRepo(home.dir, spec, runner, false);
    expect(steps[0].ok).toBe(true);
    expect(runner.calls[0]).toEqual([
      "git", "clone", DEMO_SERVICES_REPO_URL, path.join(home.dir, DEMO_SERVICES_REPO),
    ]);
  });

  it("clones nothing in check mode", () => {
    const runner = fakeRunner({ "git clone": [0, ""] });
    const steps = syncRepo(home.dir, spec, runner, true);
    expect(steps[0].ok).toBe(false);
    expect(runner.calls).toEqual([]);
  });

  it("explains an unreachable remote with this spec's consequence", () => {
    const runner = fakeRunner({ "git clone": [128, "ERROR: Repository not found."] });
    const steps = syncRepo(home.dir, spec, runner, false);
    expect(steps[0].ok).toBe(false);
    // Optional: a missing demo repo must never fail the whole setup run.
    expect(steps[0].optional).toBe(true);
    expect(steps[0].detail).toContain("demo backend/frontend services will not start");
    expect(steps[0].detail).not.toContain("plain directories");
  });
});

describe("workspace repo", () => {
  const label = `repo ${WORKSPACE_ROOT_REPO}`;

  it("defaults to the authenticated GitHub user's own repo", () => {
    const runner = fakeRunner({ "gh api user": [0, "octocat\n"] });
    expect(defaultWorkspaceRepo(runner)).toBe(`octocat/${WORKSPACE_ROOT_REPO}`);
  });

  it("resolves nothing when gh is absent or logged out", () => {
    expect(defaultWorkspaceRepo(fakeRunner({}))).toBe("");
    expect(defaultWorkspaceRepo(fakeRunner({ "gh api": [1, "gh: not logged in"] }))).toBe("");
    expect(githubOwners(fakeRunner({}))).toEqual([]);
  });

  it("offers the personal account first, then the orgs gh reports", () => {
    const runner = fakeRunner({
      "gh api user/orgs": [0, "acme\nwidgets\nocto cat\n"], // the invalid login is dropped
      "gh api user": [0, "octocat\n"],
    });
    expect(githubOwners(runner)).toEqual(["octocat", "acme", "widgets"]);
  });

  it("still offers the personal account when the org lookup fails", () => {
    const runner = fakeRunner({
      "gh api user/orgs": [1, "HTTP 403: missing read:org scope"],
      "gh api user": [0, "octocat"],
    });
    expect(githubOwners(runner)).toEqual(["octocat"]);
  });

  it("clones the configured owner's repo", async () => {
    const runner = fakeRunner({ "git clone": [0, ""] });
    const steps = await runSetup({
      reposRoot: home.dir,
      runner,
      workspaceRepo: "acme/sandbox-workspace",
      hostnames: [],
      jira: null,
      pathDirs: {},
    });
    expect(steps.find((s) => s.label === label)?.ok).toBe(true);
    expect(runner.calls).toContainEqual([
      "git", "clone", "https://github.com/acme/sandbox-workspace.git",
      path.join(home.dir, WORKSPACE_ROOT_REPO),
    ]);
  });

  it("warns rather than guessing when no repo can be resolved", async () => {
    const steps = await runSetup({
      checkOnly: true,
      reposRoot: home.dir,
      runner: fakeRunner({}), // no gh, and the temp config names no repo
      hostnames: [],
      jira: null,
      pathDirs: {},
    });
    const step = steps.find((s) => s.label === label)!;
    expect([step.ok, step.optional]).toEqual([false, true]);
    expect(step.detail).toContain("overrides.workspace_repo");
  });
});

describe("demo-services clone gating and registry ordering", () => {
  // Gated on the wizard's answer OR on-disk presence: the registry is
  // generated AFTER the clones now, so it cannot be the gate any more, and a
  // `--check` run (no answers) must still report a repo that is already there.
  const runSetupNow = (demo = false) =>
    runSetup({
      checkOnly: true,
      reposRoot: home.dir,
      runner: fakeRunner({}),
      hostnames: [],
      jira: null,
      pathDirs: {},
      demo,
    });

  it("includes the repo when the wizard said yes", async () => {
    const labels = (await runSetupNow(true)).map((s) => s.label);
    expect(labels).toContain(`repo ${DEMO_SERVICES_REPO}`);
    expect(labels).toContain(`repo ${WORKSPACE_ROOT_REPO}`);
  });

  it("includes the repo when it is already checked out", async () => {
    // syncRepo treats a dir without .git as "not a checkout" — still a step, but be honest.
    fs.mkdirSync(path.join(home.dir, DEMO_SERVICES_REPO, ".git"), { recursive: true });
    const labels = (await runSetupNow(false)).map((s) => s.label);
    expect(labels).toContain(`repo ${DEMO_SERVICES_REPO}`);
  });

  it("skips the repo on a fresh machine that declined the demo", async () => {
    const labels = (await runSetupNow(false)).map((s) => s.label);
    expect(labels).not.toContain(`repo ${DEMO_SERVICES_REPO}`);
    // The workspace root repo is unconditional — it is not demo content.
    expect(labels).toContain(`repo ${WORKSPACE_ROOT_REPO}`);
  });

  it("generates the registry after the clone steps and fails loud with no fragments", async () => {
    const steps = await runSetupNow(true);
    const labels = steps.map((s) => s.label);
    const registryAt = labels.indexOf("config services.yaml");
    expect(registryAt).toBeGreaterThan(labels.indexOf(`repo ${DEMO_SERVICES_REPO}`));
    expect(registryAt).toBeGreaterThan(labels.indexOf(`repo ${WORKSPACE_ROOT_REPO}`));
    expect(steps[registryAt].ok).toBe(false);
    expect(steps[registryAt].detail).toContain("no .sandbox/services.yaml found");
  });

  it("generates the registry from a fragment it finds under repos_root", async () => {
    const fragmentDir = path.join(home.dir, "demo-services", ".sandbox");
    fs.mkdirSync(fragmentDir, { recursive: true });
    fs.mkdirSync(path.join(home.dir, "demo-services", ".git"), { recursive: true });
    fs.writeFileSync(path.join(fragmentDir, "services.yaml"), "services:\n  backend:\n    path: apps/backend\n");
    const steps = await runSetup({
      checkOnly: false, reposRoot: home.dir, runner: fakeRunner({ "git clone": [0, ""], "claude": [0, ""] }),
      hostnames: [], jira: null, pathDirs: {}, demo: false,
      registry: { legacyDir: null, k8sContext: "kind-dev" },
    });
    expect(detail(steps, "config services.yaml")).toContain("generated");
    const text = fs.readFileSync(path.join(home.dir, "services.yaml"), "utf8");
    expect(text).toContain("k8s_context: kind-dev");
    expect(text).toContain("repo: demo-services");
  });
});

describe("syncEditorSchemas", () => {
  let dir: string;
  let settings: string;
  const schemas = "/opt/sandbox/infra/schemas";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-"));
    settings = path.join(dir, "settings.json");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("skips when VS Code is not installed", () => {
    const [step] = syncEditorSchemas(false, true, path.join(dir, "nope", "settings.json"), schemas);
    expect(step.ok).toBe(true);
    expect(step.detail).toContain("not found");
  });

  it("never writes without a yes, and --check stays green", () => {
    fs.writeFileSync(settings, "{}");
    for (const [checkOnly, install] of [[true, true], [false, false]]) {
      const [step] = syncEditorSchemas(checkOnly, install, settings, schemas);
      expect(step.ok).toBe(true);
    }
    expect(fs.readFileSync(settings, "utf8")).toBe("{}");
  });

  it("maps both schemas, keeps comments, replaces a stale path, and is then a no-op", () => {
    fs.writeFileSync(
      settings,
      '{\n    // mine\n    "editor.tabSize": 2,\n    "yaml.schemas": {\n' +
        '        "/old/infra/schemas/workspace.schema.json": "**/.sandbox/workspace.yml",\n' +
        '        "/k8s.json": "*.k8s.yaml",\n    },\n}\n',
    );
    const [step] = syncEditorSchemas(false, true, settings, schemas);
    expect(step.ok).toBe(true);
    const text = fs.readFileSync(settings, "utf8");
    expect(text).toContain("// mine");
    expect(text).toContain('"/k8s.json": "*.k8s.yaml"');
    expect(text).not.toContain("/old/");
    expect(text).toContain(`"${schemas}/services-fragment.schema.json": "**/.sandbox/services.yaml"`);
    expect(text).toContain(`"${schemas}/workspace.schema.json": "**/.sandbox/workspace.yml"`);

    syncEditorSchemas(false, true, settings, schemas);
    expect(fs.readFileSync(settings, "utf8")).toBe(text);
  });

  it("flags a stale mapping in --check without touching it", () => {
    const before = '{"yaml.schemas": {"/old/workspace.schema.json": "**/.sandbox/workspace.yml"}}';
    fs.writeFileSync(settings, before);
    const [step] = syncEditorSchemas(true, false, settings, schemas);
    expect(step).toMatchObject({ ok: false, optional: true });
    expect(fs.readFileSync(settings, "utf8")).toBe(before);
  });

  it("refuses to edit an unparsable settings file", () => {
    fs.writeFileSync(settings, "{ nope");
    const [step] = syncEditorSchemas(false, true, settings, schemas);
    expect(step).toMatchObject({ ok: false, optional: true });
    expect(fs.readFileSync(settings, "utf8")).toBe("{ nope");
  });
});
