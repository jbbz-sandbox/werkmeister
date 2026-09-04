/**
 * The feature lifecycle — `up`/`down`/`stop`/`restart` — as callable functions.
 *
 * These are the sequences `apps/cli/src/commands/*` used to *be*. Splitting them
 * out is what lets a caller that is not a process — the dashboard, an MCP server
 * — drive a feature without a subprocess, which is the whole point of §5 of the
 * migration design.
 *
 * The convention, so the boundary is one rule and not four:
 *
 * - the feature is always an explicit argument; nothing here reads `process.cwd()`
 *   or `process.env.FEATURE`,
 * - a failure is a `SandboxError` with a code, never a `process.exit`,
 * - progress goes through the reporter (`info`/`warn`/`error`), but banners,
 *   tables and next-step hints do not — those are the CLI's rendering, and stay
 *   in the CLI,
 * - the return value is a plain object the caller can branch on.
 *
 * *feature* is a real feature throughout. `infra` is a CLI-level target that
 * routes to `sandbox-core/infra` before reaching any of this — passing it here
 * finds no slot, which `stop`/`restart` reject as `NOT_RUNNING` and `down`
 * merely warns about. `sandbox up infra` is the one that does not even reach
 * `infra`: it means `sandbox connect`, which is still a command module, so that
 * branch stays in the CLI until row 5g moves it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { isCaddyRunning, reloadCaddy, startCaddy } from "./caddy.js";
import { Colors } from "./colors.js";
import {
  composeDownAsync,
  composeRestart,
  composeStop,
  composeUpAsync,
} from "./compose.js";
import { loadPorts, loadServices } from "./config.js";
import { SandboxError } from "./errors.js";
import { loadFeatureRouters } from "./feature_routing.js";
import {
  generateCaddyfile,
  generateFeatureCompose,
  generateFeatureEnv,
  generateSupergraphConfig,
  isFeatureComposeStale,
} from "./generate.js";
import { writeWorkspaceHooks } from "./hooks_gen.js";
import { ensurePortForwardsHealthy, waitForForwards } from "./k8s.js";
import { info, raw, warn } from "./reporter.js";
import {
  getSecretsPath,
  loadSecrets,
  requiredSecretKeys,
  validateRequiredSecrets,
} from "./secrets.js";
import { allocateSlot, getPortRange, getServicePort, getSlot, releaseSlot } from "./slots.js";

/** Everything `sandbox up` computed, separated from how the CLI renders it. */
export interface UpResult {
  feature: string;
  slot: number;
  portRange: [number, number];
  /** The services this workspace runs locally; empty means all traffic goes to k8s. */
  localServices: string[];
  /** `https://<hostname>` for each local service Caddy terminates directly. */
  urls: string[];
  servicePorts: { service: string; port: number }[];
  /** The reserved slot was taken, so the compose files were rewritten for a new one. */
  regenerated: boolean;
  /** The compose file predates the service registry — warned about, not rewritten. */
  staleCompose: boolean;
  containersStarted: boolean;
  caddy: "reloaded" | "started";
}

/**
 * Bring *feature* up: allocate its slot, start its containers, and point the
 * proxy at them.
 *
 * *workspace* is passed in rather than resolved here: `resolveWorkspace` falls
 * back to the current directory, which is the caller's for an in-process caller
 * and so would silently point the dashboard at whatever it happened to be
 * running from. The CLI resolves it from argv and hands it over.
 *
 * Throws `NO_COMPOSE` when the workspace has no generated `docker-compose.yml`,
 * `MISSING_SECRETS` when a secret this workspace's own services require is
 * absent, `SLOT_ALLOC` when no slot can be allocated, `FORWARDS_NEVER_READY`
 * when the forwards are restarted and their tunnels never reconnect, and
 * `COMPOSE_UP_FAILED` when `docker compose up` reports failure.
 */
