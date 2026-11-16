/**
 * SW-737: a service start admitted on its first poll ran no grant, so a whole-feature waiter that fit
 * the room left over waited for an unrelated stop. The grant runs after the start, so the started
 * service is already counted. Docker and the slot are faked; the queue files are real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ops: string[] = [];
vi.mock("werkmeister-core/scheduler_client", async (orig) => {
  const real = await orig<typeof import("werkmeister-core/scheduler_client")>();
  return {
    ...real,
    // The daemon's side of a grant: record it and report it handed off.
    schedulerOp: async (op: string, _args: unknown, local: () => Promise<unknown>) => {
      ops.push(op);
      return op === "grant-later" ? 1 : local();
    },
  };
});
vi.mock("werkmeister-core/proc", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/proc")>()),
  run: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })), // docker ps: nothing runs
}));
vi.mock("werkmeister-core/compose", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/compose")>()),
  composeUpServiceAsync: vi.fn(async () => {
    ops.push("compose-up");
    return true;
  }),
  getContainerStatus: vi.fn(async () => []),
}));
vi.mock("werkmeister-core/caddy", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/caddy")>()),
  ensureSharedNetwork: () => true,
}));
vi.mock("werkmeister-core/config", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/config")>()),
  loadPorts: () => ({ slots: { start: 11000, size: 20 } }),
  loadServices: () => ({}),
}));
vi.mock("werkmeister-core/generate", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/generate")>()),
  isFeatureComposeStale: () => false,
  writeServiceSecretEnvs: () => {},
}));
vi.mock("werkmeister-core/slots", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/slots")>()),
  requireLeasedSlot: async () => 2,
  getPortRange: () => [11020, 11039],
}));
vi.mock("werkmeister-core/reporter", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/reporter")>()),
  info: vi.fn(),
}));

import { readNudge, readWaiting, writeWaiting } from "werkmeister-core/agent_state";
import { composeUpServiceAsync } from "werkmeister-core/compose";
import { grantWaiters, startService } from "werkmeister-core/lifecycle";
import { enqueue, readQueue, writeLeases } from "werkmeister-core/scheduler_state";

let tmp: string;
let mine: string;

beforeEach(() => {
  ops.length = 0;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "service-grant-"));
  fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 8G\n  cpus: 6\n");
  vi.stubEnv("WERKMEISTER_CONFIG_FILE", path.join(tmp, "config.yaml"));
  mine = path.join(tmp, "mine");
  fs.mkdirSync(path.join(mine, ".werkmeister"), { recursive: true });
  fs.writeFileSync(path.join(mine, ".werkmeister", "workspace.yml"), "autonomous: true\n");
  fs.writeFileSync(path.join(mine, ".env"), "WERKMEISTER_SLOT=2\nSERVICES=\n");
  fs.writeFileSync(
    path.join(mine, "compose.yml"),
    "services:\n  api:\n    profiles: [on-demand]\n    deploy:\n      resources:\n        limits: { cpus: '1' }\n",
  );
  writeLeases({ mine: { slot: 2, workspace: mine } });
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

it("a start admitted on its first poll runs a grant after it starts when someone waits", async () => {
  const other = path.join(tmp, "other");
  fs.mkdirSync(path.join(other, ".werkmeister"), { recursive: true });
  await enqueue("other", other);
  await startService("mine", mine, "api");
  expect(ops).toEqual(["admit", "compose-up", "grant-later"]);
  expect(readQueue()).toEqual(["other"]);
});

// SW-701: a parked --service start has no poll; the grant starts it and wakes its session.
it("a grant starts a parked service start that fits, with no grant of its own inside", async () => {
  await enqueue("mine", mine);
  writeWaiting(mine, {
    position: 1,
    reason: "waiting for capacity",
    services: ["api"],
    since: "2026-11-16T00:00:00.000Z",
    parked: { service: "api" },
  });
  ops.length = 0;
  expect(await grantWaiters()).toEqual(["mine"]);
  expect(ops.filter((o) => o !== "grant")).toEqual(["admit", "compose-up"]);
  expect(readQueue()).toEqual([]);
  expect(readWaiting(mine)).toBeNull();
});

it("a parked start whose compose up fails tells its session (SW-701 review)", async () => {
  await enqueue("mine", mine);
  writeWaiting(mine, {
    position: 1,
    reason: "waiting for capacity",
    services: ["api"],
    since: "2026-11-16T00:00:00.000Z",
    parked: { service: "api" },
  });
  vi.mocked(composeUpServiceAsync).mockResolvedValueOnce(false);
  expect(await grantWaiters()).toEqual([]);
  expect(readNudge(mine)).toContain("Could not start 'mine' api from the waiting queue");
});

it("runs no grant when nobody waits", async () => {
  await startService("mine", mine, "api");
  expect(ops).toEqual(["admit", "compose-up"]);
});
