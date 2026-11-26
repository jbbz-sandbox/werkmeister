/**
 * SW-181 preemption, pinned before SW-185 moves it into the daemon: a person's
 * `up` with no room stops the autonomous feature, queues it at the back with
 * reason `preempted`, and is admitted. Docker is faked; the files are real.
 */

import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import nodeOs, * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ops: string[] = [];
vi.mock("werkmeister-core/scheduler_client", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/scheduler_client")>()),
  // Local as before; a grant is recorded and reported handed to the daemon.
  schedulerOp: async (op: string, _args: unknown, local: () => Promise<unknown>) => {
    ops.push(op);
    return op === "grant-later" ? 1 : local();
  },
}));
vi.mock("werkmeister-core/proc", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/proc")>()),
  run: vi.fn(),
}));
vi.mock("werkmeister-core/compose", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/compose")>()),
  composeStop: vi.fn(async () => true),
  composeRestart: vi.fn(async () => true),
  composeUpServiceAsync: vi.fn(async () => true),
  getContainerStatus: vi.fn(async () => []),
  workspaceForFeature: vi.fn(() => null),
}));
vi.mock("werkmeister-core/slots", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/slots")>()),
  getSlot: vi.fn(async () => 1),
}));
const started: string[] = [];
/** Containers with a `docker exec` still running in them (a gate row, an agent's test run). */
const execsIn = new Set<string>();
vi.mock("werkmeister-core/docker", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/docker")>()),
  docker: () => ({ getContainer: (name: string) => ({ start: async () => started.push(name) }) }),
  runningExecCommands: async (names: string[]) =>
    names.filter((n) => execsIn.has(n)).map(() => "sh -c npm test"),
}));
vi.mock("werkmeister-core/reporter", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/reporter")>()),
  info: vi.fn(),
}));

import { readLastStop, readWaiting, writeWaiting } from "werkmeister-core/agent_state";
import {
  composeStop,
  composeUpServiceAsync,
  getContainerStatus,
  workspaceForFeature,
} from "werkmeister-core/compose";
import {
  admitOrQueue,
  admitServiceStart,
  capacityWait,
  GATE_CAPACITY_WAIT_MS,
  grantAfterLoadDrop,
  restart,
  startsAsPerson,
  stop,
} from "werkmeister-core/lifecycle";
import { run } from "werkmeister-core/proc";
import { info } from "werkmeister-core/reporter";
import { enqueue, readQueue, writeLeases } from "werkmeister-core/scheduler_state";
import { getSlot } from "werkmeister-core/slots";

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

// SW-702: nothing recorded who stopped a feature or why, so its later grant could not say.
it("a preemption records why it stopped the victim in its workspace", async () => {
  const victim = workspace("victim", { autonomous: true });
  const mine = workspace("mine", { autonomous: false });
  writeLeases({ victim: { slot: 1, workspace: victim } });
  vi.mocked(workspaceForFeature).mockImplementation((f) => (f === "victim" ? victim : null));
  vi.mocked(run).mockImplementation((cmd: string[]) =>
    cmd[1] === "ps"
      ? { status: 0, stdout: "id1\n", stderr: "" }
      : {
          status: 0,
          stdout: `victim\t${victim}\t2026-10-30T10:00:00Z\t${1.5 * G}\t0\n`,
          stderr: "",
        },
  );
  try {
    expect(await admitOrQueue("mine", mine, true)).toBeNull();
  } finally {
    vi.mocked(workspaceForFeature).mockReset().mockReturnValue(null);
  }
  const last = JSON.parse(
    fs.readFileSync(path.join(victim, ".werkmeister", "last-stop.json"), "utf8"),
  );
  expect(last).toMatchObject({ why: "preempted to make room for 'mine'", killed: [] });
});