export async function up(
  feature: string,
  workspace: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<UpResult> {
  const workspaceCompose = path.join(workspace, "docker-compose.yml");
  if (!fs.existsSync(workspaceCompose)) {
    throw new SandboxError(
      `No docker-compose.yml found in workspace: ${workspace}\n` +
        "       Run 'sandbox init-workspace' first to generate it.",
      "NO_COMPOSE",
    );
  }

  // Config first because the proxy generation needs it, then fail on a missing
  // secret before any slot state is mutated or any container starts.
  info("Loading configuration...");
  const servicesConfig = loadServices();
  const config = { services: servicesConfig, ports: loadPorts() };
  const localServices = readServicesFromWorkspace(workspace);
  requireSecrets(servicesConfig, localServices);

  // init-workspace is otherwise the only writer, so a workspace created before
  // a hook-template change kept the stale hook until someone re-ran it by hand.
  // The merge is idempotent and never clobbers a hand-added entry.
  writeWorkspaceHooks(workspace);

  info("Allocating feature slot...");
  const preferredSlot = readSlotFromWorkspace(workspace);
  let slot: number;
  try {
    slot = await allocateSlot(feature, localServices, preferredSlot);
  } catch (e) {
    // Rewrapped rather than left to propagate: allocation reports failure as a
    // plain Error, whose message already carries the stale-lock recovery
    // guidance, and `main.ts` prints a bare Error as `Error: <msg>` instead of
    // the `[err] <msg>` this site has always produced.
    throw new SandboxError(e instanceof Error ? e.message : String(e), "SLOT_ALLOC");
  }

  const [portStart, portEnd] = getPortRange(slot);
  info(`Slot ${slot} -> port range ${portStart}-${portEnd}`);

  const regenerated = preferredSlot !== null && slot !== preferredSlot;
  let staleCompose = false;
  if (regenerated) {
    warn(`Slot changed (${preferredSlot} → ${slot}) — regenerating compose...`);
    generateFeatureCompose(feature, slot, localServices, config, workspace, "sandbox up");
    generateFeatureEnv(feature, slot, localServices, config, workspace);
    generateSupergraphConfig(feature, slot, localServices, config, workspace);
  } else if (isFeatureComposeStale(feature, slot, localServices, config, workspace)) {
    // Warn rather than regenerate: `up` starting to rewrite workspace files
    // would silently discard hand-edits to the generated compose.
    staleCompose = true;
    warn(
      "docker-compose.yml predates the current service registry — " +
        "run 'sandbox init-workspace' in the workspace to regenerate it.",
    );
  }

  // Unprefixed because it always has been — `raw` is what keeps the CLI's bytes
  // identical for a line that sits mid-sequence and so cannot move to the
  // command's summary block.
  raw(
    `\n  ${Colors.CYAN}Local services: ` +
      `${Colors.BOLD}${localServices.length ? localServices.join(", ") : "(none -- all via k8s)"}` +
      `${Colors.RESET}\n\n`,
  );

  info("Checking k8s port-forwards...");
  // A restart returns when the container runs, not when its tunnels carry
  // traffic. Starting containers in that window is what produces a compose
  // dependency failure that never mentions a port-forward — so wait, and only
  // after a restart, leaving the healthy path costing exactly what it did.
  //
  // The two failures are deliberately not the same. A restart that *fails* may
  // just mean this machine runs no cluster, and a feature needing nothing from
  // one has always come up regardless, so it stays non-fatal and already
  // reported itself. Tunnels that never return after a successful restart mean
  // forwards this machine does run are broken; `waitForForwards` throws, which
  // says so far better than the compose error it replaces.
  if (ensurePortForwardsHealthy() === "restarted") {
    await waitForForwards();
  }

  let containersStarted = false;
  if (localServices.length) {
    info("Starting containers...");
    if (!(await composeUpAsync(feature, signal))) {
      throw new SandboxError(
        "Failed to start containers. Check docker compose output above.",
        "COMPOSE_UP_FAILED",
      );
    }
    containersStarted = true;
  } else {
    info("No local services to start -- routing entirely to k8s");
  }

  info("Configuring reverse proxy...");
  await generateCaddyfile(null, config);

  let caddy: "reloaded" | "started";
  if (isCaddyRunning()) {
    await reloadCaddy();
    caddy = "reloaded";
  } else {
    info("Caddy not running -- starting it...");
    startCaddy();
    caddy = "started";
  }

  // Derivations, not rendering: they exist only inside the summary's
  // `console.log` today, which is why an in-process caller could never get at
  // the URL a feature is reachable on.
  const routers = loadFeatureRouters(servicesConfig);
  const urls = localServices
    .map((s) => routers[s]?.hostname)
    .filter((h): h is string => Boolean(h))
    .map((h) => `https://${h}`);
  const servicePorts = [...localServices].sort().map((service) => {
    const svcDef = servicesConfig[service] ?? {};
    const offset = typeof svcDef === "object" && svcDef !== null ? svcDef["port_offset"] ?? 0 : 0;
    return { service, port: getServicePort(slot, offset) };
  });

  return {
    feature,
    slot,
    portRange: [portStart, portEnd],
    localServices,
    urls,
    servicePorts,
    regenerated,
    staleCompose,
    containersStarted,
    caddy,
  };
}

// ponytail: two hand-rolled parsers over the same file, because `loadDotenv`
// walks up from a start directory and these must read exactly this workspace's
// .env. Collapse them into one read if a third key is ever needed.

/** Read SANDBOX_SLOT from <workspace>/.env. */
function readSlotFromWorkspace(workspace: string): number | null {
  const envFile = path.join(workspace, ".env");
  if (!fs.existsSync(envFile) || !fs.statSync(envFile).isFile()) {
    return null;
  }
  for (const rawLine of fs.readFileSync(envFile, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SANDBOX_SLOT=")) {
      const value = line.slice("SANDBOX_SLOT=".length).trim();
      const n = Number(value);
      if (value !== "" && Number.isInteger(n)) {
        return n;
      }
    }
  }
  return null;
}

/** Read the SERVICES list from <workspace>/.env (written by init-workspace). */
function readServicesFromWorkspace(workspace: string): string[] {
  const envFile = path.join(workspace, ".env");
  if (!fs.existsSync(envFile) || !fs.statSync(envFile).isFile()) {
    return [];
  }
  for (const rawLine of fs.readFileSync(envFile, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("SERVICES=")) {
      return line
        .slice("SERVICES=".length)
        .trim()
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s);
    }
  }
  return [];
}

