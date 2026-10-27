/**
 * What `sandbox stop`/`restart` still print now that the sequences live in
 * `werkmeister-core/lifecycle` and fail by throwing instead of exiting.
 *
 * The trap these cover: both commands print their next-step hint *between* the
 * error line and the exit. `main.ts`'s handler only knows how to print the
 * message, so letting a hinted code propagate would reorder the output — which
 * the migration design forbids. Anything unhinted must still propagate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxError } from "werkmeister-core/errors";
import type { Reporter } from "werkmeister-core/reporter";
import { withReporter } from "werkmeister-core/reporter";

import { makeRecorder } from "./helpers/recorder.js";

vi.mock("werkmeister-core/lifecycle", () => ({
  stop: vi.fn(),
  restart: vi.fn(),
  idleStopFeature: vi.fn(),
  stopIdle: vi.fn(),
}));
vi.mock("../../lib/dotenv.js", () => ({
  loadDotenv: vi.fn(() => ({})),
  findDotenv: vi.fn(() => null),
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));

import { spawn } from "node:child_process";
import {
  idleStopFeature,
  restart as restartFeature,
  stop as stopFeature,
  stopIdle,
} from "werkmeister-core/lifecycle";
import { findDotenv, loadDotenv } from "../../lib/dotenv.js";
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
    expect(lines.indexOf("[info] Start it with: werkmeister up demo")).toBe(
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

describe("sandbox stop --if-idle", () => {
  // Every case must leave exit alone: silent, no process.exit, no throw.
  const ifIdle = async () => {
    await go(() => runStop({ feature: null, if_idle: true }));
    expect(lines).toEqual([]);
    expect(process.exit).not.toHaveBeenCalled();
    expect(stopFeature).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    // The hook's stdin JSON is read only off a pipe; the exercise covers that read.
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    vi.mocked(spawn).mockClear();
    vi.mocked(idleStopFeature).mockReset();
    vi.mocked(findDotenv).mockReturnValue("/ws/demo/.env");
    vi.mocked(loadDotenv).mockReturnValue({ FEATURE: "demo" });
  });

  it("does nothing outside a workspace", async () => {
    vi.mocked(findDotenv).mockReturnValue(null);
    await ifIdle();
    expect(idleStopFeature).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does nothing when the idle check says to keep it (another session, infra, no FEATURE)", async () => {
    vi.mocked(idleStopFeature).mockReturnValue(null);
    await ifIdle();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("swallows a failure in the check", async () => {
    vi.mocked(idleStopFeature).mockImplementation(() => {
      throw new Error("boom");
    });
    await ifIdle();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("hands the stop to a detached `sandbox stop <feature>` rather than waiting on it", async () => {
    vi.mocked(idleStopFeature).mockReturnValue("demo");
    await ifIdle();
    expect(idleStopFeature).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "demo", workspaceRoot: "/ws/demo" }),
    );
    expect(spawn).toHaveBeenCalledOnce();
    const [, argv, opts] = vi.mocked(spawn).mock.calls[0];
    expect(argv.slice(1)).toEqual(["stop", "demo"]);
    expect(opts).toMatchObject({ cwd: "/ws/demo", detached: true, stdio: "ignore" });
  });
});

describe("sandbox stop --idle (SW-39)", () => {
  it("runs one reaper pass over every workspace and prints its lines", async () => {
    vi.mocked(stopIdle).mockResolvedValue({ ok: true, lines: ["demo: stopped (idle ≥ 30 min)"] });
    await go(() => runStop({ feature: null, idle: "30" }));
    expect(stopIdle).toHaveBeenCalledWith(30, { only: undefined });
    expect(lines).toContain("demo: stopped (idle ≥ 30 min)");
  });

  it("limits the pass to [feature]", async () => {
    vi.mocked(stopIdle).mockResolvedValue({ ok: true, lines: [] });
    await go(() => runStop({ feature: "demo", idle: "5" }));
    expect(stopIdle).toHaveBeenCalledWith(5, { only: "demo" });
  });

  it("rejects minutes that are not a whole number ≥ 1", async () => {
    vi.mocked(stopIdle).mockClear();
    for (const idle of ["0", "x", "1.5"])
      await expect(go(() => runStop({ feature: null, idle }))).rejects.toThrow(Exited);
    expect(stopIdle).not.toHaveBeenCalled();
  });

  it("exits 1 when a stop failed", async () => {
    vi.mocked(stopIdle).mockResolvedValue({ ok: false, lines: ["demo: stop failed — no"] });
    await expect(go(() => runStop({ feature: null, idle: "30" }))).rejects.toThrow(Exited);
  });
});

describe("sandbox restart", () => {
  it("hints at the logs after a failed restart, before exiting 1", async () => {
    vi.mocked(restartFeature).mockRejectedValue(
      new SandboxError("Failed to restart containers for 'demo'", "COMPOSE_RESTART_FAILED"),
    );

    await expect(go(() => runRestart({ feature: "demo" }))).rejects.toThrow(Exited);
    expect(lines.indexOf("[info] Check with: werkmeister logs demo")).toBe(
      lines.indexOf("[error] Failed to restart containers for 'demo'") + 1,
    );
  });
});
