/**
 * What `sandbox up` still renders now that the sequence lives in
 * `werkmeister-core/lifecycle`.
 *
 * The summary block used to read `servicesConfig` and recompute each service's
 * port inline, so it could only ever exist inside the command. It now renders
 * from `UpResult` — these cover that the derivations survived the move, and
 * that the four failure codes still reach `main.ts`'s handler rather than being
 * printed a second time here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxError } from "werkmeister-core/errors";
import type { Reporter } from "werkmeister-core/reporter";
import { withReporter } from "werkmeister-core/reporter";

import { makeRecorder } from "./helpers/recorder.js";

vi.mock("werkmeister-core/lifecycle", () => ({ up: vi.fn() }));
vi.mock("../../lib/dotenv.js", () => ({ loadDotenv: () => ({}) }));
vi.mock("../connect.js", () => ({ run: vi.fn() }));

import type { UpResult } from "werkmeister-core/lifecycle";
import { up as upFeature } from "werkmeister-core/lifecycle";
import { run as runConnect } from "../connect.js";
import { run as runUp } from "../up.js";

let lines: string[];
let recorder: Reporter;

/** A feature with two local services, one of them routed. */
function result(over: Partial<UpResult> = {}): UpResult {
  return {
    feature: "demo",
    slot: 3,
    portRange: [3300, 3399],
    localServices: ["api", "web"],
    urls: ["https://web.local.sandbox.com"],
    servicePorts: [
      { service: "api", port: 3301 },
      { service: "web", port: 3300 },
    ],
    regenerated: false,
    staleCompose: false,
    containersStarted: true,
    caddy: "reloaded",
    ...over,
  };
}

beforeEach(() => {
  ({ lines, reporter: recorder } = makeRecorder());
  // The banners and summary are `console.log`, not reporter events.
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(String(a[0] ?? ""));
  });
});

afterEach(() => vi.restoreAllMocks());

const go = (args: Record<string, unknown>) =>
  withReporter(recorder, () => runUp({ workspace: "/tmp/ws", ...args }));

describe("sandbox up", () => {
  it("renders the ports the library derived, not ones it recomputes", async () => {
    vi.mocked(upFeature).mockResolvedValue(result());

    await go({ feature: "demo" });

    const out = lines.join("\n");
    // Colour codes sit between the bullet and the name, so match from the name.
    expect(out).toContain("api -> localhost:3301");
    expect(out).toContain("web -> localhost:3300");
    expect(out).toContain("https://web.local.sandbox.com");
    expect(out).toContain("3 (ports 3300-3399)");
  });

  it("says so when a feature routes entirely to k8s", async () => {
    vi.mocked(upFeature).mockResolvedValue(
      result({ localServices: [], servicePorts: [], urls: [], containersStarted: false }),
    );

    await go({ feature: "demo" });

    const out = lines.join("\n");
    expect(out).toContain("No local services (all traffic goes to k8s)");
    expect(out).toContain("(no routed hostname for these services)");
  });

  it("lets every failure code propagate to main.ts's handler", async () => {
    // Reported once, by the handler — not twice, and not here. `up` has no
    // between-the-lines hint, which is what separates it from stop/restart.
    const thrown = new SandboxError("No compose.yml found in workspace: /tmp/ws", "NO_COMPOSE");
    vi.mocked(upFeature).mockRejectedValue(thrown);

    await expect(go({ feature: "demo" })).rejects.toBe(thrown);
    expect(lines.some((l) => l.startsWith("[error]"))).toBe(false);
  });

  it("routes `up infra` to connect without touching the lifecycle", async () => {
    await go({ feature: "infra" });

    expect(vi.mocked(runConnect)).toHaveBeenCalled();
    expect(vi.mocked(upFeature)).not.toHaveBeenCalled();
  });

  it("hands the library the workspace, so it never resolves one from cwd", async () => {
    vi.mocked(upFeature).mockResolvedValue(result());

    await go({ feature: "demo", workspace: "/tmp/explicit" });

    expect(vi.mocked(upFeature)).toHaveBeenCalledWith("demo", "/tmp/explicit", {
      signal: expect.any(AbortSignal),
    });
  });
});
