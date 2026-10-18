/**
 * Row composition for `sandbox status --intercepts`.
 *
 * The join under test: every active feature's services × the service registry ×
 * the deployments telepresence reports as intercepted.
 */

import * as fs from "node:fs";
import { buildInterceptRows, interceptsSnapshot } from "sandbox-core/status";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The snapshot's only seams: the telepresence subprocess, the slot table, the registry.
const h = vi.hoisted(() => ({ telepresence: true }));

vi.mock("sandbox-core/proc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sandbox-core/proc")>();
  return {
    ...actual,
    run: (cmd: string[]) => {
      if (!h.telepresence) throw new actual.ProcError("not found", cmd, -1, "", "", "ENOENT");
      if (cmd[1] === "list") {
        return {
          status: 0,
          stdout: fs.readFileSync(
            new URL("./fixtures/telepresence-list-active.json", import.meta.url),
            "utf8",
          ),
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout: JSON.stringify({ daemon: { status: "Connected", namespace: "default" } }),
        stderr: "",
      };
    },
  };
});
vi.mock("sandbox-core/slots", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sandbox-core/slots")>()),
  getAllSlots: async () => ({ "test-me": { slot: 1, services: ["frontend"] } }),
}));
vi.mock("sandbox-core/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sandbox-core/config")>()),
  loadServices: () => REGISTRY,
}));

const REGISTRY: Record<string, Record<string, unknown>> = {
  frontend: {
    k8s_deployment: "frontend",
    k8s_namespace: "default",
    k8s_port: 8080,
    k8s_port_name: "http",
  },
  backend: {
    k8s_deployment: "backend",
    k8s_namespace: "default",
    k8s_port: 80,
    k8s_port_name: "http",
  },
  // Registered but never interceptable — no k8s coordinates at all.
  "legacy-worker": { internal_port: 3000 },
};

const SLOTS = {
  "test-me": { slot: 1, services: ["frontend"] },
  other: { slot: 2, services: ["frontend", "backend"] },
};

const none = { available: true, intercepts: new Map<string, string | null>() };
const state = (pairs: [string, string | null][]) => ({
  available: true,
  intercepts: new Map(pairs),
});

describe("buildInterceptRows", () => {
  it("emits one row per feature-service pair", () => {
    const rows = buildInterceptRows(SLOTS, REGISTRY, none);
    expect(rows.map((r) => `${r.feature}/${r.service}`)).toEqual([
      "test-me/frontend",
      "other/frontend",
      "other/backend",
    ]);
  });

  it("marks a fully specified service interceptable with no blocker", () => {
    const [row] = buildInterceptRows({ "test-me": SLOTS["test-me"] }, REGISTRY, none);
    expect(row.interceptable).toBe(true);
    expect(row.blocker).toBeNull();
    expect(row.deployment).toBe("frontend");
    expect(row.intercepted).toBe(false);
    expect(row.intercepted_by).toBeNull();
  });

  it("reports an intercept owned by this feature", () => {
    const [row] = buildInterceptRows(
      { "test-me": SLOTS["test-me"] },
      REGISTRY,
      state([["frontend", "test-me"]]),
    );
    expect(row.intercepted).toBe(true);
    expect(row.intercepted_by).toBe("test-me");
  });

  it("names the owning feature on another feature's row for the same deployment", () => {
    // One intercept per deployment: feature `other` must not be told it owns this.
    const rows = buildInterceptRows(SLOTS, REGISTRY, state([["frontend", "test-me"]]));
    const otherRow = rows.find(
      (r) => r.feature === "other" && r.service === "frontend",
    ) as (typeof rows)[number];
    expect(otherRow.intercepted).toBe(true);
    expect(otherRow.intercepted_by).toBe("test-me");
  });

  it("passes through unknown ownership as null rather than guessing", () => {
    const [row] = buildInterceptRows(
      { "test-me": SLOTS["test-me"] },
      REGISTRY,
      state([["frontend", null]]),
    );
    expect(row.intercepted).toBe(true);
    expect(row.intercepted_by).toBeNull();
  });

  it("marks a service with no k8s coordinates non-interceptable and explains why", () => {
    const rows = buildInterceptRows(
      { f: { slot: 1, services: ["legacy-worker"] } },
      REGISTRY,
      none,
    );
    expect(rows[0].interceptable).toBe(false);
    expect(rows[0].blocker).toContain("k8s_deployment");
    expect(rows[0].intercepted).toBe(false);
    expect(rows[0].deployment).toBeNull();
  });

  it("marks a service missing from the registry non-interceptable", () => {
    const rows = buildInterceptRows({ f: { slot: 1, services: ["ghost"] } }, REGISTRY, none);
    expect(rows[0].interceptable).toBe(false);
    expect(rows[0].blocker).toBeTruthy();
  });

  it("never reports intercepted for a non-interceptable service, even on a name collision", () => {
    // A deployment named `legacy-worker` being intercepted must not leak onto a
    // service we've already established has no k8s coordinates.
    const rows = buildInterceptRows(
      { f: { slot: 1, services: ["legacy-worker"] } },
      REGISTRY,
      state([["legacy-worker", "f"]]),
    );
    expect(rows[0].intercepted).toBe(false);
  });

  it("returns no rows for a feature with no services", () => {
    expect(buildInterceptRows({ f: { slot: 1, services: [] } }, REGISTRY, none)).toEqual([]);
  });

  it("still reports interceptability when telepresence is unavailable", () => {
    const rows = buildInterceptRows({ "test-me": SLOTS["test-me"] }, REGISTRY, {
      available: false,
      intercepts: new Map(),
    });
    expect(rows[0].interceptable).toBe(true);
    expect(rows[0].intercepted).toBe(false);
  });
});

describe("interceptsSnapshot contract (`sandbox status --intercepts --json`)", () => {
  beforeEach(() => {
    h.telepresence = true;
  });

  it("returns {available, connected_namespace, intercepts[]} with the documented row fields", async () => {
    const snap = await interceptsSnapshot();
    expect(Object.keys(snap)).toEqual(["available", "connected_namespace", "intercepts"]);
    expect(snap.available).toBe(true);
    expect(snap.connected_namespace).toBe("default");
    for (const row of snap.intercepts) {
      expect(Object.keys(row)).toEqual([
        "feature",
        "service",
        "deployment",
        "interceptable",
        "blocker",
        "intercepted",
        "intercepted_by",
      ]);
    }
    expect(snap.intercepts.find((r) => r.service === "frontend")?.intercepted_by).toBe("test-me");
  });

  it("degrades to available: false with an empty list when telepresence is absent", async () => {
    h.telepresence = false;
    await expect(interceptsSnapshot()).resolves.toEqual({
      available: false,
      connected_namespace: null,
      intercepts: [],
    });
  });
});
