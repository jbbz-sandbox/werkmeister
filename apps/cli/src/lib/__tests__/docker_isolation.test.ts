/**
 * SW-158: no case may reach the host's Docker daemon. A loaded daemon answers
 * slowly or never, and a leaked call then blocks a fork past vitest's fixed 60 s
 * worker RPC timeout (sync `docker ps` via workspaceForFeature) or hangs a test
 * to its timeout (dockerode `df` via cacheSnapshots), though every case passes.
 */

import { expect, it } from "vitest";
import { volumeUsage } from "werkmeister-core/docker";

it("an unmocked dockerode call finds no daemon, and fails fast", async () => {
  const t = Date.now();
  await expect(volumeUsage()).resolves.toBeNull();
  expect(Date.now() - t).toBeLessThan(5_000);
});
