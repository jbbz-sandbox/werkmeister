/**
 * SW-1110: a queued feature that a gate starts directly. The grant pass read the queue, then ran a
 * whole `up` beside the gate's `--service` start: the two `docker compose up`s on one project
 * SIGTERMed the gate's container and failed the grant's, whose "Could not start" reached the session
 * for a feature that was up. Compose is faked: an `up` that overlaps another start of the same
 * feature fails, as docker's did, and counts as a SIGTERM. The queue files are real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("werkmeister-core/scheduler_client", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/scheduler_client")>()),
  // Nothing else waits: a handed-off grant has nobody to start.
  schedulerOp: async (op: string, _args: unknown, local: () => Promise<unknown>) =>
    op === "grant-later" ? 0 : local(),
}));
vi.mock("werkmeister-core/proc", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/proc")>()),
  run: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })), // docker ps: nothing runs
}));
const starts: string[] = [];
let inFlight = 0;
let sigterms = 0;
/** One `docker compose up` that takes a while; starting beside another counts as a SIGTERM. */
async function compose(what: string): Promise<void> {
  if (inFlight > 0) sigterms++;
  inFlight++;
  starts.push(what);
  await new Promise((r) => setTimeout(r, 50));
  inFlight--;
}
vi.mock("werkmeister-core/compose", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/compose")>()),
  // The whole `up` fails when another start overlapped it, as the grant's did.
  composeUpAsync: vi.fn(async () => {
    const before = sigterms;
    const done = compose("up");
    onWholeStart?.();
    await done;
    return sigterms === before;
  }),
  composeUpServiceAsync: vi.fn(async () => {
    await compose("service");
    return true;
  }),
  composeStop: vi.fn(async () => true),
  getContainerStatus: vi.fn(async () => []),
}));
let onWholeStart: (() => void) | undefined;
vi.mock("werkmeister-core/caddy", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/caddy")>()),
  ensureSharedNetwork: () => true,
  isCaddyRunning: async () => false,
}));
vi.mock("werkmeister-core/config", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/config")>()),
  loadPorts: () => ({ slots: { start: 11000, size: 20 } }),
  loadServices: () => ({}),
}));
vi.mock("werkmeister-core/generate", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/generate")>()),
  generateCaddyfile: async () => {},
  generateSupergraphConfig: () => null,
  isFeatureComposeStale: () => false,
  writeServiceSecretEnvs: () => {},
}));
vi.mock("werkmeister-core/slots", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/slots")>()),
  requireLeasedSlot: async () => 2,
  getPortRange: () => [11020, 11039],
}));
vi.mock("werkmeister-core/scheduler_state", async (orig) => {
  const real = await orig<typeof import("werkmeister-core/scheduler_state")>();
  return { ...real, waitForSetupLoad: vi.fn(async () => {}) };
});
vi.mock("werkmeister-core/reporter", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/reporter")>()),
  info: vi.fn(),
  warn: vi.fn(),
  success: vi.fn(),
  raw: vi.fn(),
}));

import { readNudge, readWaiting } from "werkmeister-core/agent_state";
import { composeStop, composeUpAsync } from "werkmeister-core/compose";
import { grantWaiters, startService } from "werkmeister-core/lifecycle";
import {
  dequeue,
  enqueue,
  readQueue,
  waitForSetupLoad,
  writeLeases,
} from "werkmeister-core/scheduler_state";

let tmp: string;
let mine: string;

beforeEach(() => {
  starts.length = 0;
  inFlight = 0;
  sigterms = 0;
  onWholeStart = undefined;
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "queue-race-"));
  fs.writeFileSync(path.join(tmp, "config.yaml"), "budget:\n  memory: 8G\n  cpus: 6\n");
  vi.stubEnv("WERKMEISTER_CONFIG_FILE", path.join(tmp, "config.yaml"));
  mine = path.join(tmp, "mine");
  fs.mkdirSync(path.join(mine, ".werkmeister"), { recursive: true });
  fs.writeFileSync(path.join(mine, ".werkmeister", "workspace.yml"), "autonomous: true\n");
  fs.writeFileSync(path.join(mine, ".env"), "WERKMEISTER_SLOT=2\nSERVICES=web\n");
  // web is the plain `up`; api is the on-demand service the gate starts.
  fs.writeFileSync(
    path.join(mine, "compose.yml"),
    "services:\n" +
      "  web:\n    deploy:\n      resources:\n        limits: { cpus: '1' }\n" +
      "  api:\n    profiles: [on-demand]\n    deploy:\n      resources:\n        limits: { cpus: '1' }\n",
  );
  writeLeases({ mine: { slot: 2, workspace: mine } });
});
afterEach(() => {
  vi.mocked(waitForSetupLoad).mockReset().mockResolvedValue(undefined);
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function expectOneStartNoKillNoMessage(): void {
  expect(sigterms).toBe(0);
  expect(composeStop).not.toHaveBeenCalled();
  expect(readNudge(mine) ?? "").not.toContain("Could not start");
  expect(readQueue()).toEqual([]);
  expect(readWaiting(mine)).toBeNull();
}

// The incident's order: the grant was admitted (the gate logged no "left the queue") and its compose ran.
it("a gate start while the grant's whole start runs waits for it: no overlap, no failure", async () => {
  await enqueue("mine", mine);
  let gate: Promise<void> | undefined;
  onWholeStart = () => {
    gate = startService("mine", mine, "api");
  };
  expect(await grantWaiters()).toEqual(["mine"]);
  await gate;
  expect(starts).toEqual(["up", "service"]);
  expectOneStartNoKillNoMessage();
});

// The other order: the grant read the queue, then the gate's start dropped the entry before the grant's admission.
it("a grant whose queue entry a gate start already took starts nothing and says nothing", async () => {
  await enqueue("mine", mine);
  // The grant's `up` waits on the host load (its first call); the gate starts meanwhile.
  vi.mocked(waitForSetupLoad).mockImplementationOnce(async () => {
    await startService("mine", mine, "api");
  });
  expect(await grantWaiters()).toEqual([]);
  expect(composeUpAsync).not.toHaveBeenCalled();
  expect(starts).toEqual(["service"]);
  expectOneStartNoKillNoMessage();
});

// The same check for a feature dequeued with no start of its own (`down`, `feature drop`).
it("a grant whose waiter left the queue meanwhile starts nothing", async () => {
  await enqueue("mine", mine);
  vi.mocked(waitForSetupLoad).mockImplementationOnce(async () => {
    await dequeue("mine");
  });
  expect(await grantWaiters()).toEqual([]);
  expect(composeUpAsync).not.toHaveBeenCalled();
  expect(readNudge(mine)).toBeNull();
});

// Review of SW-1110: a dead waiter (its waiting.json cleared over running containers) stayed queued
// and was re-granted on every pass, since the throw came before the pruned queue was written.
it("a grant of a dead waiter drops it from the queue", async () => {
  await enqueue("mine", mine);
  fs.rmSync(path.join(mine, ".werkmeister", "waiting.json"));
  expect(await grantWaiters()).toEqual([]);
  expect(composeUpAsync).not.toHaveBeenCalled();
  expect(readQueue()).toEqual([]);
});
