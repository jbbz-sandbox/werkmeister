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

import {
  OPTIONAL_PLUGINS,
  resolveCertScript,
  syncIngressCerts,
  syncOptionalPlugin,
  syncPathDirs,
  syncRegistryConfigs,
  syncTelepresence,
  type Runner,
  type Step,
} from "../machine_setup.js";
import { renderSecretsEnv, renderServicesYaml } from "../scaffold.js";
import { requiredSecretKeys, validateRequiredSecrets } from "../secrets.js";
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
  it("creates every registry file on a fresh machine", () => {
    const steps = syncRegistryConfigs(false, { legacyDir: null });
    expect(steps.every((s) => s.ok)).toBe(true);
    for (const name of ["services.yaml", "ports.yaml", "model-pricing.yaml", "secrets.env"]) {
      expect(fs.existsSync(path.join(home.dir, name)), `${name} not created`).toBe(true);
    }
  });

  it("never overwrites an existing file — hand edits survive a re-run", () => {
    home.write("services.yaml", "services:\n  hand-edited: {}\n");
    const steps = syncRegistryConfigs(false, { legacyDir: null });
    expect(fs.readFileSync(path.join(home.dir, "services.yaml"), "utf8")).toContain("hand-edited");
    expect(detail(steps, "config services.yaml")).toContain("present");
  });

  it("migrates a legacy infra/config checkout instead of scaffolding", () => {
    const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-"));
    fs.writeFileSync(path.join(legacy, "services.yaml"), "services:\n  from-legacy: {}\n");
    try {
      const steps = syncRegistryConfigs(false, { legacyDir: legacy });
      expect(detail(steps, "config services.yaml")).toContain("migrated");
      expect(fs.readFileSync(path.join(home.dir, "services.yaml"), "utf8")).toContain("from-legacy");
      // Copied, not moved — the old checkout may still need it.
      expect(fs.existsSync(path.join(legacy, "services.yaml"))).toBe(true);
    } finally {
      fs.rmSync(legacy, { recursive: true, force: true });
    }
  });

  it("writes nothing in check mode and reports the missing files", () => {
    const steps = syncRegistryConfigs(true, { legacyDir: null });
    expect(fs.existsSync(path.join(home.dir, "services.yaml"))).toBe(false);
    expect(steps.find((s) => s.label === "config services.yaml")?.ok).toBe(false);
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

  it("omits per-service hostnames from the demo registry — they derive from ingress", () => {
    const text = renderServicesYaml({ demo: true });
    expect(text).toContain("next-hello");
    expect(text).not.toContain("hostname: next-hello");
  });

  it("emits a parseable empty skeleton with every section present", () => {
    const text = renderServicesYaml({ demo: false, k8sContext: "kind-dev" });
    expect(text).toContain("k8s_context: kind-dev");
    for (const section of ["services:", "infrastructure:", "setup_services:", "repos:"]) {
      expect(text, `missing ${section}`).toContain(section);
    }
  });
});

describe("requiredSecretKeys", () => {
  const servicesConfig = {
    "rest-hello": {},
    "auth-web": { secrets: ["AUTH0_CLIENT_SECRET", "NEXTAUTH_SECRET"] },
  };

  it("is empty for a workspace whose services declare no secrets", () => {
    expect(requiredSecretKeys(servicesConfig, ["rest-hello"])).toEqual([]);
  });

  it("only requires the keys declared by services actually in the workspace", () => {
    expect(requiredSecretKeys(servicesConfig, ["rest-hello", "auth-web"])).toEqual([
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
  it("walks up to the monorepo root — bin/ is not under the CLI package", () => {
    // Regression: getSandboxRoot() is <monorepo>/apps/cli, so joining it with
    // "bin/generate-certs.sh" misses by two levels.
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
