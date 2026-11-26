/**
 * SW-1170: a fresh workspace's first `feature up` sat silent while its install ran (10-25 min), and a
 * daemon timeout then read as a failure. The start now names the setup container it waits on, and a
 * daemon timeout while that runs says so. Docker, compose and the slot are faked; the queue is real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("werkmeister-core/scheduler_client", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/scheduler_client")>()),
  schedulerOp: async (_op: string, _args: unknown, local: () => Promise<unknown>) => local(),
}));
vi.mock("werkmeister-core/proc", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/proc")>()),
  run: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
}));
vi.mock("werkmeister-core/compose", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/compose")>()),
  composeUpServiceAsync: vi.fn(async () => true),
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
  requireLeasedSlot: vi.fn(async () => 2),
  getPortRange: () => [11020, 11039],
}));
vi.mock("werkmeister-core/reporter", async (orig) => ({
  ...(await orig<typeof import("werkmeister-core/reporter")>()),
  info: vi.fn(),
}));

import { composeUpServiceAsync, getContainerStatus } from "werkmeister-core/compose";
import { DaemonTimeout } from "werkmeister-core/daemon_client";
import { startService } from "werkmeister-core/lifecycle";
import { info } from "werkmeister-core/reporter";
import { writeLeases } from "werkmeister-core/scheduler_state";
import { requireLeasedSlot } from "werkmeister-core/slots";

const install = {
  name: "mine-werkmeister-install",
  status: "running",
  health: "",
  ports: "",
  service: "werkmeister-install",
  role: "setup",
  exitCode: 0,
};
let tmp: string;
let mine: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "install-notice-"));
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
  vi.mocked(info).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(getContainerStatus).mockReset().mockResolvedValue([]);
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const infoLines = () => vi.mocked(info).mock.calls.map((c) => String(c[0]));

it("names the setup container a start still waits on after 30 s", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.mocked(getContainerStatus).mockResolvedValue([install]);
  // Compose's wait on the install: a minute of fake time.
  vi.mocked(composeUpServiceAsync).mockImplementationOnce(
    () => new Promise((resolve) => setTimeout(() => resolve(true), 60_000)),
  );
  let done = false;
  const start = startService("mine", mine, "api").finally(() => {
    done = true;
  });
  while (!done) await vi.advanceTimersByTimeAsync(15_000);
  await start;
  expect(infoLines()).toContainEqual(
    expect.stringMatching(/^Installing dependencies in mine-werkmeister-install .*docker logs -f/),
  );
});

it("says nothing when the start ends first, or when no setup runs", async () => {
  vi.mocked(getContainerStatus).mockResolvedValue([install]);
  await startService("mine", mine, "api");
  expect(infoLines().some((l) => l.startsWith("Installing dependencies"))).toBe(false);
});

it("adds the running install to a daemon timeout, and leaves other errors as they are", async () => {
  vi.mocked(requireLeasedSlot).mockRejectedValueOnce(new DaemonTimeout("TimeoutError"));
  vi.mocked(getContainerStatus).mockResolvedValue([install]);
  await expect(startService("mine", mine, "api")).rejects.toThrow(
    /did not answer in time.*mine-werkmeister-install is still installing dependencies/s,
  );
  vi.mocked(requireLeasedSlot).mockRejectedValueOnce(new DaemonTimeout("TimeoutError"));
  vi.mocked(getContainerStatus).mockResolvedValue([]);
  await expect(startService("mine", mine, "api")).rejects.toThrow(/it may still be running it\.$/);
});
