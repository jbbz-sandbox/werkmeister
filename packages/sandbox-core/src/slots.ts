/**
 * Feature slot management for the developer sandbox.
 *
 * Each concurrently-running feature is assigned a *slot* (1-12). The slot
 * determines the port range that feature's containers listen on:
 *
 *     slot 1  -> ports 11100-11119
 *     slot 2  -> ports 11200-11219
 *     ...
 *     slot 12 -> ports 12200-12219
 *
 * Docker container labels (the `com.sandbox.local.*` family stamped
 * by `generateFeatureCompose`) are the single source of truth for slot
 * ownership. `allocateSlot` scans live container labels to find a free
 * slot; the next `docker compose up` stamps the slot label onto the new
 * containers, making that allocation authoritative. There is no separate
 * registry file -- `~/.sandbox/slots.json` was removed in the labels
 * refactor.
 *
 * Allocation is protected by an advisory file lock at
 * `~/.sandbox/locks/allocate.lock` so concurrent `sandbox up` runs
 * cannot race onto the same slot between the scan and the
 * `docker compose up` that stamps the label.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { dotDir, loadPorts, loadServices, slotPortRange } from "./config.js";
import { docker } from "./docker.js";
import { SandboxError } from "./errors.js";
import { sandboxLock } from "./locks.js";
import { error, info, success, warn } from "./reporter.js";

export const LABEL_PREFIX = "com.sandbox.local";
export const LABEL_FEATURE = `${LABEL_PREFIX}.feature`;
export const LABEL_SLOT = `${LABEL_PREFIX}.slot`;
export const LABEL_SERVICE = `${LABEL_PREFIX}.service`;

export interface SlotEntry {
  slot: number;
  services: string[];
}

// ---------------------------------------------------------------------------
// Docker label query (single source of truth for slot ownership)
// ---------------------------------------------------------------------------

// Finite timeout for the allocate lock: a crashed holder can no longer hang
// allocation forever (DEBT-02).
const _ALLOCATE_LOCK_TIMEOUT = 30.0;

/** Matches the `timeout: 10` the shelled `docker ps` carried before dockerode. */
const QUERY_TIMEOUT_MS = 10_000;

interface LabelRow {
  name: string;
  feature: string;
  slot: string;
  service: string;
}

/**
 * Per-container label rows for every sandbox feature container.
 *
 * The daemon already holds these as fields; `docker ps --format` only
 * flattened them to tabs for us to split back apart, and charged ~45ms of CLI
 * startup to do it (66ms shelled vs 21ms here, warmed). `sandbox status`,
 * `down` and `clean` each query twice, so each pays that twice.
 *
 * Returns `null` if the daemon is unreachable; `[]` if reachable but no
 * labelled containers exist. Callers depend on that distinction: `null` means
 * "unknown", and `allocateSlot` must not read it as "every slot is free".
 */
