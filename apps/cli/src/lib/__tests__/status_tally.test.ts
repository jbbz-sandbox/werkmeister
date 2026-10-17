/**
 * Which containers `sandbox status` counts toward a feature's up/down verdict.
 *
 * `getContainerStatus` now passes `-a`, so stopped containers reach the tally
 * for the first time — including one-shot setup containers, which are supposed
 * to exit.
 */

import type { ContainerStatus } from "sandbox-core/compose";

import { tallied } from "sandbox-core/status";
import { describe, expect, it } from "vitest";

const c = (over: Partial<ContainerStatus>): ContainerStatus => ({
  name: "x",
  status: "running",
  health: "",
  ports: "",
  service: "x",
  role: "app",
  exitCode: 0,
  ...over,
});

describe("tallied", () => {
  it("drops a setup container that ran to completion", () => {
    const rows = tallied([
      c({ service: "frontend" }),
      c({ service: "demo-install", role: "setup", status: "exited", exitCode: 0 }),
    ]);
    expect(rows.map((r) => r.service)).toEqual(["frontend"]);
  });

  it("keeps a setup container that failed", () => {
    // The dependents' `service_completed_successfully` gate never opened, so the
    // feature really is broken — hiding the row would hide the reason.
    const rows = tallied([
      c({ service: "frontend" }),
      c({ service: "demo-install", role: "setup", status: "exited", exitCode: 1 }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("keeps a setup container that has not finished yet", () => {
    const rows = tallied([c({ service: "demo-install", role: "setup", status: "running" })]);
    expect(rows).toHaveLength(1);
  });

  it("recognises a pre-label setup container by its name suffix", () => {
    // Containers created before the role label existed carry no role at all.
    const rows = tallied([c({ service: "econ-setup", role: "", status: "exited", exitCode: 0 })]);
    expect(rows).toHaveLength(0);
  });

  it("keeps a crashed app service — the bug `-a` exposes", () => {
    // Without `-a` this container never reached the tally, so a feature with a
    // dead backend printed `up (1/1)`.
    const rows = tallied([
      c({ service: "frontend" }),
      c({ service: "backend", status: "exited", exitCode: 137 }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.status === "running")).toHaveLength(1);
  });
});
