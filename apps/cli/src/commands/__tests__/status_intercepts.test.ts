/**
 * Row composition for `sandbox status --intercepts` (see
 * docs/superpowers/specs/2026-07-25-sandbox-intercept-toggle-design.md).
 *
 * The join under test: every active feature's services × the service registry ×
 * the deployments telepresence reports as intercepted.
 */
import { describe, expect, it } from "vitest";

import { buildInterceptRows } from "../status.js";

const REGISTRY = {
  "next-hello": {
    k8s_deployment: "next-hello",
    k8s_namespace: "default",
    k8s_port: 8080,
    k8s_port_name: "http",
  },
  "rest-hello": {
    k8s_deployment: "rest-hello",
    k8s_namespace: "default",
    k8s_port: 80,
    k8s_port_name: "http",
  },
  // Registered but never interceptable — no k8s coordinates at all.
  "legacy-worker": { internal_port: 3000 },
};

const SLOTS = {
  "test-me": { slot: 1, services: ["next-hello"] },
  other: { slot: 2, services: ["next-hello", "rest-hello"] },
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
      "test-me/next-hello",
      "other/next-hello",
      "other/rest-hello",
    ]);
  });

  it("marks a fully specified service interceptable with no blocker", () => {
    const [row] = buildInterceptRows({ "test-me": SLOTS["test-me"] }, REGISTRY, none);
    expect(row.interceptable).toBe(true);
    expect(row.blocker).toBeNull();
    expect(row.deployment).toBe("next-hello");
    expect(row.intercepted).toBe(false);
    expect(row.intercepted_by).toBeNull();
  });

  it("reports an intercept owned by this feature", () => {
    const [row] = buildInterceptRows(
      { "test-me": SLOTS["test-me"] },
      REGISTRY,
      state([["next-hello", "test-me"]]),
    );
    expect(row.intercepted).toBe(true);
    expect(row.intercepted_by).toBe("test-me");
  });

  it("names the owning feature on another feature's row for the same deployment", () => {
    // One intercept per deployment: feature `other` must not be told it owns this.
    const rows = buildInterceptRows(SLOTS, REGISTRY, state([["next-hello", "test-me"]]));
    const otherRow = rows.find((r) => r.feature === "other" && r.service === "next-hello")!;
    expect(otherRow.intercepted).toBe(true);
    expect(otherRow.intercepted_by).toBe("test-me");
  });

  it("passes through unknown ownership as null rather than guessing", () => {
    const [row] = buildInterceptRows(
      { "test-me": SLOTS["test-me"] },
      REGISTRY,
      state([["next-hello", null]]),
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