// Review: the record is best effort; a victim whose folder is gone (or unseen from a container) must still stop.
it("a preemption stops a victim whose workspace folder is gone", async () => {
  const victim = workspace("victim", { autonomous: true });
  const mine = workspace("mine", { autonomous: false });
  writeLeases({ victim: { slot: 1, workspace: victim } });
  vi.mocked(workspaceForFeature).mockImplementation((f) =>
    f === "victim" ? path.join(tmp, "gone") : null,
  );
  vi.mocked(composeStop).mockClear();
  vi.mocked(run).mockImplementation((cmd: string[]) =>
    cmd[1] === "ps"
      ? { status: 0, stdout: "id1\n", stderr: "" }
      : {
          status: 0,
          stdout: `victim\t${victim}\t2026-10-30T10:00:00Z\t${1.5 * G}\t0\n`,
          stderr: "",
        },
  );
  try {
    expect(await admitOrQueue("mine", mine, true)).toBeNull();
  } finally {
    vi.mocked(workspaceForFeature).mockReset().mockReturnValue(null);
  }
  expect(composeStop).toHaveBeenCalledWith("victim");
});

// SW-738: the stop "failed" yet killed the victim, and our start ran neither way; the victim never came back.
it("a victim whose stop fails is queued to come back, and the start waits at the head instead", async () => {
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
  vi.mocked(composeStop).mockResolvedValueOnce(false);

  expect(await admitOrQueue("mine", mine, true)).toBe(1);

  expect(readQueue()).toEqual(["mine", "victim"]);
  expect(readWaiting(victim)).toMatchObject({ reason: "preempted" });
  expect(readWaiting(mine)).toMatchObject({ position: 1, reason: "waiting for capacity" });
});

// SW-932: SW-909's branch. A re-up of a running feature whose preemption's stop fails waits unqueued:
// requeueFirst would write a whole-feature waiting.json over its live containers. The start of a
// feature that isn't running still goes back to the head (the test above).
it("a re-up of a running feature whose victim's stop fails leaves no queue entry and no waiting.json", async () => {
  const victim = workspace("victim", { autonomous: true });
  const mine = workspace("mine", { autonomous: false });
  writeLeases({ victim: { slot: 1, workspace: victim }, mine: { slot: 2, workspace: mine } });
  // `mine` runs an on-demand service only, so its re-up adds `api` (1G) to a 2G budget 1.9G holds.
  vi.mocked(run).mockImplementation((cmd: string[]) =>
    cmd[1] === "ps"
      ? { status: 0, stdout: "id1\nid2\n", stderr: "" }
      : {
          status: 0,
          stdout:
            `victim\t${victim}\t2026-10-30T10:00:00Z\t${1.5 * G}\t0\t0\tapi\n` +
            `mine\t${mine}\t2026-10-30T10:00:00Z\t${0.4 * G}\t0\t0\tdocs\n`,
          stderr: "",
        },
  );
  vi.mocked(composeStop).mockRejectedValueOnce(new Error("daemon hung up"));

  expect(await admitOrQueue("mine", mine, true)).toBe(1);

  expect(composeStop).toHaveBeenCalledWith("victim");
  // The victim no longer runs, so it is queued to come back; `mine` is not.
  expect(readQueue()).toEqual(["victim"]);
  expect(readWaiting(mine)).toBeNull();
});

// SW-992 review: with CPUs uncapped by default the needs/free line vanished, though memory still gates.
it("with no budget.cpus, the queue's needs/free line names memory only", async () => {
  fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 2G\n");
  vi.mocked(run).mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
  const text = await capacityWait("mine", 1, true, { cpus: 3, memory: G });
  expect(text).toContain("this start needs 1.0 GiB; free 2.0 GiB of the budget's 2.0 GiB");
});

