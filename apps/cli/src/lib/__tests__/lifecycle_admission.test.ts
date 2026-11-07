/**
 * SW-181 preemption, pinned before SW-185 moves it into the daemon: a person's
 * `up` with no room stops the autonomous feature, queues it at the back with
 * reason `preempted`, and is admitted. Docker is faked; the files are real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("werkmeister-core/proc", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/proc")>()),
  run: vi.fn(),
}));
vi.mock("werkmeister-core/compose", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/compose")>()),
  composeStop: vi.fn(async () => true),
  getContainerStatus: vi.fn(async () => []),
}));
vi.mock("werkmeister-core/slots", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/slots")>()),
  getSlot: vi.fn(async () => 1),
}));

import { readWaiting } from "werkmeister-core/agent_state";
import { composeStop, getContainerStatus } from "werkmeister-core/compose";
import { admitOrQueue, admitServiceStart } from "werkmeister-core/lifecycle";
import { run } from "werkmeister-core/proc";
import { enqueue, readQueue, writeLeases } from "werkmeister-core/scheduler_state";

const G = 2 ** 30;
let tmp: string;

function workspace(name: string, { autonomous }: { autonomous: boolean }): string {
  const ws = path.join(tmp, name);
  fs.mkdirSync(path.join(ws, ".werkmeister"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".werkmeister", "workspace.yml"), `autonomous: ${autonomous}\n`);
  fs.writeFileSync(
    path.join(ws, "compose.yml"),
    "services:\n  api:\n    deploy:\n      resources:\n        reservations: { memory: 1G }\n",
  );
  return ws;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "admission-"));
  fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 2G\n  cpus: 8\n");
  vi.stubEnv("WERKMEISTER_CONFIG_FILE", path.join(tmp, "config.yaml"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

it("a person's up stops the autonomous feature, queues it as preempted, and is admitted", async () => {
  const victim = workspace("victim", { autonomous: true });
  const mine = workspace("mine", { autonomous: false });
  writeLeases({ victim: { slot: 1, workspace: victim } });
  vi.mocked(run).mockImplementation((cmd: string[]) =>
    cmd[1] === "ps"
      ? { status: 0, stdout: "id1\n", stderr: "" }
      : {
          status: 0,
          stdout: `victim\t${victim}\t2026-10-30T10:00:00Z\t${1.5 * G}\t0\n`,
          stderr: "",
        },
  );

  expect(await admitOrQueue("mine", mine, true)).toBeNull();

  expect(composeStop).toHaveBeenCalledWith("victim");
  expect(readQueue()).toEqual(["victim"]);
  expect(readWaiting(victim)).toMatchObject({ position: 1, reason: "preempted" });
});

// SW-540: an on-demand service start (the gate, `feature up --service`) asks admission for what it adds.
describe("admitServiceStart", () => {
  const ON_DEMAND =
    "services:\n  api:\n    profiles: [on-demand]\n    deploy:\n      resources:\n        limits: { cpus: '3' }\n        reservations: { memory: 1G }\n";
  // Another feature holds *cpus* of the 8-CPU budget.
  const busy = (other: string, cpus: number) =>
    vi.mocked(run).mockImplementation((cmd: string[]) =>
      cmd[1] === "ps"
        ? { status: 0, stdout: "id1\n", stderr: "" }
        : {
            status: 0,
            stdout: `other\t${other}\t2026-11-06T10:00:00Z\t0\t${cpus * 1e9}\n`,
            stderr: "",
          },
    );

  it("waits in the queue with its position, then starts once room frees", async () => {
    const other = workspace("other", { autonomous: true });
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), ON_DEMAND);
    writeLeases({ mine: { slot: 2, workspace: mine } });
    busy(other, 7);
    let polls = 0;
    const sleep = async () => {
      expect(readQueue()).toEqual(["mine"]);
      expect(readWaiting(mine)).toMatchObject({ position: 1, services: ["api"] });
      if (++polls === 2) busy(other, 4);
    };
    await admitServiceStart("mine", mine, "api", { sleep });
    expect(polls).toBe(2);
    expect(readQueue()).toEqual([]);
    expect(readWaiting(mine)).toBeNull();
  });

  it("fails NO_CAPACITY after the wait and leaves the queue", async () => {
    const other = workspace("other", { autonomous: true });
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), ON_DEMAND);
    busy(other, 8);
    await expect(
      admitServiceStart("mine", mine, "api", { sleep: async () => {}, waitMs: 30_000 }),
    ).rejects.toMatchObject({
      code: "NO_CAPACITY",
      message: expect.stringContaining("other (8 CPUs"),
    });
    expect(readQueue()).toEqual([]);
    expect(readWaiting(mine)).toBeNull();
  });

  it("never preempts, even from a person's workspace: it waits instead", async () => {
    const other = workspace("other", { autonomous: true });
    const mine = workspace("mine", { autonomous: false });
    fs.writeFileSync(path.join(mine, "compose.yml"), ON_DEMAND);
    writeLeases({ other: { slot: 1, workspace: other } });
    busy(other, 8);
    vi.mocked(composeStop).mockClear();
    await expect(
      admitServiceStart("mine", mine, "api", { sleep: async () => {}, waitMs: 0 }),
    ).rejects.toMatchObject({ code: "NO_CAPACITY" });
    expect(composeStop).not.toHaveBeenCalled();
    expect(readQueue()).toEqual([]);
  });

  it("refuses while the feature is queued to come back whole (preempted), leaving its place", async () => {
    const other = workspace("other", { autonomous: true });
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), ON_DEMAND);
    writeLeases({ mine: { slot: 2, workspace: mine } });
    busy(other, 1);
    await enqueue("mine", mine);
    await expect(
      admitServiceStart("mine", mine, "api", { sleep: async () => expect.fail("waited") }),
    ).rejects.toMatchObject({ code: "NO_CAPACITY", message: expect.stringContaining("preempted") });
    expect(readQueue()).toEqual(["mine"]);
    expect(readWaiting(mine)).toMatchObject({ reason: "preempted" });
  });

  it("a service already running costs nothing again", async () => {
    const other = workspace("other", { autonomous: true });
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), ON_DEMAND);
    busy(other, 8);
    vi.mocked(getContainerStatus).mockResolvedValueOnce([
      { name: "mine-api", status: "running", service: "api" } as never,
    ]);
    await admitServiceStart("mine", mine, "api", { sleep: async () => expect.fail("waited") });
    expect(readQueue()).toEqual([]);
  });
});
