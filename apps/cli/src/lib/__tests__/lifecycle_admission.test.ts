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
const started: string[] = [];
vi.mock("werkmeister-core/docker", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/docker")>()),
  docker: () => ({ getContainer: (name: string) => ({ start: async () => started.push(name) }) }),
}));
vi.mock("werkmeister-core/reporter", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/reporter")>()),
  info: vi.fn(),
}));

import { readWaiting } from "werkmeister-core/agent_state";
import { composeStop, getContainerStatus } from "werkmeister-core/compose";
import { admitOrQueue, admitServiceStart } from "werkmeister-core/lifecycle";
import { run } from "werkmeister-core/proc";
import { info } from "werkmeister-core/reporter";
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

// SW-629: `feature up` and the gate's starts fail at once, never queue, when the cost exceeds the budget.
describe("a start larger than the whole budget", () => {
  const COST =
    "services:\n  api:\n    deploy:\n      resources:\n        limits: { cpus: '6' }\n        reservations: { memory: 1G }\n";
  beforeEach(() => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 2G\n  cpus: 4\n");
    vi.mocked(run).mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
  });

  it("fails NEVER_FITS from up's admission, naming the numbers and the fix", async () => {
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), COST);
    await expect(admitOrQueue("mine", mine, true)).rejects.toMatchObject({
      code: "NEVER_FITS",
      message: expect.stringMatching(/cost 6\.0 CPUs > budget 4.*budget\.cpus/s),
    });
    expect(readQueue()).toEqual([]);
    expect(readWaiting(mine)).toBeNull();
  });

  it("fails NEVER_FITS from a service start without polling", async () => {
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(
      path.join(mine, "compose.yml"),
      COST.replace("api:\n", "api:\n    profiles: [on-demand]\n"),
    );
    const sleep = vi.fn(async () => {});
    await expect(admitServiceStart("mine", mine, "api", { sleep })).rejects.toMatchObject({
      code: "NEVER_FITS",
    });
    expect(sleep).not.toHaveBeenCalled();
    expect(readQueue()).toEqual([]);
  });

  it("names memory when memory is what's over", async () => {
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(
      path.join(mine, "compose.yml"),
      COST.replace("'6'", "'1'").replace("1G", "3G"),
    );
    await expect(admitOrQueue("mine", mine, true)).rejects.toMatchObject({
      code: "NEVER_FITS",
      message: expect.stringMatching(/cost 3\.0 GiB memory > budget 2\.0 GiB.*budget\.memory/s),
    });
  });
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
    session(other); // working: SW-546 would otherwise take an idle holder's lease
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
    session(other); // working: SW-546 would otherwise take an idle holder's lease
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

  // The hooks' record of *ws*'s one session (SW-182): working, or parked on a question.
  const session = (ws: string, ask?: string) => {
    const at = new Date().toISOString();
    fs.mkdirSync(path.join(ws, ".werkmeister", "sessions"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".werkmeister", "sessions", "s1.json"),
      JSON.stringify({
        status: "busy",
        at,
        last: at,
        ...(ask && { ask: { kind: "question", what: ask, at } }),
      }),
    );
  };

  it("never stops a working feature, even from a person's workspace: it waits instead", async () => {
    const other = workspace("other", { autonomous: true });
    session(other);
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

  // SW-546: a person's workspace parked on a question box holds its full reservation at 0% use.
  it("stops a feature whose session is waiting on a person, queues it as preempted, and starts", async () => {
    const other = workspace("other", { autonomous: false });
    session(other, "Approve the fix?");
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), ON_DEMAND);
    writeLeases({ other: { slot: 1, workspace: other } });
    busy(other, 8);
    vi.mocked(composeStop).mockClear();
    await admitServiceStart("mine", mine, "api", { sleep: async () => {}, waitMs: 0 });
    expect(composeStop).toHaveBeenCalledWith("other");
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("Stopped 'other' to make room: its session is waiting on a person"),
    );
    expect(readQueue()).toEqual(["other"]);
    expect(readWaiting(other)).toMatchObject({ position: 1, reason: "preempted" });
    expect(readWaiting(mine)).toBeNull();
  });

  it("refuses while the feature is queued to come back whole (preempted), leaving its place", async () => {
    const other = workspace("other", { autonomous: true });
    session(other); // working: SW-546 would otherwise take an idle holder's lease
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
    session(other); // working: SW-546 would otherwise take an idle holder's lease
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), ON_DEMAND);
    busy(other, 8);
    vi.mocked(getContainerStatus).mockResolvedValueOnce([
      { name: "mine-api", status: "running", service: "api" } as never,
    ]);
    await admitServiceStart("mine", mine, "api", { sleep: async () => expect.fail("waited") });
    expect(readQueue()).toEqual([]);
  });

  // SW-675: two features each holding core and each gate waiting for one more service deadlock a
  // full budget. *mineCpus*: what mine's own running core holds, or 0 once it is stopped.
  const both = (other: string, mine: string, otherCpus: number, mineCpus: () => number) =>
    vi.mocked(run).mockImplementation((cmd: string[]) =>
      cmd[1] === "ps"
        ? { status: 0, stdout: "id1\nid2\n", stderr: "" }
        : {
            status: 0,
            stdout:
              `other\t${other}\t2026-11-06T10:00:00Z\t0\t${otherCpus * 1e9}\n` +
              (mineCpus() ? `mine\t${mine}\t2026-11-06T10:00:00Z\t0\t${mineCpus() * 1e9}\n` : ""),
            stderr: "",
          },
    );
  const CORE_AND_API =
    "services:\n  core:\n    deploy:\n      resources:\n        limits: { cpus: '3' }\n  api:\n    profiles: [on-demand]\n    deploy:\n      resources:\n        limits: { cpus: '1' }\n";

  it("releases its own running containers while it waits, then starts them with the new one", async () => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 8G\n  cpus: 6\n");
    const other = workspace("other", { autonomous: true });
    session(other);
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), CORE_AND_API);
    writeLeases({ mine: { slot: 2, workspace: mine } });
    let mineCpus = 3;
    both(other, mine, 3, () => mineCpus);
    vi.mocked(getContainerStatus).mockResolvedValueOnce([
      { name: "mine-core", status: "running", service: "core" } as never,
    ]);
    vi.mocked(composeStop).mockImplementation(async (f: string) => {
      if (f === "mine") mineCpus = 0;
      return true;
    });
    started.length = 0;
    const sleep = async () => {
      // Released: it holds nothing and waits for core + api (4 CPUs) as one gate request.
      expect(composeStop).toHaveBeenCalledWith("mine");
      expect(readWaiting(mine)).toMatchObject({ services: ["core", "api"], gate: true });
      both(other, mine, 0, () => mineCpus); // the other gate finished
    };
    await admitServiceStart("mine", mine, "api", { sleep });
    expect(started).toEqual(["mine-core"]);
    expect(readQueue()).toEqual([]);
  });

  it("a person's workspace keeps its running containers while it waits (review, SW-675)", async () => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 8G\n  cpus: 6\n");
    const other = workspace("other", { autonomous: true });
    session(other);
    const mine = workspace("mine", { autonomous: false });
    fs.writeFileSync(path.join(mine, "compose.yml"), CORE_AND_API);
    writeLeases({ mine: { slot: 2, workspace: mine } });
    both(other, mine, 3, () => 3);
    vi.mocked(getContainerStatus).mockResolvedValueOnce([
      { name: "mine-core", status: "running", service: "core" } as never,
    ]);
    vi.mocked(composeStop).mockClear();
    await expect(
      admitServiceStart("mine", mine, "api", { sleep: async () => {}, waitMs: 0 }),
    ).rejects.toMatchObject({ code: "NO_CAPACITY" });
    expect(composeStop).not.toHaveBeenCalledWith("mine");
  });

  it("a timed-out wait names the holders, says it stayed stopped, and that a rerun needs no person", async () => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 8G\n  cpus: 6\n");
    const other = workspace("other", { autonomous: true });
    session(other);
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), CORE_AND_API);
    writeLeases({ other: { slot: 1, workspace: other }, mine: { slot: 2, workspace: mine } });
    let mineCpus = 3;
    both(other, mine, 3, () => mineCpus);
    vi.mocked(getContainerStatus).mockResolvedValueOnce([
      { name: "mine-core", status: "running", service: "core" } as never,
    ]);
    vi.mocked(composeStop).mockImplementation(async (f: string) => {
      if (f === "mine") mineCpus = 0;
      return true;
    });
    const err = await admitServiceStart("mine", mine, "api", {
      sleep: async () => {},
      waitMs: 0,
    }).catch((e) => e);
    expect(err).toMatchObject({ code: "NO_CAPACITY" });
    expect(err.message).toContain(
      "core stayed stopped; `werkmeister feature up` starts the feature again.",
    );
    expect(err.message).toContain("running: other (3 CPUs, 0.0 GiB, working)");
    expect(err.message).toContain("Rerun the same command; nothing to ask a person.");
    expect(readQueue()).toEqual([]);
  });
});