// SW-1236: at a Mac load of 309 the scheduler still admitted starts, by CPU and memory alone.
describe("the Mac's load (budget.host_load_mac)", () => {
  /** os.loadavg() as core reads it: its `import * as os` sees a spy only after syncBuiltinESMExports. */
  let spy: ReturnType<typeof vi.spyOn> | undefined;
  const setLoad = (one: number) => {
    spy ??= vi.spyOn(nodeOs, "loadavg");
    spy.mockReturnValue([one, one, one]);
    syncBuiltinESMExports();
  };
  const platform = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { value: p });
  const realPlatform = process.platform;
  beforeEach(() => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 2G\n  host_load_mac: 4\n");
    vi.mocked(run).mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
    platform("darwin");
  });
  afterEach(() => {
    platform(realPlatform);
    spy?.mockRestore();
    spy = undefined;
    syncBuiltinESMExports();
  });

  it("holds a start that fits the budget while it is over the limit, says why, and admits it once it falls", async () => {
    const mine = workspace("mine", { autonomous: true });
    setLoad(50);
    expect(await admitOrQueue("mine", mine, false)).toBe(1);
    expect(readQueue()).toEqual(["mine"]);
    expect(readWaiting(mine)).toMatchObject({ position: 1, reason: "waiting for host load" });
    expect(await capacityWait("mine", 1, true, { cpus: 0, memory: G })).toContain(
      "host load 50.0 is over 4 (budget.host_load_mac): every start waits for it to fall; budget.host_load_mac: 0 turns it off",
    );
    setLoad(2);
    expect(await admitOrQueue("mine", mine, false)).toBeNull();
    expect(readQueue()).toEqual([]);
    expect(readWaiting(mine)).toBeNull();
  });

  it("holds a person's start too, without preempting anyone", async () => {
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
    vi.mocked(composeStop).mockClear();
    setLoad(50);
    expect(await admitOrQueue("mine", mine, true)).toBe(1);
    expect(composeStop).not.toHaveBeenCalled();
  });

  it("admits at the limit itself, with budget.host_load_mac 0, and off macOS", async () => {
    const mine = workspace("mine", { autonomous: true });
    setLoad(4);
    expect(await admitOrQueue("mine", mine, false)).toBeNull();
    setLoad(50);
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 2G\n  host_load_mac: 0\n");
    expect(await admitOrQueue("mine", mine, false)).toBeNull();
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 2G\n  host_load_mac: 4\n");
    platform("linux");
    expect(await admitOrQueue("mine", mine, false)).toBeNull();
  });

  it("defaults to 4 × cores", async () => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 2G\n");
    const mine = workspace("mine", { autonomous: true });
    setLoad(4 * os.availableParallelism() + 1);
    expect(await admitOrQueue("mine", mine, false)).toBe(1);
  });

  it("the daemon's tick grants a waiter held by load once the load falls, and no other", async () => {
    const mine = workspace("mine", { autonomous: true });
    writeLeases({ mine: { slot: 1, workspace: mine } });
    const grant = vi.fn(() => 1);
    setLoad(50);
    expect(await admitOrQueue("mine", mine, false)).toBe(1);
    expect(grantAfterLoadDrop(grant)).toBe(false);
    setLoad(2);
    expect(grantAfterLoadDrop(grant)).toBe(true);
    expect(grant).toHaveBeenCalledTimes(1);
    // A wait for CPUs or memory is a release's to grant, not the tick's.
    writeWaiting(mine, { position: 1, reason: "waiting for capacity" });
    expect(grantAfterLoadDrop(grant)).toBe(false);
    expect(grant).toHaveBeenCalledTimes(1);
  });
});

// SW-831: a queued victim whose containers still ran had its agent's commands held over them.
it("a victim whose stop fails while a container still runs is left alone; the start waits at the head", async () => {
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
  vi.mocked(composeStop).mockResolvedValueOnce(false);
  vi.mocked(getContainerStatus).mockResolvedValueOnce([
    {
      name: "victim-api-1",
      status: "running",
      health: "",
      ports: "",
      service: "api",
      role: "",
      exitCode: 0,
    },
  ]);

  expect(await admitOrQueue("mine", mine, true)).toBe(1);

  expect(getContainerStatus).toHaveBeenCalledWith("victim");
  expect(readQueue()).toEqual(["mine"]);
  expect(readWaiting(victim)).toBeNull();
  expect(readWaiting(mine)).toMatchObject({ position: 1, reason: "waiting for capacity" });
});

