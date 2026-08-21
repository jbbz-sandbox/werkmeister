/**
 * Where this CLI is installed, and a door onto the shared config layer.
 *
 * The registry loaders themselves live in `sandbox-core/config` and are
 * re-exported at the foot of this file. What stays here is the one question
 * that cannot move: `getSandboxRoot()` derives the repo root from this file's
 * own compiled location, so it would answer differently from inside another
 * package. `getInfraRoot()` builds on it and points at the things that ARE
 * code — compose files, templates, the proxy UI, schemas and skills — while
 * the machine-global registry files live in `~/.sandbox`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Colors } from "sandbox-core/colors";
import { expandUser } from "sandbox-core/config";

export { Colors, expandUser };

// The four print helpers now emit through `sandbox-core`'s ambient reporter,
// which main.ts installs. Re-exported from here so the ~170 call sites across
// lib/ and commands/ keep their import, the way #11 kept the config readers'
// call sites when they moved.
import { error, info, success, warn } from "sandbox-core/reporter";

export { error, info, success, warn };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Return the root of the sandbox repo.
 *
 * `SANDBOX_ROOT` env var when set, else self-derived from this file's
 * compiled location (`<root>/dist/lib/config.js` -> two levels up).
 */
export function getSandboxRoot(): string {
  const override = process.env.SANDBOX_ROOT;
  if (override) return path.resolve(expandUser(override));
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Return the root of the MONOREPO containing the CLI.
 *
 * `getSandboxRoot()` is the CLI package (`<repo>/apps/cli`) — right for
 * `infra/`, wrong for the sibling apps under `<repo>/apps/`. Walks up looking
 * for the `apps/` directory rather than assuming a fixed depth, so a checkout
 * laid out differently (or an `SANDBOX_ROOT` already pointing at the repo root)
 * still resolves.
 */
export function getMonorepoRoot(): string {
  let dir = getSandboxRoot();
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, "apps"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return getSandboxRoot();
}

/**
 * Return the infra/ dir holding compose, templates, proxy, schemas and skills.
 *
 * These are grouped under <repo>/infra/ (see the monorepo layout) and are all
 * CODE — versioned with the checkout. The machine-specific registry files that
 * used to sit in `infra/config/` now live in `~/.sandbox` instead; reach them
 * via `servicesYamlPath()` / `portsYamlPath()`, not this helper.
 */
export function getInfraRoot(): string {
  return path.join(getSandboxRoot(), "infra");
}


// The registry loaders and the workspace resolution live in
// `sandbox-core/config` now — the dashboard and the extension read the same
// files through the same precedence instead of shelling out for them. They are
// re-exported here so the 47 modules that import them do not move, the way #11
// kept the config readers' call sites.
export {
  detectWorkspaceFromCwd,
  loadArchetypes,
  getK8sContext,
  getReposRoot,
  getServiceNames,
  getVolumeBaseNames,
  loadInfrastructure,
  loadMcpServers,
  loadPorts,
  loadReposConfig,
  loadServices,
  loadSetupServices,
  resolveWorkspace,
} from "sandbox-core/config";