async function queryLabeledContainers(): Promise<LabelRow[] | null> {
  let containers;
  try {
    containers = await docker().listContainers({
      all: true,
      filters: { label: [LABEL_FEATURE] },
      // The shelled path had `timeout: 10`, and a daemon that accepts the
      // connection but never replies is a failure mode this repo has already
      // been bitten by (docs/known-issues.md, the dead k8s forward). Aborting
      // surfaces it as "unreachable" instead of hanging the CLI forever.
      abortSignal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
    });
  } catch {
    return null; // unreachable daemon, or one that stopped answering
  }
  return containers.map((c) => ({
    // dockerode reports every alias the container answers to, each with the
    // API's leading slash. `docker ps` printed the first one, unslashed.
    name: (c.Names[0] ?? "").replace(/^\//, ""),
    feature: c.Labels[LABEL_FEATURE] ?? "",
    slot: c.Labels[LABEL_SLOT] ?? "",
    service: c.Labels[LABEL_SERVICE] ?? "",
  }));
}

/**
 * Number of feature slots from `ports.yaml` (`feature_slots.count`).
 *
 * `ports.yaml` is the single source of truth (FRAG-03); the literal default
 * applies only when the key is absent. The port math on the same block lives in
 * `sandbox-core/config` — see {@link getPortRange}.
 */
export function slotCount(): number {
  const featureSlots = loadPorts()["feature_slots"];
  const isDict =
    typeof featureSlots === "object" && featureSlots !== null && !Array.isArray(featureSlots);
  return (isDict ? featureSlots["count"] : undefined) ?? 12;
}

/**
 * Return service names that should appear in a feature's `services` list.
 *
 * Only services that have a `port_offset` defined in `services.yaml`
 * are user-facing (backend, frontend, ...). Scaffolding services
 * such as `<repo>-setup` are excluded.
 */
function routableServiceNames(): Set<string> {
  const servicesConfig = loadServices();
  if (typeof servicesConfig !== "object" || servicesConfig === null) {
    return new Set();
  }
  const names = new Set<string>();
  for (const [name, defn] of Object.entries(servicesConfig)) {
    if (
      typeof defn === "object" &&
      defn !== null &&
      !Array.isArray(defn) &&
      (defn as Record<string, unknown>)["port_offset"] !== null &&
      (defn as Record<string, unknown>)["port_offset"] !== undefined
    ) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Build the slot registry by querying Docker container labels.
 *
 * Always performs a fresh daemon query -- there is no cross-operation cache
 * (FRAG-04). Callers that need the result more than once within a single
 * operation should query it once and reuse the returned dict rather than
 * calling this repeatedly.
 *
 * Returns `{featureName: {slot, services}}` on success, or `null` if
 * the Docker daemon is unreachable.
 */
export async function getAllSlotsFromDocker(): Promise<Record<string, SlotEntry> | null> {
  const rows = await queryLabeledContainers();
  if (rows === null) {
    return null;
  }

  const routable = routableServiceNames();
  const byFeature: Record<string, SlotEntry> = {};
  for (const row of rows) {
    const feature = row.feature;
    const slot = Number.parseInt(row.slot, 10);
    if (Number.isNaN(slot)) {
      warn(`Container '${row.name}' has unparseable slot label: '${row.slot}'`);
      continue;
    }
    const service = row.service;

    let entry = byFeature[feature];
    if (!entry) {
      entry = { slot, services: [] };
      byFeature[feature] = entry;
    }
    if (entry.slot !== slot) {
      warn(
        `Feature '${feature}' has inconsistent slot labels across containers ` +
          `(saw ${entry.slot} and ${slot}) -- using ${slot}`,
      );
      entry.slot = slot;
    }
    if (service && routable.has(service) && !entry.services.includes(service)) {
      entry.services.push(service);
    }
  }

  return byFeature;
}

/**
 * Return the set of slot numbers held in *dockerSlots*.
 *
 * Returns an empty set if *dockerSlots* is `null` (Docker unreachable)
 * -- the subsequent `docker compose up` would also fail, so no harm.
 */
function takenSlots(dockerSlots: Record<string, SlotEntry> | null): Set<number> {
  if (!dockerSlots || Object.keys(dockerSlots).length === 0) {
    return new Set();
  }
  return new Set(Object.values(dockerSlots).map((entry) => entry.slot));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Allocate the next available slot for *feature*.
 *
 * The slot is picked by scanning live container labels for occupancy. If
 * *feature* already owns a slot (a labeled container exists), that slot
 * is returned -- the call is idempotent. Otherwise, *preferredSlot* is
 * used if free, else the lowest free slot is returned.
 *
 * Nothing is persisted. The next `docker compose up` stamps the slot
 * label onto the new containers, which becomes the authoritative record.
 * An advisory file lock serializes concurrent allocations so two
 * parallel `sandbox up` invocations cannot pick the same slot between
 * the scan and container creation.
 *
 * *services* is accepted for back-compat with the slots.json era and
 * ignored -- services are now derived from container labels at read time.
 *
 * Throws if all slots are occupied.
 */
export async function allocateSlot(
  feature: string,
  _services?: string[] | null, // kept for back-compat
  preferredSlot?: number | null,
): Promise<number> {
  const count = slotCount();
  return sandboxLock(
    "allocate",
    async () => {
      // Query Docker labels exactly once for this operation and derive
      // both "does this feature already have a slot" and "which slots
      // are taken" from that single result -- no stale cross-call reads.
      const dockerSlots = await getAllSlotsFromDocker();
      const existingEntry = dockerSlots?.[feature];
      if (existingEntry) {
        return existingEntry.slot;
      }

      const taken = takenSlots(dockerSlots);

      if (
        preferredSlot !== null &&
        preferredSlot !== undefined &&
        preferredSlot >= 1 &&
        preferredSlot <= count &&
        !taken.has(preferredSlot)
      ) {
        success(`Allocated slot ${preferredSlot} for '${feature}'`);
        return preferredSlot;
      }

      for (let candidate = 1; candidate <= count; candidate++) {
        if (!taken.has(candidate)) {
          success(`Allocated slot ${candidate} for '${feature}'`);
          return candidate;
        }
      }

      error(`All ${count} feature slots are occupied!`);
      throw new Error(
        "No available slots. Stop an existing feature with 'sandbox down <feature>' first.",
      );
    },
    { timeout: _ALLOCATE_LOCK_TIMEOUT },
  );
}

/**
 * No-op kept for call-site symmetry.
 *
 * Slot ownership lives on container labels. `docker compose down`
 * (called by `sandbox down`) removes the containers, which is what
 * actually frees the slot. Callers in `down.ts` and `clean.ts`
 * still invoke this for readability; there is no cache to invalidate.
 */
export function releaseSlot(_feature: string): void {}

/** Return the slot number for *feature*, or `null` if not allocated. */
export async function getSlot(feature: string): Promise<number | null> {
  const entry = (await getAllSlots())[feature];
  if (entry) {
    return entry.slot;
  }
  return null;
}

/**
 * Return `{feature: {slot, services}}`.
 *
 * Built entirely from Docker container labels. Returns an empty dict
 * if the docker daemon is unreachable.
 */
export async function getAllSlots(): Promise<Record<string, SlotEntry>> {
  const dockerSlots = await getAllSlotsFromDocker();
  if (dockerSlots === null) {
    return {};
  }
  return dockerSlots;
}

/**
 * Return the [start, end] port range for *slot* — e.g. slot 1 -> [11100, 11119].
 *
 * The math lives in `sandbox-core/config` because the dashboard renders the
 * same range beside each workspace; this wrapper only supplies `ports.yaml`.
 */
export function getPortRange(slot: number): [number, number] {
  return slotPortRange(slot, loadPorts());
}

/**
 * Return the host port for a service given *slot* and *portOffset*.
 *
 * Example: slot 1, offset 0 -> 11100; slot 3, offset 2 -> 11302.
 */
export function getServicePort(slot: number, portOffset: number): number {
  const [base] = getPortRange(slot);
  return base + portOffset;
}

// ---------------------------------------------------------------------------
// Where a feature's services actually answer
// ---------------------------------------------------------------------------

export interface ServiceEndpoint {
  service: string;
  source: "local" | "k8s" | "none";
  /** `null` when *source* is `"none"` — the CLI renders that as "(not configured)". */
  endpoint: string | null;
  type: string;
}

export interface FeatureServices {
  feature: string;
  slot: number;
  endpoints: ServiceEndpoint[];
}

/**
 * Decide where *service* answers for a feature holding *slot*.
 *
 * A container running locally wins: its host port is the slot's base plus the
 * service's `port_offset`. Otherwise a `k8s_forward_port` means the k8s-forwards
 * container tunnels it to the host. Neither means the registry says nothing
 * about how to reach it.
 */
export function classifyEndpoint(
  service: string,
  svcDef: Record<string, unknown>,
  localServices: string[],
  slot: number,
): ServiceEndpoint {
  const type = (svcDef["type"] as string | undefined) ?? "unknown";

  if (localServices.includes(service)) {
    const portOffset = (svcDef["port_offset"] as number | undefined) ?? 0;
    return {
      service,
      source: "local",
      endpoint: `localhost:${getServicePort(slot, portOffset)}`,
      type,
    };
  }

  const k8sPort = svcDef["k8s_forward_port"];
  if (k8sPort) {
    return { service, source: "k8s", endpoint: `localhost:${k8sPort}`, type };
  }

  return { service, source: "none", endpoint: null, type };
}

/**
 * Every registered service and where it answers for *feature*, sorted by name.
 *
 * Throws `SandboxError(…, "NOT_RUNNING")` when the feature holds no slot —
 * there are no endpoints to report, only advice the caller renders.
 */
export async function featureServices(feature: string): Promise<FeatureServices> {
  const slot = await getSlot(feature);
  if (slot === null) {
    throw new SandboxError(
      `Feature '${feature}' is not running (no slot allocated)`,
      "NOT_RUNNING",
    );
  }

  const localServices = (await getAllSlots())[feature]?.services ?? [];
  const servicesConfig = loadServices();

  const endpoints: ServiceEndpoint[] = [];
  for (const service of Object.keys(servicesConfig).sort()) {
    const svcDef = servicesConfig[service] ?? {};
    // A scalar or list under a service key is malformed registry data; the
    // command has always skipped it rather than rendering a half row.
    if (typeof svcDef !== "object" || svcDef === null || Array.isArray(svcDef)) {
      continue;
    }
    endpoints.push(classifyEndpoint(service, svcDef, localServices, slot));
  }

  return { feature, slot, endpoints };
}

// ---------------------------------------------------------------------------
// One-shot migration from the legacy slots.json
// ---------------------------------------------------------------------------

/**
 * Remove `~/.sandbox/slots.json` if present.
 *
 * Idempotent: second invocation is a no-op because the file is gone.
 * Any features in slots.json that have no labeled containers are logged
 * as forgotten -- they have no live state to migrate.
 */
export async function migrateSlotsJson(): Promise<void> {
  const legacy = path.join(dotDir(os.homedir()), "slots.json");
  if (!fs.existsSync(legacy)) {
    return;
  }

  let data: Record<string, unknown>;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacy, "utf8"));
    data = typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    data = {};
  }

  const live = (await getAllSlotsFromDocker()) ?? {};
  const orphans = Object.keys(data).filter(
    (f) =>
      typeof data[f] === "object" && data[f] !== null && !Array.isArray(data[f]) && !(f in live),
  );
  if (orphans.length > 0) {
    warn(
      `~/.sandbox/slots.json had features with no labeled containers: ` + `${orphans.join(", ")}`,
    );
    warn("These are now forgotten — restart them with 'sandbox up' to re-register.");
  }

  info("Migrating: removing legacy ~/.sandbox/slots.json (labels are now authoritative)");
  try {
    fs.unlinkSync(legacy);
  } catch (exc) {
    warn(`Could not remove ${legacy}: ${exc}`);
  }
}