// SW-713: restart skipped the queue, so a queued feature ran again while its session stayed held.
it("a restart of a queued feature takes it out of the queue and releases its session", async () => {
  const ws = workspace("queued", { autonomous: true });
  await enqueue("queued", ws);
  vi.mocked(workspaceForFeature).mockReturnValueOnce(ws);

  await restart("queued");

  expect(readQueue()).toEqual([]);
  expect(readWaiting(ws)).toBeNull();
});

it("a plain up from an agent session in a person's workspace is not a person's start", () => {
  const ws = workspace("person", { autonomous: false });
  expect(startsAsPerson(ws, {})).toBe(true);
  expect(startsAsPerson(ws, { CLAUDECODE: "1" })).toBe(false);
  expect(startsAsPerson(workspace("agent", { autonomous: true }), {})).toBe(false);
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

  // SW-869: a gate gave up at 10 min, which dropped its place; it now waits the whole command's budget in place.
  it("a gate's start waits past 10 min in its place, keeping its wait, then starts", async () => {
    const other = workspace("other", { autonomous: true });
    session(other);
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), ON_DEMAND);
    writeLeases({ mine: { slot: 2, workspace: mine } });
    busy(other, 7);
    let polls = 0;
    let since: string | undefined;
    const sleep = async () => {
      since ??= readWaiting(mine)?.since;
      expect(readWaiting(mine)?.since).toBe(since);
      if (++polls === 41) busy(other, 4); // 41 polls of 15 s: past the 10-min service wait
    };
    await admitServiceStart("mine", mine, "api", { sleep, waitMs: GATE_CAPACITY_WAIT_MS });
    expect(polls).toBe(41);
    expect(readQueue()).toEqual([]);
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

  // SW-1017: it asks for less than the queued whole start, so it replaces it rather than being refused.
  it("replaces a whole start queued to come back (preempted), and starts at once when it fits", async () => {
    const other = workspace("other", { autonomous: true });
    session(other); // working: SW-546 would otherwise take an idle holder's lease
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), ON_DEMAND);
    writeLeases({ mine: { slot: 2, workspace: mine } });
    busy(other, 1);
    await enqueue("mine", mine);
    await admitServiceStart("mine", mine, "api", { sleep: async () => expect.fail("waited") });
    expect(readQueue()).toEqual([]);
    expect(readWaiting(mine)).toBeNull();
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
    vi.mocked(composeUpServiceAsync).mockClear();
    const sleep = async () => {
      // Released: it holds nothing and waits for core + api (4 CPUs) as one gate request.
      expect(composeStop).toHaveBeenCalledWith("mine");
      expect(readWaiting(mine)).toMatchObject({ services: ["core", "api"], gate: true });
      expect(readLastStop(mine)?.why).toBe("the capacity wait to start api released it");
      both(other, mine, 0, () => mineCpus); // the other gate finished
    };
    await admitServiceStart("mine", mine, "api", { sleep });
    // SW-1080: back up, so the stop is over and no later grant reports it.
    expect(readLastStop(mine)).toBeNull();
    // SW-686: through compose, in its dependency order with health waits, not docker start by name.
    expect(composeUpServiceAsync).toHaveBeenCalledWith(
      "mine",
      ["core"],
      path.join(mine, "compose.yml"),
      true,
    );
    expect(readQueue()).toEqual([]);
  });

  it("a released set that fails to come back names what stayed stopped (SW-686)", async () => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 8G\n  cpus: 6\n");
    const other = workspace("other", { autonomous: true });
    session(other);
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), CORE_AND_API);
    writeLeases({ mine: { slot: 2, workspace: mine } });
    let mineCpus = 3;
    both(other, mine, 3, () => mineCpus);
    vi.mocked(getContainerStatus)
      .mockResolvedValueOnce([{ name: "mine-core", status: "running", service: "core" } as never])
      .mockResolvedValueOnce([{ name: "mine-core", status: "exited", service: "core" } as never]);
    vi.mocked(composeStop).mockImplementation(async (f: string) => {
      if (f === "mine") mineCpus = 0;
      return true;
    });
    vi.mocked(composeUpServiceAsync).mockResolvedValueOnce(false);
    const sleep = async () => both(other, mine, 0, () => mineCpus);
    const err = await admitServiceStart("mine", mine, "api", { sleep }).catch((e) => e);
    expect(err).toMatchObject({ code: "COMPOSE_UP_FAILED" });
    expect(err.message).toContain("still stopped: mine-core");
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

  // SW-741: which of a waiting workspace's own containers run, per wait.
  it("a gate's wait stops only its own set, never the holder's, and brings back only what ran (SW-741)", async () => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 8G\n  cpus: 6\n");
    const other = workspace("other", { autonomous: true });
    session(other);
    const mine = workspace("mine", { autonomous: true });
    // worker starts on `up` but had exited before the wait: it must stay stopped.
    fs.writeFileSync(
      path.join(mine, "compose.yml"),
      `${CORE_AND_API}  worker:\n    deploy:\n      resources:\n        limits: { cpus: '1' }\n`,
    );
    writeLeases({ mine: { slot: 2, workspace: mine } });
    let mineCpus = 3;
    both(other, mine, 3, () => mineCpus);
    vi.mocked(getContainerStatus).mockResolvedValueOnce([
      { name: "mine-core", status: "running", service: "core" } as never,
      { name: "mine-worker", status: "exited", service: "worker" } as never,
    ]);
    vi.mocked(composeStop).mockClear();
    vi.mocked(composeStop).mockImplementation(async (f: string) => {
      if (f === "mine") mineCpus = 0;
      return true;
    });
    vi.mocked(composeUpServiceAsync).mockClear();
    started.length = 0;
    let polls = 0;
    const sleep = async () => {
      polls++;
      both(other, mine, 0, () => mineCpus);
    };
    await admitServiceStart("mine", mine, "api", { sleep, waitMs: GATE_CAPACITY_WAIT_MS });
    expect(polls).toBe(1); // the wait ran
    expect(vi.mocked(composeStop).mock.calls).toEqual([["mine"]]);
    expect(composeUpServiceAsync).toHaveBeenCalledTimes(1);
    expect(composeUpServiceAsync).toHaveBeenCalledWith(
      "mine",
      ["core"],
      path.join(mine, "compose.yml"),
      true,
    );
    expect(started).toEqual([]);
  });

  it("a whole up queued for capacity, with nothing of its own running, stops and starts nothing (SW-741)", async () => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 8G\n  cpus: 6\n");
    const other = workspace("other", { autonomous: true });
    session(other); // working: never preempted
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), CORE_AND_API);
    writeLeases({ mine: { slot: 2, workspace: mine } });
    both(other, mine, 6, () => 0);
    vi.mocked(composeStop).mockClear();
    vi.mocked(composeUpServiceAsync).mockClear();
    started.length = 0;
    expect(await admitOrQueue("mine", mine, false)).toBe(1);
    expect(readWaiting(mine)).toMatchObject({ position: 1 }); // the wait ran: it is queued
    expect(composeStop).not.toHaveBeenCalled();
    expect(composeUpServiceAsync).not.toHaveBeenCalled();
    expect(started).toEqual([]);
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
    // SW-763: what was asked against what was free (core + api after the release).
    expect(err.message).toContain(
      "this start needs 4 CPUs, 0.0 GiB; free 3 CPUs, 8.0 GiB of the budget's 6 CPUs, 8.0 GiB",
    );
    expect(err.message).toContain("Rerun the same command; nothing to ask a person.");
    expect(readQueue()).toEqual([]);
  });

  // SW-1080: the gate's rows read "werkmeister recorded no stop" for the gate's own release.
  it("a release records why it stopped the set, for the gate's stopped-while-this-row-ran note", async () => {
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
    await expect(
      admitServiceStart("mine", mine, "api", { sleep: async () => {}, waitMs: 0 }),
    ).rejects.toMatchObject({ code: "NO_CAPACITY" });
    expect(readLastStop(mine)).toMatchObject({
      why: "the capacity wait to start api released it",
      killed: [],
    });
  });

  // SW-1080: a release while another process's row ran in the set SIGTERMed it (exit 143).
  it("holds its set while a docker exec runs in it, and releases once it ends", async () => {
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
    vi.mocked(composeStop).mockClear();
    vi.mocked(composeStop).mockImplementation(async (f: string) => {
      if (f === "mine") mineCpus = 0;
      return true;
    });
    execsIn.add("mine-core");
    let polls = 0;
    const sleep = async () => {
      polls++;
      expect(composeStop).not.toHaveBeenCalledWith("mine");
      execsIn.delete("mine-core"); // the row ended
    };
    try {
      await expect(
        admitServiceStart("mine", mine, "api", { sleep, waitMs: 15_000 }),
      ).rejects.toMatchObject({ code: "NO_CAPACITY" });
    } finally {
      execsIn.clear();
    }
    expect(polls).toBe(1);
    expect(composeStop).toHaveBeenCalledWith("mine");
  });

  // SW-1115: an exec that never ends (watch mode, a shell) held the set for the whole 30 min wait.
  it("releases its set under a docker exec that never ends once the hold has lasted 5 min", async () => {
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
    vi.mocked(composeStop).mockClear();
    let releasedAfter = -1;
    let polls = 0;
    vi.mocked(composeStop).mockImplementation(async (f: string) => {
      if (f === "mine") {
        mineCpus = 0;
        releasedAfter = polls;
      }
      return true;
    });
    execsIn.add("mine-core");
    try {
      await expect(
        admitServiceStart("mine", mine, "api", {
          sleep: async () => {
            polls++;
          },
          waitMs: GATE_CAPACITY_WAIT_MS,
        }),
      ).rejects.toMatchObject({ code: "NO_CAPACITY" });
    } finally {
      execsIn.clear();
    }
    // 5 min of 15 s polls held, then released, writing why as any release does.
    expect(releasedAfter).toBe(20);
    expect(readLastStop(mine)).toMatchObject({
      why: "the capacity wait to start api released it",
    });
  });

  // SW-737: it released core with stop(grant: false); giving up left that room to nobody.
  it("a released start that times out runs a grant for those still waiting", async () => {
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
    await enqueue("later", workspace("later", { autonomous: true }));
    ops.length = 0;
    await expect(
      admitServiceStart("mine", mine, "api", { sleep: async () => {}, waitMs: 0 }),
    ).rejects.toMatchObject({ code: "NO_CAPACITY" });
    expect(ops.at(-1)).toBe("grant-later");
    expect(readQueue()).toEqual(["later"]);
  });

  // SW-701: the timed-out start lost its place, and each rerun joined the back with a fresh wait.
  it("a parked start that times out keeps its place, and a rerun keeps its wait", async () => {
    const other = workspace("other", { autonomous: true });
    session(other);
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), ON_DEMAND);
    writeLeases({ mine: { slot: 2, workspace: mine } });
    busy(other, 7);
    const opts = { sleep: async () => {}, waitMs: 0, park: true };
    const err = await admitServiceStart("mine", mine, "api", opts).catch((e) => e);
    expect(err).toMatchObject({ code: "NO_CAPACITY" });
    expect(err.message).toContain("it stays queued");
    expect(err.message).toContain("It starts by itself when room frees");
    expect(readQueue()).toEqual(["mine"]);
    const first = readWaiting(mine);
    expect(first).toMatchObject({ services: ["api"], parked: { service: "api" } });

    await expect(admitServiceStart("mine", mine, "api", opts)).rejects.toMatchObject({
      code: "NO_CAPACITY",
    });
    expect(readQueue()).toEqual(["mine"]);
    expect(readWaiting(mine)?.since).toBe(first?.since);
  });

  it("a start that released its containers does not park: the grant could not bring them back", async () => {
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
    await expect(
      admitServiceStart("mine", mine, "api", { sleep: async () => {}, waitMs: 0, park: true }),
    ).rejects.toMatchObject({ code: "NO_CAPACITY" });
    expect(readQueue()).toEqual([]);
    expect(readWaiting(mine)).toBeNull();
  });

  // SW-873: the grant pass released the workspace's own set with no wait, so it could not park: dropped silently.
  it("the grant pass's parked start keeps its running containers and stays parked", async () => {
    fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 8G\n  cpus: 6\n");
    const other = workspace("other", { autonomous: true });
    session(other);
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), CORE_AND_API);
    writeLeases({ other: { slot: 1, workspace: other }, mine: { slot: 2, workspace: mine } });
    both(other, mine, 3, () => 3);
    vi.mocked(getContainerStatus).mockResolvedValueOnce([
      { name: "mine-core", status: "running", service: "core" } as never,
    ]);
    vi.mocked(composeStop).mockClear();
    const opts = { sleep: async () => {}, waitMs: 0, park: true, grant: false };
    await expect(admitServiceStart("mine", mine, "api", opts)).rejects.toMatchObject({
      code: "NO_CAPACITY",
    });
    expect(composeStop).not.toHaveBeenCalledWith("mine");
    expect(readQueue()).toEqual(["mine"]);
    expect(readWaiting(mine)).toMatchObject({ parked: { service: "api" } });
  });

  it("a start that gives up with nobody else waiting runs no grant", async () => {
    const other = workspace("other", { autonomous: true });
    session(other);
    const mine = workspace("mine", { autonomous: true });
    fs.writeFileSync(path.join(mine, "compose.yml"), ON_DEMAND);
    writeLeases({ mine: { slot: 2, workspace: mine } });
    busy(other, 7);
    ops.length = 0;
    await expect(
      admitServiceStart("mine", mine, "api", { sleep: async () => {}, waitMs: 0 }),
    ).rejects.toMatchObject({ code: "NO_CAPACITY" });
    expect(ops).not.toContain("grant-later");
  });
});

