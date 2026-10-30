/**
 * Feature slot management for werkmeister.
 *
 * Each concurrently-running feature is assigned a *slot* (1-12). The slot
 * determines the port range that feature's containers listen on:
 *
 *     slot 1  -> ports 11100-11119
 *     slot 2  -> ports 11200-11219
 *     ...
 *     slot 12 -> ports 12200-12219
 *
 * A slot is held by a lease in `~/.werkmeister/scheduler/leases.json`
 * (`scheduler_state.ts`), written the moment it is allocated, and by the
 * `com.werkmeister.*` labels on the feature's containers. Labels alone were not
 * enough: init-workspace allocates and starts nothing, so the next create saw
 * the slot as free (SW-166), and the gate re-allocated a slot a sibling held
 * (SW-169). A held lease is never moved; `releaseSlot` (from `down`) ends it.
 *
 * Every lease read-modify-write is under `~/.werkmeister/locks/allocate.lock`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { workspaceForFeature } from "./compose.js";
import { baselineUpstream, dotDir, loadPorts, loadServices, slotPortRange } from "./config.js";
import { docker } from "./docker.js";
import { SandboxError } from "./errors.js";
import { sandboxLock } from "./locks.js";
import { error, info, success, warn } from "./reporter.js";
import { pickSlot } from "./scheduler.js";
import { dequeue, readLeases, type SlotLease, writeLeases } from "./scheduler_state.js";

export const LABEL_PREFIX = "com.werkmeister";
export const LABEL_FEATURE = `${LABEL_PREFIX}.feature`;
/** Stamped before SW-93; containers keep them until their next `up`. SW-11 drops the reads. */
export const LEGACY_LABEL_PREFIX = "com.sandbox.local"; // name-check: ignore
export const LEGACY_LABEL_FEATURE = `${LEGACY_LABEL_PREFIX}.feature`;

/** *key* (`feature`, `slot`, `service`, `role`) from either label set; "" when unlabelled. */
export function labelOf(labels: Record<string, string> | undefined, key: string): string {
  return labels?.[`${LABEL_PREFIX}.${key}`] ?? labels?.[`${LEGACY_LABEL_PREFIX}.${key}`] ?? "";
}

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
 * Per-container label rows for every workspace feature container.
 *
 * The daemon already holds these as fields; `docker ps --format` only
 * flattened them to tabs for us to split back apart, and charged ~45ms of CLI
 * startup to do it (66ms shelled vs 21ms here, warmed). `werkmeister status`,
 * `down` and `clean` each query twice, so each pays that twice.
 *
 * Returns `null` if the daemon is unreachable; `[]` if reachable but no
 * labelled containers exist. Callers depend on that distinction: `null` means
 * "unknown", and `allocateSlot` must not read it as "every slot is free".
 */
