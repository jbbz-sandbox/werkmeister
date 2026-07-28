/**
 * Test helper: a throwaway `~/.sandbox` seeded from the checked-in fixtures.
 *
 * The registry files (services.yaml, ports.yaml) used to be committed under
 * `<repo>/infra/config/`, so tests could just point SANDBOX_ROOT at the repo
 * and read the real ones. They now live in the developer's `~/.sandbox`, which
 * tests must never touch — so the demo registry moved to `__tests__/fixtures/`
 * and this helper stages it in a temp dir instead.
 *
 * `SANDBOX_CONFIG_FILE` is the seam: `global_config` derives the whole
 * `~/.sandbox` directory from it, so setting it relocates config.yaml,
 * services.yaml, ports.yaml, model-pricing.yaml and secrets.env together.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as YAML from "yaml";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

/** Path to a file in `__tests__/fixtures/`. */
export function fixture(name: string): string {
  return path.join(FIXTURES, name);
}

/** The demo registry as text — the same content `sandbox setup --demo` seeds. */
export function fixtureServicesYaml(): string {
  return fs.readFileSync(fixture("services.yaml"), "utf8");
}

export interface SandboxHome {
  /** The temp directory standing in for `~/.sandbox`. */
  dir: string;
  /** Write (or overwrite) a file inside it; returns the full path. */
  write(name: string, content: string): string;
  /** Write config.yaml from an object. */
  writeConfig(cfg: Record<string, unknown>): string;
  /** Restore the previous env and remove the directory. */
  cleanup(): void;
}

export interface SandboxHomeOptions {
  /** Copy these fixture files in. Default: services.yaml + ports.yaml. */
  fixtures?: string[];
  /** Seed config.yaml with this content (omit to leave it absent). */
  config?: Record<string, unknown>;
}

/**
 * Stage a temp `~/.sandbox` and point `SANDBOX_CONFIG_FILE` at it.
 *
 * Call `cleanup()` in `afterEach`. Note that config.yaml is optional: with no
 * file present the loaders fall through to the defaults, which is exactly the
 * fresh-machine case most tests want.
 */
export function useSandboxHome(options: SandboxHomeOptions = {}): SandboxHome {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-home-"));
  const prev = process.env.SANDBOX_CONFIG_FILE;
  process.env.SANDBOX_CONFIG_FILE = path.join(dir, "config.yaml");

  for (const name of options.fixtures ?? ["services.yaml", "ports.yaml"]) {
    fs.copyFileSync(fixture(name), path.join(dir, name));
  }

  const write = (name: string, content: string): string => {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };

  const writeConfig = (cfg: Record<string, unknown>): string =>
    write("config.yaml", YAML.stringify(cfg));

  if (options.config) {
    writeConfig(options.config);
  }

  return {
    dir,
    write,
    writeConfig,
    cleanup() {
      if (prev === undefined) {
        delete process.env.SANDBOX_CONFIG_FILE;
      } else {
        process.env.SANDBOX_CONFIG_FILE = prev;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
