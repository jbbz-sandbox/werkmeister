/**
 * slot allocation, release, port math.
 *
 * The functions this exercises are module-private, so the boundaries around
 * them are mocked one level down instead:
 *   - the Docker query boundary → mock `docker()` in werkmeister-core/docker
 *     (queryLabeledContainers asks it for `listContainers`),
 *   - `_slot_config`            → override `loadPorts` in config.js,
 *   - the allocate lock         → mock `sandboxLock` in werkmeister-core/locks (also lets us
 *     drive the lock-timeout path without a real 30s wait).
 * The fixture ports.yaml + services.yaml, staged in a throwaway ~/.sandbox,
 * back the un-overridden cases.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The `listContainers` row fields slots.ts reads. */
type ContainerRow = { Names: string[]; Labels: Record<string, string> };

const h = vi.hoisted(() => ({
  containers: [] as ContainerRow[] | null, // null → simulate an unreachable daemon
  portsOverride: null as Record<string, unknown> | null,
  simulateLockTimeout: false,
  lastLockOpts: undefined as { timeout?: number } | undefined,
  lastListOpts: undefined as
    | { all?: boolean; filters?: unknown; abortSignal?: unknown }
    | undefined,
}));

vi.mock("werkmeister-core/docker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("werkmeister-core/docker")>();
  return {
    ...actual,
    docker: () => ({
      listContainers: async (opts: typeof h.lastListOpts) => {
        h.lastListOpts = opts;
        // dockerode rejects when it cannot reach the daemon; slots.ts turns
        // that into the `null` that means "occupancy unknown".
        if (h.containers === null) throw new Error("connect ENOENT /var/run/docker.sock");
        // Honour the label filter as the daemon does, so a query for one label set can't see the other.
        const [label] = (opts?.filters as { label?: string[] } | undefined)?.label ?? [];
        return label ? h.containers.filter((c) => label in c.Labels) : h.containers;
      },
    }),
  };
});

vi.mock("werkmeister-core/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("werkmeister-core/config")>();
  return { ...actual, loadPorts: () => h.portsOverride ?? actual.loadPorts() };
});

vi.mock("werkmeister-core/locks", () => ({
  sandboxLock: (name: string, fn: () => unknown, opts?: { timeout?: number }) => {
    h.lastLockOpts = opts;
    if (h.simulateLockTimeout) {
      throw new Error(`Timed out after ${opts?.timeout}s waiting for lock '${name}'`);
    }
    return fn();
  },
}));

import { type Reporter, withReporter } from "werkmeister-core/reporter";
import {
  allocateSlot,
  getAllSlots,
  getPortRange,
  getServicePort,
  getSlot,
  releaseSlot,
} from "werkmeister-core/slots";
import { type SandboxHome, useSandboxHome } from "./helpers/sandbox_home.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** {"feat-a": [3, ["frontend"]]} → the `listContainers` rows the daemon returns. */
function fakeContainers(
  entries: Record<string, [number, string[]]>,
  prefix = "com.werkmeister",
): ContainerRow[] {
  const rows: ContainerRow[] = [];
  for (const [feature, [slot, services]] of Object.entries(entries)) {
    for (const service of services) {
      rows.push({
        // The API always slash-prefixes names; slots.ts strips it back off.
        Names: [`/${feature}-${service}`],
        Labels: {
          [`${prefix}.feature`]: feature,
          [`${prefix}.slot`]: String(slot),
          [`${prefix}.service`]: service,
        },
      });
    }
  }
  return rows;
}

let home: SandboxHome;

beforeEach(() => {
  process.env.WERKMEISTER_ROOT = repoRoot;
  home = useSandboxHome();
  h.containers = [];
  h.portsOverride = null;
  h.simulateLockTimeout = false;
  h.lastLockOpts = undefined;
  h.lastListOpts = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  home.cleanup();
  vi.restoreAllMocks();
});

// ---- allocateSlot: idempotency, selection order, exhaustion ---------------

