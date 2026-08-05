/**
 * slot allocation, release, port math.
 *
 * The Python tests monkeypatch module-private functions (`_query_labeled_containers`,
 * `_slot_config`, `_routable_service_names`, `_ALLOCATE_LOCK_TIMEOUT`). Those are
 * not exported in the TS port, so the equivalent boundaries are mocked one level
 * down instead:
 *   - the Docker query boundary → mock `run` in proc.js (queryLabeledContainers
 *     shells out through it),
 *   - `_slot_config`            → override `loadPorts` in config.js,
 *   - the allocate lock         → mock `sandboxLock` in locks.js (also lets us
 *     drive the lock-timeout path without a real 30s wait).
 * The fixture ports.yaml + services.yaml, staged in a throwaway ~/.sandbox,
 * back the un-overridden cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  dockerStdout: "" as string | null, // null → simulate an unreachable daemon
  portsOverride: null as Record<string, any> | null,
  simulateLockTimeout: false,
  lastLockOpts: undefined as any,
}));

vi.mock("../proc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../proc.js")>();
  return {
    ...actual,
    run: vi.fn(() =>
      h.dockerStdout === null
        ? { status: 1, stdout: "", stderr: "" }
        : { status: 0, stdout: h.dockerStdout, stderr: "" },
    ),
  };
});

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadPorts: () => h.portsOverride ?? actual.loadPorts() };
});

vi.mock("../locks.js", () => ({
  sandboxLock: (name: string, fn: () => any, opts?: any) => {
    h.lastLockOpts = opts;
    if (h.simulateLockTimeout) {
      throw new Error(`Timed out after ${opts?.timeout}s waiting for lock '${name}'`);
    }
    return fn();
  },
}));

import {
  allocateSlot,
  getAllSlots,
  getPortRange,
  getServicePort,
  getSlot,
  releaseSlot,
} from "../slots.js";
import { useSandboxHome, type SandboxHome } from "./helpers/sandbox_home.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** {"feat-a": [3, ["frontend"]]} → tab-separated `docker ps` rows. */
function fakeDockerRows(entries: Record<string, [number, string[]]>): string {
  const lines: string[] = [];
  for (const [feature, [slot, services]] of Object.entries(entries)) {
    for (const service of services) {
      lines.push([`${feature}-${service}`, feature, String(slot), service].join("\t"));
    }
  }
  return lines.join("\n");
}

let home: SandboxHome;

beforeEach(() => {
  process.env.SANDBOX_ROOT = repoRoot;
  home = useSandboxHome();
  h.dockerStdout = "";
  h.portsOverride = null;
  h.simulateLockTimeout = false;
  h.lastLockOpts = undefined;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  home.cleanup();
  vi.restoreAllMocks();
});

// ---- allocateSlot: idempotency, selection order, exhaustion ---------------

describe("allocateSlot", () => {
  it("is idempotent for an existing feature", () => {
    h.dockerStdout = fakeDockerRows({ "feat-a": [3, ["frontend"]] });
    expect(allocateSlot("feat-a")).toBe(3);
  });

  it("honors a free preferred slot", () => {
    h.dockerStdout = fakeDockerRows({ "feat-1": [1, ["frontend"]], "feat-2": [2, ["frontend"]] });
    expect(allocateSlot("feat-new", null, 5)).toBe(5);
  });

  it("falls back when preferred slot taken", () => {
    h.dockerStdout = fakeDockerRows({ "feat-1": [1, ["frontend"]] });
    const result = allocateSlot("feat-new", null, 1);
    expect(result).not.toBe(1);
    expect(result).toBe(2);
  });

  it("returns lowest free slot with no preference", () => {
    h.dockerStdout = fakeDockerRows({
      "feat-1": [1, ["frontend"]],
      "feat-2": [2, ["frontend"]],
      "feat-3": [3, ["frontend"]],
    });
    expect(allocateSlot("feat-new")).toBe(4);
  });

  it("raises when all slots taken (overridden count: 2)", () => {
    h.portsOverride = { feature_slots: { count: 2, base_port: 11100, ports_per_slot: 20 } };
    h.dockerStdout = fakeDockerRows({ "feat-1": [1, ["frontend"]], "feat-2": [2, ["frontend"]] });
    expect(() => allocateSlot("feat-new")).toThrow();
  });

  it("raises when all 12 real slots taken", () => {
    const taken: Record<string, [number, string[]]> = {};
    for (let n = 1; n <= 12; n++) taken[`feat-${n}`] = [n, ["frontend"]];
    h.dockerStdout = fakeDockerRows(taken);
    expect(() => allocateSlot("feature-13")).toThrow(/slots/);
  });

  it("surfaces a lock timeout instead of hanging forever", () => {
    h.simulateLockTimeout = true;
    expect(() => allocateSlot("feat-x")).toThrow(/Timed out/);
    // allocate wires a finite timeout into the lock (the anti-hang guard).
    expect(typeof h.lastLockOpts?.timeout).toBe("number");
    expect(Number.isFinite(h.lastLockOpts.timeout)).toBe(true);
  });
});

describe("releaseSlot", () => {
  it("is a no-op and never touches docker", () => {
    // No dockerStdout dependence: release must not query Docker at all.
    expect(releaseSlot("any-feature")).toBeUndefined();
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

  it("getAllSlots returns empty dict when docker unreachable", () => {
    h.dockerStdout = null;
    expect(getAllSlots()).toEqual({});
  });

  it("getSlot returns null for unknown feature", () => {
    h.dockerStdout = fakeDockerRows({ "other-feature": [1, ["frontend"]] });
    expect(getSlot("unknown-feature")).toBeNull();
  });
});
