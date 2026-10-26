/**
 * SW-41: `sandbox status` shows each feature's CPU, memory and start reason, a
 * crash loop as a red line with its last log line, and a host load summary.
 * Every daemon read is mocked; the formatting and the row joins are real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("werkmeister-core/compose", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/compose")>()),
  // A workspace up'd before SW-93, still under its sandbox- project.
  liveProject: vi.fn(async (feature: string) => `sandbox-${feature}`),
  getContainerStatus: vi.fn(async () => [
    {
      name: "a-api",
      status: "running",
      health: "",
      ports: "",
      service: "api",
      role: "",
      exitCode: 0,
    },
  ]),
}));
vi.mock("werkmeister-core/k8s", () => ({ getPerServiceStatus: vi.fn(async () => []) }));
vi.mock("werkmeister-core/slots", () => ({
  getAllSlots: vi.fn(async () => ({ a: { slot: 1, services: ["api"] } })),
  slotCount: vi.fn(() => 12),
  getPortRange: vi.fn(() => [11100, 11119]),
}));
vi.mock("werkmeister-core/telepresence", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/telepresence")>()),
  listIntercepts: vi.fn(() => ({
    installed: false,
    available: false,
    namespace: null,
    intercepts: new Map(),
  })),
}));
vi.mock("werkmeister-core/web_servers", () => ({
  status: vi.fn(async () => ({ running: false, healthy: false })),
}));
vi.mock("../../lib/config.js", async (orig) => ({
  ...(await orig<typeof import("../../lib/config.js")>()),
  loadServices: vi.fn(() => ({})),
}));
vi.mock("werkmeister-core/status", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/status")>()),
  getInfraStatus: vi.fn(async () => []),
  featureVitals: vi.fn(),
  statusSnapshot: vi.fn(),
}));

import { getPerServiceStatus } from "werkmeister-core/k8s";
import { featureVitals, statusSnapshot } from "werkmeister-core/status";
import { hostText, run, vitalsText } from "../status.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const twoHoursAgo = new Date(NOW - 2 * 3_600_000).toISOString();

let out: string[];
beforeEach(() => {
  out = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out.push(String(a[0] ?? ""));
  });
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
    out.push(String(s));
    return true;
  });
});

describe("vitalsText", () => {
  it("joins usage and start, dropping what is unknown", () => {
    const started = { at: twoHoursAgo, by: "gate" as const };
    expect(vitalsText({ cpuPercent: 12.3, memMib: 410 }, started, NOW)).toBe(
      "12.3% CPU · 410 MiB · started 2 h ago by gate",
    );
    expect(vitalsText(undefined, started, NOW)).toBe("started 2 h ago by gate");
    expect(vitalsText({ cpuPercent: 0, memMib: 2 }, null, NOW)).toBe("0% CPU · 2 MiB");
    expect(vitalsText(undefined, null, NOW)).toBe("");
  });
});

describe("hostText", () => {
  it("names the load, the cores and the feature CPU; n/a without a sweep", () => {
    const line = hostText({ load: [3.2, 2.8, 2.1], cores: 10, featureCpuPercent: 45 });
    expect(line).toContain("Host load 3.2 2.8 2.1 (10 cores)");
    expect(line).toContain("feature containers 45% CPU");
    expect(hostText(null)).toContain("Host load n/a");
  });
});

describe("run", () => {
  it("prints the host line, each feature's vitals and its crash loops", async () => {
    vi.mocked(featureVitals).mockResolvedValue({
      health: new Map([
        [
          "sandbox-a",
          {
            // run() reads the real clock, so the start is relative to it, not NOW.
            started: { at: new Date(Date.now() - 2 * 3_600_000).toISOString(), by: "up" },
            crashLoops: [{ service: "worker", restarts: 5, lastLog: "Error: EADDRINUSE :3000" }],
          },
        ],
      ]),
      resources: {
        projects: { "sandbox-a": { cpuPercent: 12.3, memMib: 410 } },
        host: { load: [401, 380, 300], cores: 10, featureCpuPercent: 845.2 },
      },
    });
    await run({});
    const text = out.join("\n");
    expect(text).toContain("Host load 401 380 300 (10 cores)");
    expect(text).toContain("feature containers 845.2% CPU");
    expect(text).toContain("12.3% CPU · 410 MiB · started 2 h ago by up");
    expect(text).toContain("✗ worker crash-looping (5 restarts): Error: EADDRINUSE :3000");
  });

  it("--json passes the snapshot's vitals through", async () => {
    vi.mocked(statusSnapshot).mockResolvedValue({
      host: { load: [1, 1, 1], cores: 8, featureCpuPercent: 3 },
      features: [{ name: "a", cpu_percent: 3, mem_mib: 90, started_by: "gate", crash_loops: [] }],
    } as never);
    await run({ json: true });
    const json = JSON.parse(out[0]);
    expect(json.host.cores).toBe(8);
    expect(json.features[0]).toMatchObject({ cpu_percent: 3, mem_mib: 90, started_by: "gate" });
  });
});

describe("run, paused (SW-70)", () => {
  it("reads a feature whose containers are all frozen as paused", async () => {
    const { getContainerStatus } = await import("werkmeister-core/compose");
    vi.mocked(getContainerStatus).mockResolvedValueOnce([
      {
        name: "a-api",
        status: "paused",
        health: "",
        ports: "",
        service: "api",
        role: "",
        exitCode: 0,
      },
    ]);
    vi.mocked(featureVitals).mockResolvedValue({ health: new Map(), resources: null } as never);
    await run({});
    expect(out.join("\n")).toContain("paused (0/1)");
  });
});

// SW-42: `sandbox up` starts the forwarder only for a cluster-backed workspace,
// so a stopped one is a fault only when a running workspace needs it.
describe("a stopped k8s-forwards container", () => {
  const forward = (status: string) => ({
    name: "redis",
    listen_port: 9050,
    remote_port: 6379,
    health_path: "redis",
    status,
  });
  beforeEach(() => {
    vi.mocked(featureVitals).mockResolvedValue({ health: new Map(), resources: null });
  });

  it("reads neutral, with no restart hint, when nothing running needs it", async () => {
    vi.mocked(getPerServiceStatus).mockResolvedValue([forward("stopped")]);
    await run({});
    const text = out.join("\n");
    expect(text).toContain(
      "container w9r-k8s-forwards stopped — not needed by any running workspace",
    );
    expect(text).toContain("k8s: \x1b[2mstopped");
    expect(text).not.toContain("is down");
    expect(text).not.toContain("docker restart w9r-k8s-forwards");

    out = [];
    await run({ k8s: true });
    expect(out.join("\n")).not.toContain("docker restart w9r-k8s-forwards");
  });

  it("stays a red warning with the restart hint when a running workspace needs it", async () => {
    vi.mocked(getPerServiceStatus).mockResolvedValue([forward("container_down")]);
    await run({});
    const text = out.join("\n");
    expect(text).toContain("\x1b[31mcontainer w9r-k8s-forwards is down");
    expect(text).toContain("0/1 alive");
    expect(text).toContain("docker restart w9r-k8s-forwards");

    out = [];
    await run({ k8s: true });
    expect(out.join("\n")).toContain("docker restart w9r-k8s-forwards");
  });
});
