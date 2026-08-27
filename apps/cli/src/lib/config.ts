/**
 * A door onto the shared config layer.
 *
 * Everything here is a re-export: the registry loaders, the print helpers and
 * — since the modules that needed them moved too — the checkout-root helpers
 * all live in `sandbox-core` now. The file survives so its ~47 importers keep
 * their specifier. `getMonorepoRoot()` is the one body left, and only because
 * nothing outside the CLI asks where the sibling apps are.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { Colors } from "sandbox-core/colors";
import { expandUser, infraRoot, sandboxRoot } from "sandbox-core/config";

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
 * Return the root of the sandbox CLI package.
 *
 * Kept as a named export because 40-odd modules call it; the derivation itself
 * lives in `sandbox-core/config` now, so the library modules that moved there
 * resolve `infra/` the same way the CLI does.
 */
export const getSandboxRoot = sandboxRoot;

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

/** The `infra/` tree — compose files, templates, proxy UI, schemas, skills. */
export const getInfraRoot = infraRoot;


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