describe("allocateSlot", () => {
  it("is idempotent for an existing feature", async () => {
    h.containers = fakeContainers({ "feat-a": [3, ["frontend"]] });
    expect(await allocateSlot("feat-a")).toBe(3);
  });

  it("honors a free preferred slot", async () => {
    h.containers = fakeContainers({ "feat-1": [1, ["frontend"]], "feat-2": [2, ["frontend"]] });
    expect(await allocateSlot("feat-new", 5)).toBe(5);
  });

  it("falls back when preferred slot taken", async () => {
    h.containers = fakeContainers({ "feat-1": [1, ["frontend"]] });
    const result = await allocateSlot("feat-new", 1);
    expect(result).not.toBe(1);
    expect(result).toBe(2);
  });

  it("returns lowest free slot with no preference", async () => {
    h.containers = fakeContainers({
      "feat-1": [1, ["frontend"]],
      "feat-2": [2, ["frontend"]],
      "feat-3": [3, ["frontend"]],
    });
    expect(await allocateSlot("feat-new")).toBe(4);
  });

  it("raises when all slots taken (overridden count: 2)", async () => {
    h.portsOverride = { feature_slots: { count: 2, base_port: 11100, ports_per_slot: 20 } };
    h.containers = fakeContainers({ "feat-1": [1, ["frontend"]], "feat-2": [2, ["frontend"]] });
    await expect(allocateSlot("feat-new")).rejects.toThrow();
  });

  it("raises when all 12 real slots taken", async () => {
    const taken: Record<string, [number, string[]]> = {};
    for (let n = 1; n <= 12; n++) taken[`feat-${n}`] = [n, ["frontend"]];
    h.containers = fakeContainers(taken);
    await expect(allocateSlot("feature-13")).rejects.toThrow(/slots/);
  });

  it("surfaces a lock timeout instead of hanging forever", async () => {
    h.simulateLockTimeout = true;
    await expect(allocateSlot("feat-x")).rejects.toThrow(/Timed out/);
    // allocate wires a finite timeout into the lock (the anti-hang guard).
    expect(typeof h.lastLockOpts?.timeout).toBe("number");
    expect(Number.isFinite(h.lastLockOpts?.timeout)).toBe(true);
  });
});

// SW-93: a workspace brought up before the label rename stays visible until its next `up`.
describe("containers labelled before SW-93 (com.sandbox.local.*)", () => {
  it("are found, and hold their slot against a new allocation", async () => {
    h.containers = fakeContainers({ "feat-old": [1, ["frontend"]] }, "com.sandbox.local");
    expect(await getSlot("feat-old")).toBe(1);
    expect(await allocateSlot("feat-new", 1)).toBe(2);
  });

  it("share the slot space with new ones: no slot is handed out twice", async () => {
    h.containers = [
      ...fakeContainers({ "feat-old": [1, ["frontend"]] }, "com.sandbox.local"),
      ...fakeContainers({ "feat-new": [2, ["frontend"]] }),
    ];
    expect(await getAllSlots()).toEqual({
      "feat-old": { slot: 1, services: ["frontend"] },
      "feat-new": { slot: 2, services: ["frontend"] },
    });
    expect(await allocateSlot("feat-next")).toBe(3);
  });
});

describe("releaseSlot", () => {
  it("ends the lease without touching docker, so the slot is free again (SW-181)", async () => {
    expect(await allocateSlot("feat-a", 4)).toBe(4);
    h.lastListOpts = undefined;
    await releaseSlot("feat-a");
    expect(h.lastListOpts).toBeUndefined();
    expect(await allocateSlot("feat-b", 4)).toBe(4);
  });
});

// ---- port math, getAllSlots/getSlot edges ---------------------------------

describe("port math and slot lookups", () => {
  it("getPortRange matches real ports.yaml values", () => {
    expect(getPortRange(1)).toEqual([11100, 11119]);
    expect(getPortRange(2)).toEqual([11200, 11219]);
    expect(getPortRange(12)).toEqual([12200, 12219]);
  });

  it("getServicePort matches real ports.yaml values", () => {
    expect(getServicePort(1, 0)).toBe(11100);
    expect(getServicePort(3, 2)).toBe(11302);
  });

  it("getAllSlots returns empty dict when docker unreachable", async () => {
    h.containers = null;
    expect(await getAllSlots()).toEqual({});
  });

  it("getSlot returns null for unknown feature", async () => {
    h.containers = fakeContainers({ "other-feature": [1, ["frontend"]] });
    expect(await getSlot("unknown-feature")).toBeNull();
  });

  it("asks the daemon for stopped containers too, and bounds the wait", async () => {
    await getAllSlots();
    // `all` matters: a stopped container still owns its slot label, and
    // dropping it would hand a live feature's slot to the next allocation.
    expect(h.lastListOpts?.all).toBe(true);
    expect(h.lastListOpts?.filters).toEqual({ label: ["com.sandbox.local.feature"] }); // the second of the two label-set queries
    // A daemon that accepts and never replies must not hang the CLI — the
    // shelled path carried `timeout: 10` and this has to keep it.
    expect(h.lastListOpts?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("strips the API's leading slash from container names", async () => {
    // The unparseable-slot warning prints the name; a stray `/` would leak.
    h.containers = fakeContainers({ feat: [1, ["frontend"]] });
    h.containers[0].Labels["com.werkmeister.slot"] = "not-a-number";
    const messages: string[] = [];
    const recorder: Reporter = {
      emit: (e) => {
        if (e.level !== "raw") messages.push(e.msg);
      },
      passthrough: false,
    };
    await withReporter(recorder, () => getAllSlots());
    expect(messages.join(" ")).toContain("'feat-frontend'");
  });
});
