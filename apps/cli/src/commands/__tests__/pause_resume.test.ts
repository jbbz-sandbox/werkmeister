/**
 * SW-70: `sandbox pause`/`resume` take the feature from the argument or the
 * cwd's `.env`, refuse the shared infra stack, and print a coded failure's hint
 * between the error line and the exit, as stop/restart do.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxError } from "werkmeister-core/errors";
import type { Reporter } from "werkmeister-core/reporter";
import { withReporter } from "werkmeister-core/reporter";

import { makeRecorder } from "./helpers/recorder.js";

vi.mock("werkmeister-core/lifecycle", () => ({ pause: vi.fn() }));
vi.mock("werkmeister-core", () => ({ resumeAndNudge: vi.fn() }));
vi.mock("werkmeister-core/compose", () => ({
  workspaceForFeature: vi.fn(() => "/ws/demo-ws"),
}));
vi.mock("../../lib/dotenv.js", () => ({ loadDotenv: vi.fn(() => ({})) }));

import { resumeAndNudge } from "werkmeister-core";
import { pause } from "werkmeister-core/lifecycle";
import { loadDotenv } from "../../lib/dotenv.js";
import { run as runPause } from "../pause.js";
import { run as runResume } from "../resume.js";

let lines: string[];
let recorder: Reporter;

class Exited extends Error {
  constructor(readonly status: number) {
    super(`exit ${status}`);
  }
}

beforeEach(() => {
  ({ lines, reporter: recorder } = makeRecorder());
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Exited(code ?? 0);
  }) as never);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(String(a[0] ?? ""));
  });
});

afterEach(() => vi.restoreAllMocks());

const go = (run: () => Promise<void>) => withReporter(recorder, run);

describe("sandbox pause", () => {
  it("pauses the .env feature and says how to resume", async () => {
    vi.mocked(loadDotenv).mockReturnValueOnce({ FEATURE: "demo" });
    vi.mocked(pause).mockResolvedValue({ feature: "demo", slot: 3, containers: ["a", "b"] });
    await go(() => runPause({ feature: null }));
    expect(pause).toHaveBeenCalledWith("demo");
    expect(lines.join("\n")).toMatch(/2 container\(s\) frozen.*sandbox resume demo/s);
  });

  it("refuses the shared infra stack", async () => {
    await expect(go(() => runPause({ feature: "infra" }))).rejects.toThrow(Exited);
    expect(pause).not.toHaveBeenCalled();
  });

  it("hints at resume when already paused, before exiting 1", async () => {
    vi.mocked(pause).mockRejectedValue(
      new SandboxError("'demo' is already paused", "ALREADY_PAUSED"),
    );
    await expect(go(() => runPause({ feature: "demo" }))).rejects.toThrow(Exited);
    expect(lines.indexOf("[info] Resume it with: sandbox resume demo")).toBe(
      lines.indexOf("[error] 'demo' is already paused") + 1,
    );
  });

  it("lets an unhinted failure propagate", async () => {
    vi.mocked(pause).mockRejectedValue(new Error("boom"));
    await expect(go(() => runPause({ feature: "demo" }))).rejects.toThrow("boom");
  });
});

describe("sandbox resume", () => {
  it("resumes the workspace the feature lives in and lists each container", async () => {
    vi.mocked(resumeAndNudge).mockResolvedValue({
      feature: "demo",
      workspace: "/ws/demo-ws",
      containers: [{ name: "demo-api", did: "unpaused" }],
      wasWorking: true,
      nudge: "headless",
    });
    await go(() => runResume({ feature: "demo" }));
    expect(resumeAndNudge).toHaveBeenCalledWith("demo-ws", "/ws/demo-ws", "demo");
    expect(lines).toContain("  demo-api: unpaused");
  });

  it("hints when there is nothing to resume", async () => {
    vi.mocked(resumeAndNudge).mockRejectedValue(
      new SandboxError("'demo' is not paused", "NOT_PAUSED"),
    );
    await expect(go(() => runResume({ feature: "demo" }))).rejects.toThrow(Exited);
    expect(lines).toContain("[info] Nothing to resume. Check with: sandbox status");
  });
});
