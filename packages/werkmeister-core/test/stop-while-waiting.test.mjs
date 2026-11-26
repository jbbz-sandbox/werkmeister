// SW-741: the host-load wait (with-temp-home's `internal wait-load`) stops and pauses none of the
// workspace's containers: it runs inside one of them. The capacity waits' release is pinned in
// apps/cli/src/lib/__tests__/lifecycle_admission.test.ts (SW-675, SW-741).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";

import { waitForHostLoadNow } from "../dist/scheduler_state.js";
import { pinWerkmeisterRoot, withFixtureWorkspace } from "./fixtures.mjs";

pinWerkmeisterRoot();
// with-temp-home --no-wait exports it, and it would skip the wait under test.
delete process.env.WERKMEISTER_NO_WAIT;

test("the host-load wait makes no docker call while it waits, then lets the command run (SW-741)", async () => {
  await withFixtureWorkspace(async (fx) => {
    const reads = [40, 3];
    let vmReads = 0;
    const deps = {
      hostLoad: () => assert.fail("macOS reads the VM's load"),
      vmLoad: async () => {
        vmReads++;
        return { load: [reads.shift() ?? 3, 0, 0], cores: 12 };
      },
      hostMemory: () => ({ free: 8, total: 16 }),
      sleep: async () => {},
    };
    const wait = await waitForHostLoadNow(deps, "darwin");
    // The wait ran: one poll after the over-limit first read.
    assert.deepEqual(wait, { spent: false, note: "waited 15 s for host load" });
    assert.equal(vmReads, 2);
    const log = fs.existsSync(fx.dockerLog) ? fs.readFileSync(fx.dockerLog, "utf8") : "";
    assert.equal(log, "", `no stop, pause or any other docker call:\n${log}`);
  });
});