// SW-1017: a queued whole start outlived `feature stop`, and refused the smaller `--service` start.
describe("a queued whole start", () => {
  beforeEach(() =>
    vi.mocked(run).mockImplementation(() => ({ status: 0, stdout: "", stderr: "" })),
  );

  it("leaves the queue on the feature's own stop, not on preemption's", async () => {
    const mine = workspace("mine", { autonomous: true });
    writeLeases({ mine: { slot: 2, workspace: mine } });
    await enqueue("mine", mine);
    await stop("mine", { grant: false, why: "preempted to make room for 'x'" });
    expect(readQueue()).toEqual(["mine"]);
    await stop("mine");
    expect(readQueue()).toEqual([]);
    expect(readWaiting(mine)).toBeNull();
  });

  it("a start queued before it ever ran leaves the queue and returns no slot, not NOT_RUNNING", async () => {
    const mine = workspace("mine", { autonomous: true });
    await enqueue("mine", mine);
    vi.mocked(getSlot).mockResolvedValue(null);
    vi.mocked(workspaceForFeature).mockImplementation((f) => (f === "mine" ? mine : null));
    expect(await stop("mine")).toEqual({ feature: "mine", slot: null });
    expect(readQueue()).toEqual([]);
    expect(readWaiting(mine)).toBeNull();
    await expect(stop("mine")).rejects.toMatchObject({ code: "NOT_RUNNING" });
    vi.mocked(getSlot).mockResolvedValue(1);
  });
});