async function queryLabeledContainers(): Promise<LabelRow[] | null> {
  let containers;
  try {
    // One query per label set: the daemon ANDs repeated label filters.
    const sets = await Promise.all(
      [LABEL_FEATURE, LEGACY_LABEL_FEATURE].map((label) =>
        docker().listContainers({
          all: true,
          filters: { label: [label] },
          // The shelled path had `timeout: 10`, and a daemon that accepts the
          // connection but never replies is a failure mode this repo has already
          // been bitten by (docs/known-issues.md, the dead k8s forward). Aborting
          // surfaces it as "unreachable" instead of hanging the CLI forever.
          abortSignal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
        }),
      ),
    );
    // A container carrying both sets answers both queries.
    const seen = new Set<string>();
    containers = sets.flat().filter((c) => !seen.has(c.Names[0]) && seen.add(c.Names[0]));
  } catch {
    return null; // unreachable daemon, or one that stopped answering
  }
  return containers.map((c) => ({
    // dockerode reports every alias the container answers to, each with the
    // API's leading slash. `docker ps` printed the first one, unslashed.
    name: (c.Names[0] ?? "").replace(/^\//, ""),
    feature: labelOf(c.Labels, "feature"),
    slot: labelOf(c.Labels, "slot"),
    service: labelOf(c.Labels, "service"),
  }));
}

/**
 * Number of feature slots from `ports.yaml` (`feature_slots.count`).
 *
 * `ports.yaml` is the single source of truth (FRAG-03); the literal default
 * applies only when the key is absent. The port math on the same block lives in
 * `werkmeister-core/config` — see {@link getPortRange}.
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Reads Docker labels; injectable so tests need no daemon. */
export interface SlotDeps {
  labels: () => Promise<Record<string, SlotEntry> | null>;
}

const defaultSlotDeps: SlotDeps = { labels: getAllSlotsFromDocker };

/**
 * Leases pruned and backfilled, plus the slot → owner map. Caller holds the lock.
 *
 * Prune: a lease whose workspace folder is gone. Backfill: a labelled feature
 * with no lease, so workspaces from before leases keep their slot. Where a
 * label and a lease disagree on a slot's owner the label wins: those
 * containers are what bind its ports.
 */
function heldSlots(dockerSlots: Record<string, SlotEntry> | null): {
  leases: Record<string, SlotLease>;
  held: Map<number, string>;
} {
  const leases = readLeases();
  for (const [f, l] of Object.entries(leases)) {
    if (l.workspace && !fs.existsSync(l.workspace)) delete leases[f];
  }
  for (const [f, e] of Object.entries(dockerSlots ?? {})) {
    leases[f] ??= { slot: e.slot, workspace: workspaceForFeature(f) ?? "" };
  }
  const held = new Map<number, string>();
  for (const [f, l] of Object.entries(leases)) held.set(l.slot, f);
  for (const [f, e] of Object.entries(dockerSlots ?? {})) {
    const leaseOwner = held.get(e.slot);
    if (leaseOwner && leaseOwner !== f) {
      warn(`Slot ${e.slot} is leased to '${leaseOwner}' but '${f}' has containers on it`);
    }
    held.set(e.slot, f);
  }
  return { leases, held };
}

/**
 * Allocate *feature*'s slot and lease it before the lock is released.
 *
 * Idempotent: a feature that already holds a slot (lease or label) gets it
 * back. Otherwise *preferredSlot* if free, else the lowest free slot.
 *
 * Throws if all slots are held.
 */
export async function allocateSlot(
  feature: string,
  preferredSlot?: number | null,
  workspace?: string | null,
  deps: SlotDeps = defaultSlotDeps,
): Promise<number> {
  const count = slotCount();
  return sandboxLock(
    "allocate",
    async () => {
      const { leases, held } = heldSlots(await deps.labels());
      const slot = pickSlot(feature, held, count, preferredSlot ?? null);
      if (slot === null) {
        error(`All ${count} feature slots are occupied!`);
        throw new Error(
          "No available slots. Stop an existing feature with 'werkmeister down <feature>' first.",
        );
      }
      if (leases[feature]?.slot !== slot) success(`Allocated slot ${slot} for '${feature}'`);
      leases[feature] = {
        slot,
        workspace: workspace ?? leases[feature]?.workspace ?? workspaceForFeature(feature) ?? "",
      };
      writeLeases(leases);
      return slot;
    },
    { timeout: _ALLOCATE_LOCK_TIMEOUT },
  );
}

/**
 * The slot `up` and the gate start *feature* on: its lease, never another.
 * With no lease yet, allocate one preferring *preferredSlot* (the `.env` slot).
 *
 * Throws `SLOT_ALLOC` when another feature's containers sit on the leased slot,
 * naming them, rather than moving to a slot whose ports may be someone else's.
 */
export async function requireLeasedSlot(
  feature: string,
  workspace: string,
  preferredSlot: number | null,
  deps: SlotDeps = defaultSlotDeps,
): Promise<number> {
  const dockerSlots = await deps.labels();
  const lease = await sandboxLock("allocate", () => readLeases()[feature], {
    timeout: _ALLOCATE_LOCK_TIMEOUT,
  });
  if (!lease) {
    try {
      return await allocateSlot(feature, preferredSlot, workspace, deps);
    } catch (e) {
      throw new SandboxError(e instanceof Error ? e.message : String(e), "SLOT_ALLOC");
    }
  }
  const squatter = Object.entries(dockerSlots ?? {}).find(
    ([f, e]) => f !== feature && e.slot === lease.slot,
  );
  if (squatter) {
    const [other] = squatter;
    throw new SandboxError(
      `Slot ${lease.slot} is leased to '${feature}' but '${other}' has containers on it — ` +
        `stop it or run 'werkmeister down ${other}'`,
      "SLOT_ALLOC",
    );
  }
  return lease.slot;
}

/** End *feature*'s lease and drop it from the waiting queue. Called by `down`. */
export async function releaseSlot(feature: string): Promise<void> {
  await sandboxLock(
    "allocate",
    () => {
      const leases = readLeases();
      if (!(feature in leases)) return;
      delete leases[feature];
      writeLeases(leases);
    },
    { timeout: _ALLOCATE_LOCK_TIMEOUT },
  );
  await dequeue(feature);
}

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
 * The math lives in `werkmeister-core/config` because the dashboard renders the
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
  source: "local" | "baseline" | "k8s" | "none";
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
 * service's `port_offset`. Otherwise a `baseline_upstream` names a Docker-network
 * address (not a host one), else a `k8s_forward_port` means the k8s-forwards
 * container tunnels it to the host. None means the registry says nothing
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

  const baseline = baselineUpstream(service, svcDef);
  if (baseline) {
    return { service, source: "baseline", endpoint: `${baseline.host}:${baseline.port}`, type };
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
 * Remove `~/.werkmeister/slots.json` if present.
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
      `~/.werkmeister/slots.json had features with no labeled containers: ` +
        `${orphans.join(", ")}`,
    );
    warn("These are now forgotten — restart them with 'werkmeister up' to re-register.");
  }

  info("Migrating: removing legacy ~/.werkmeister/slots.json (labels are now authoritative)");
  try {
    fs.unlinkSync(legacy);
  } catch (exc) {
    warn(`Could not remove ${legacy}: ${exc}`);
  }
}
