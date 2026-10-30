/**
 * SW-181 preemption, pinned before SW-185 moves it into the daemon: a person's
 * `up` with no room stops the autonomous feature, queues it at the back with
 * reason `preempted`, and is admitted. Docker is faked; the files are real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("werkmeister-core/proc", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/proc")>()),
  run: vi.fn(),
}));
vi.mock("werkmeister-core/compose", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/compose")>()),
  composeStop: vi.fn(async () => true),
}));
vi.mock("werkmeister-core/slots", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/slots")>()),
  getSlot: vi.fn(async () => 1),
}));

import { readWaiting } from "werkmeister-core/agent_state";
import { composeStop } from "werkmeister-core/compose";
import { admitOrQueue } from "werkmeister-core/lifecycle";
import { run } from "werkmeister-core/proc";
import { readQueue, writeLeases } from "werkmeister-core/scheduler_state";

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