/**
 * Fail before slot allocation or `composeUp` when a secret key required by this
 * workspace's own services is missing or empty, so it surfaces as a clear,
 * value-free message instead of an opaque runtime error deep in container logs.
 */
function requireSecrets(servicesConfig: Record<string, any>, localServices: string[]): void {
  const secretsPath = getSecretsPath();
  const missing = validateRequiredSecrets(
    loadSecrets(secretsPath),
    requiredSecretKeys(servicesConfig, localServices),
  );
  if (missing.length) {
    throw new SandboxError(
      `Missing required secret(s) in ${secretsPath}: ` +
        `${missing.join(", ")}\n` +
        `       Run \`sandbox setup\` to write a template to ${secretsPath}, ` +
        "then fill in the missing values.",
      "MISSING_SECRETS",
    );
  }
}

/** A feature that was running, and the slot it keeps while stopped. */
export interface StopResult {
  feature: string;
  slot: number;
}

/** A feature that was running, and the slot its restarted containers reuse. */
export interface RestartResult {
  feature: string;
  slot: number;
}

/**
 * Stop *feature*'s containers, leaving them and its slot in place so
 * `restart`/`up` can resume it.
 *
 * Throws `NOT_RUNNING` when the feature holds no slot, and
 * `COMPOSE_STOP_FAILED` when `docker compose stop` reports failure.
 */
export async function stop(feature: string): Promise<StopResult> {
  const slot = await requireSlot(feature);

  info(`Stopping containers for '${feature}' (slot ${slot})...`);
  if (!composeStop(feature)) {
    throw new SandboxError(`Failed to stop containers for '${feature}'`, "COMPOSE_STOP_FAILED");
  }

  return { feature, slot };
}

