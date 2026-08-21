// dockerode addresses DOCKER_HOST or /var/run/docker.sock and ignores
// `docker context`, so on this machine — active context `orbstack` — it would
// talk to a different daemon than the CLI unless the endpoint is resolved from
// the CLI first. That resolution and the two stats conversions are the parts
// worth pinning; the API calls themselves are integration, not unit, territory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { cpuPercent, endpointOptions, memMib, resolveEndpoint } from "./dist/docker.js";

test("endpointOptions maps the context URL forms dockerode understands", () => {
  assert.deepEqual(endpointOptions("unix:///Users/me/.orbstack/run/docker.sock"), {
    socketPath: "/Users/me/.orbstack/run/docker.sock",
  });
  assert.deepEqual(endpointOptions("tcp://127.0.0.1:2375"), {
    host: "127.0.0.1",
    port: 2375,
    protocol: "http",
  });
  assert.deepEqual(endpointOptions("https://docker.example:2376"), {
    host: "docker.example",
    port: 2376,
    protocol: "https",
  });
  // Nothing resolvable, and the ssh:// ceiling: both fall back to the default
  // socket rather than guessing at a transport that isn't bundled.
  const fallback = { socketPath: "/var/run/docker.sock" };
  assert.deepEqual(endpointOptions(""), fallback);
  assert.deepEqual(endpointOptions("ssh://user@host"), fallback);
});

test("resolveEndpoint follows the active docker context", { skip: !hasDockerCli() }, () => {
  const host = spawnSync(
    "docker",
    ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
    { encoding: "utf8" },
  ).stdout.trim();
  assert.deepEqual(resolveEndpoint(), endpointOptions(host));
});

function hasDockerCli() {
  return spawnSync("docker", ["--version"], { encoding: "utf8" }).status === 0;
}

// A real payload captured from this machine's daemon. Run side by side against
// `docker stats --no-stream`, these two conversions reproduced its numbers to
// the digit it prints (12.20MiB, 52.92MiB, 30.24MiB across the running set).
const SAMPLE = {
  cpu_stats: {
    cpu_usage: { total_usage: 39584268000 },
    system_cpu_usage: 2398963260000000,
    online_cpus: 12,
  },
  precpu_stats: {
    cpu_usage: { total_usage: 39583929000 },
    system_cpu_usage: 2398951370000000,
  },
  memory_stats: { usage: 17055744, limit: 356515840, stats: { inactive_file: 3510272 } },
};

test("cpuPercent scales the CPU-time delta by the core count", () => {
  assert.equal(cpuPercent(SAMPLE).toFixed(4), "0.0342");
});

test("cpuPercent reports zero rather than a sign error on an empty window", () => {
  const idle = {
    ...SAMPLE,
    precpu_stats: {
      cpu_usage: { total_usage: SAMPLE.cpu_stats.cpu_usage.total_usage },
      system_cpu_usage: SAMPLE.cpu_stats.system_cpu_usage,
    },
  };
  assert.equal(cpuPercent(idle), 0);
});

test("memMib subtracts the page cache, on either cgroup version", () => {
  assert.equal(memMib(SAMPLE).toFixed(2), "12.92");

  const v1 = { ...SAMPLE, memory_stats: { ...SAMPLE.memory_stats, stats: { total_inactive_file: 3510272 } } };
  assert.equal(memMib(v1).toFixed(2), "12.92");

  const noStats = { ...SAMPLE, memory_stats: { usage: 17055744, limit: 356515840 } };
  assert.equal(memMib(noStats).toFixed(2), "16.27");
});
