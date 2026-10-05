/**
 * What `sandbox stop`/`restart` still print now that the sequences live in
 * `sandbox-core/lifecycle` and fail by throwing instead of exiting.
 *
 * The trap these cover: both commands print their next-step hint *between* the
 * error line and the exit. `main.ts`'s handler only knows how to print the
 * message, so letting a hinted code propagate would reorder the output — which
 * the migration design forbids. Anything unhinted must still propagate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SandboxError } from "sandbox-core/errors";
import type { Reporter } from "sandbox-core/reporter";
import { withReporter } from "sandbox-core/reporter";

import { makeRecorder } from "./helpers/recorder.js";

vi.mock("sandbox-core/lifecycle", () => ({ stop: vi.fn(), restart: vi.fn() }));
vi.mock("../../lib/dotenv.js", () => ({ loadDotenv: () => ({}) }));

import { restart as restartFeature, stop as stopFeature } from "sandbox-core/lifecycle";
import { run as runRestart } from "../restart.js";
import { run as runStop } from "../stop.js";

/** Everything the command emitted, in order, whichever helper produced it. */
let lines: string[];
let recorder: Reporter;

/** `process.exit` cannot return, so make it unwind like the real one ends the run. */
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
  // The banners and success blocks are `console.log`, not reporter events.
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(String(a[0] ?? ""));
  });
});

afterEach(() => vi.restoreAllMocks());

const go = (run: () => Promise<void>) => withReporter(recorder, run);

describe("sandbox stop", () => {
  it("prints the start-it hint after the error, then exits 1", async () => {
    vi.mocked(stopFeature).mockRejectedValue(
      new SandboxError("Feature 'demo' is not running (no slot allocated)", "NOT_RUNNING"),
    );

    await expect(go(() => runStop({ feature: "demo" }))).rejects.toThrow(Exited);
    expect(lines).toContain("[error] Feature 'demo' is not running (no slot allocated)");
    expect(lines.indexOf("[info] Start it with: sandbox up demo")).toBe(
      lines.indexOf("[error] Feature 'demo' is not running (no slot allocated)") + 1,
    );
  });

  it("lets a code with no hint propagate to main.ts's handler", async () => {
    // Reported once, by the handler — not twice, and not here.
    const thrown = new SandboxError("Failed to stop containers for 'demo'", "COMPOSE_STOP_FAILED");
    vi.mocked(stopFeature).mockRejectedValue(thrown);

    await expect(go(() => runStop({ feature: "demo" }))).rejects.toBe(thrown);
    expect(lines.some((l) => l.startsWith("[error]"))).toBe(false);
  });

  it("reports the preserved slot the library handed back", async () => {
    vi.mocked(stopFeature).mockResolvedValue({ feature: "demo", slot: 7 });

    await go(() => runStop({ feature: "demo" }));
    expect(lines.join("\n")).toContain("Slot 7 preserved");
  });
});

describe("sandbox restart", () => {
  it("hints at the logs after a failed restart, before exiting 1", async () => {
    vi.mocked(restartFeature).mockRejectedValue(
      new SandboxError("Failed to restart containers for 'demo'", "COMPOSE_RESTART_FAILED"),
    );

    await expect(go(() => runRestart({ feature: "demo" }))).rejects.toThrow(Exited);
    expect(lines.indexOf("[info] Check with: sandbox logs demo")).toBe(
      lines.indexOf("[error] Failed to restart containers for 'demo'") + 1,
    );
  });
});