/**
 * Restart *feature*'s containers in place.
 *
 * Throws `NOT_RUNNING` when the feature holds no slot, and
 * `COMPOSE_RESTART_FAILED` when `docker compose restart` reports failure.
 */
export async function restart(feature: string): Promise<RestartResult> {
  const slot = await requireSlot(feature);

  info(`Restarting containers for '${feature}' (slot ${slot})...`);
  if (!composeRestart(feature)) {
    throw new SandboxError(
      `Failed to restart containers for '${feature}'`,
      "COMPOSE_RESTART_FAILED",
    );
  }

  return { feature, slot };
}

/** A feature that has been torn down, and the slot it gave back. */
export interface DownResult {
  feature: string;
  /** null when the feature held no slot — torn down anyway; see `down`. */
  slot: number | null;
}

/**
 * Tear *feature* down: leave its k8s intercepts, remove its containers, and
 * release its slot.
 *
 * Unlike `stop`/`restart`, a missing slot is not an error — a half-torn-down
 * feature still has containers and generated files worth removing, so this
 * warns and cleans up anyway, and reports the slot as null.
 *
 * Does not touch the reverse proxy: `sandbox down --all-features` tears down N
 * features and reloads once, so the reload is `reloadProxy`, sequenced by the
 * caller. Does not read or print workspace notes either — that is a TTY prompt
 * loop, which §11 of the migration design keeps out of the library.
 */
export async function down(
  feature: string,
  { removeVolumes = false, signal }: { removeVolumes?: boolean; signal?: AbortSignal } = {},
): Promise<DownResult> {
  // Best-effort, and before composeDown: leaveFeatureIntercepts resolves the
  // workspace from compose labels on the still-running containers.
  try {
    const { leaveFeatureIntercepts } = await import("./telepresence.js");
    const left = leaveFeatureIntercepts(feature);
    if (left.length) {
      info(`Left k8s intercept(s): ${left.join(", ")}`);
    }
  } catch (exc) {
    // teardown must never block on telepresence
    warn(`Could not clean up k8s intercepts: ${exc instanceof Error ? exc.message : String(exc)}`);
  }

  const slot = await getSlot(feature);
  if (slot === null) {
    warn(`Feature '${feature}' does not have an allocated slot`);
    warn("It may already be stopped. Cleaning up anyway...");
  }

  info("Stopping containers...");
  if (removeVolumes) {
    info("Per-feature Docker volumes will be removed");
  }
  // A failed teardown still releases the slot rather than stranding it, but
  // it is said out loud: the caller's summary otherwise reads as success.
  if (!(await composeDownAsync(feature, { removeVolumes, signal }))) {
    warn(`Containers for '${feature}' may still exist -- see the docker compose output above`);
  }

  info("Releasing feature slot...");
  releaseSlot(feature);

  return { feature, slot };
}

/**
 * Regenerate the Caddyfile from the surviving features and reload Caddy.
 *
 * Separate from `down` so a multi-feature teardown pays for one reload rather
 * than one per feature. `up` reloads inline instead because it may also have to
 * *start* Caddy, which is part of bringing a feature up.
 */
export async function reloadProxy(): Promise<void> {
  info("Updating reverse proxy configuration...");
  await generateCaddyfile();
  if (isCaddyRunning()) {
    await reloadCaddy();
  } else {
    info("Caddy is not running -- skipping reload");
  }
}

/**
 * A feature with no slot was never brought up (or has been torn down), so there
 * is nothing to act on. Shared because both callers must raise the *same* code
 * — the CLI matches on it to print its "start it with" hint.
 */
async function requireSlot(feature: string): Promise<number> {
  const slot = await getSlot(feature);
  if (slot === null) {
    throw new SandboxError(
      `Feature '${feature}' is not running (no slot allocated)`,
      "NOT_RUNNING",
    );
  }
  return slot;
}
