// dockerode addresses DOCKER_HOST or /var/run/docker.sock and ignores
// `docker context`, so on this machine — active context `orbstack` — it would
// talk to a different daemon than the CLI unless the endpoint is resolved from
// the CLI first. That resolution and the two stats conversions are the parts
// worth pinning; the API calls themselves are integration, not unit, territory.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import Dockerode from "dockerode";

import { cpuPercent, endpointOptions, memMib, resolveEndpoint } from "./dist/docker.js";
import { useDockerEngine } from "./fixtures.mjs";

useDockerEngine();

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

// The store read is now the fast path and the CLI only the fallback, so the
// precedence chain has to hold on a machine with no daemon and no `docker` at
// all. A fabricated store under DOCKER_CONFIG pins both halves of the risk: the
// sha256-of-the-name directory scheme, and the order the sources are consulted
// in. Getting either wrong addresses the *wrong daemon*, which is the failure
// resolveEndpoint exists to prevent — worth four asserts and a temp dir.
test("resolveEndpoint resolves the context store's precedence without the CLI", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "docker-config-"));
  const localSocket = endpointOptions("unix:///var/run/docker.sock");
  const write = (name, host) => {
    const digest = createHash("sha256").update(name).digest("hex");
    const metaDir = path.join(dir, "contexts", "meta", digest);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(
      path.join(metaDir, "meta.json"),
      JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }),
    );
  };
  const configJson = path.join(dir, "config.json");

  // Pinned from a real store: this is the directory `docker` itself created for
  // the context named "orbstack". Without it the test would only agree with its
  // own createHash call and prove nothing about the scheme.
  assert.equal(
    createHash("sha256").update("orbstack").digest("hex"),
    "2d89b732b01a00a2d1675ed3cee9fd0f965daadf90603c989dd3afd4569c6896",
  );

  try {
    write("orbstack", "unix:///Users/me/.orbstack/run/docker.sock");
    write("remote", "tcp://10.0.0.4:2375");
    writeFileSync(configJson, JSON.stringify({ currentContext: "orbstack" }));

    withEnv({ DOCKER_CONFIG: dir, DOCKER_HOST: undefined, DOCKER_CONTEXT: undefined }, () => {
      assert.deepEqual(resolveEndpoint(), { socketPath: "/Users/me/.orbstack/run/docker.sock" });

      // A missing config.json means the `default` context, as it does for the
      // CLI — not "unknown", which would fall through to a needless spawn.
      rmSync(configJson);
      assert.deepEqual(resolveEndpoint(), localSocket);

      // `default` is the one context with no meta.json: it *is* the local socket.
      writeFileSync(configJson, JSON.stringify({ currentContext: "default" }));
      assert.deepEqual(resolveEndpoint(), localSocket);
    });

    // DOCKER_CONTEXT overrides config.json, and DOCKER_HOST overrides both.
    withEnv({ DOCKER_CONFIG: dir, DOCKER_HOST: undefined, DOCKER_CONTEXT: "remote" }, () => {
      assert.deepEqual(resolveEndpoint(), { host: "10.0.0.4", port: 2375, protocol: "http" });
    });
    withEnv(
      { DOCKER_CONFIG: dir, DOCKER_HOST: "tcp://127.0.0.1:9999", DOCKER_CONTEXT: "remote" },
      () => {
        assert.deepEqual(resolveEndpoint(), { host: "127.0.0.1", port: 9999, protocol: "http" });
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    fn();
  } finally {
    apply(saved);
  }
}

test("SW-259: a test without useDockerEngine() gets a dead socket, even with a tcp DOCKER_HOST", async () => {
  let requests = 0;
  const engine = http.createServer((_, res) => {
    requests++;
    res.writeHead(200, { "content-type": "application/json" }).end("[]");
  });
  await new Promise((r) => engine.listen(0, "127.0.0.1", r));
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => stderr.push(String(chunk));
  let client;
  try {
    withEnv(
      {
        WERKMEISTER_DOCKER_ENGINE: undefined,
        DOCKER_HOST: `tcp://127.0.0.1:${engine.address().port}`,
      },
      // dockerode reads DOCKER_HOST when it is built, so build it inside the env.
      () => (client = new Dockerode(resolveEndpoint())),
    );
  } finally {
    process.stderr.write = write;
  }
  try {
    await assert.rejects(client.listContainers(), { code: "ENOENT" });
  } finally {
    engine.close();
  }
  assert.equal(requests, 0);
  assert.match(stderr.join(""), /useDockerEngine\(\)/);
});

test("SW-259: outside a test context the guard is inert", () => {
  withEnv(
    {
      NODE_TEST_CONTEXT: undefined,
      WERKMEISTER_DOCKER_ENGINE: undefined,
      DOCKER_HOST: "tcp://127.0.0.1:2375",
    },
    () => assert.deepEqual(resolveEndpoint(), { host: "127.0.0.1", port: 2375, protocol: "http" }),
  );
});

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

  const v1 = {
    ...SAMPLE,
    memory_stats: { ...SAMPLE.memory_stats, stats: { total_inactive_file: 3510272 } },
  };
  assert.equal(memMib(v1).toFixed(2), "12.92");

  const noStats = { ...SAMPLE, memory_stats: { usage: 17055744, limit: 356515840 } };
  assert.equal(memMib(noStats).toFixed(2), "16.27");
});
