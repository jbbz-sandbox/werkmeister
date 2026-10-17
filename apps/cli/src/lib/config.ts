/**
 * A door onto the shared config layer.
 *
 * Everything here is a re-export: the registry loaders, the print helpers and
 * — since the modules that needed them moved too — the checkout-root helpers
 * all live in `sandbox-core` now. The file survives so its 43 importers keep
 * their specifier — every export below is a re-export, no bodies left.
 */

import { Colors } from "sandbox-core/colors";
import { expandUser, infraRoot, monorepoRoot, sandboxRoot } from "sandbox-core/config";

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
 * Kept as a named export because 15 modules call it; the derivation itself
 * lives in `sandbox-core/config` now, so the library modules that moved there
 * resolve `infra/` the same way the CLI does. It throws rather than guessing
 * when neither `SANDBOX_ROOT` nor a walk-up finds the checkout — reading the
 * wrong `infra/` is worse than failing.
 */
export const getSandboxRoot = sandboxRoot;

/**
 * Return the root of the MONOREPO containing the CLI.
 *
 * Moved to `sandbox-core/config` when `web_servers.ts` did — a library module
 * asking where the sibling apps live is exactly what kept it here before.
 */
export const getMonorepoRoot = monorepoRoot;

/** The `infra/` tree — compose files, templates, proxy UI, schemas, skills. */
export const getInfraRoot = infraRoot;

// The registry loaders and the workspace resolution live in
// `sandbox-core/config` now — the dashboard and the extension read the same
// files through the same precedence instead of shelling out for them. They are
// re-exported here so the 47 modules that import them do not move, the way #11
// kept the config readers' call sites.
export {
  detectWorkspaceFromCwd,
  getK8sContext,
  getReposRoot,
  getServiceNames,
  getVolumeBaseNames,
  loadArchetypes,
  loadInfrastructure,
  loadMcpServers,
  loadPorts,
  loadReposConfig,
  loadServices,
  loadSetupServices,
  resolveWorkspace,
} from "sandbox-core/config";
