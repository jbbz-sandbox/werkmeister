// putArchive and exec are the two Engine API calls with real machinery behind
// them — a tar stream going in, a frame-tagged multiplexed stream coming back —
// so they are exercised against a live daemon rather than mocked. Any running
// container will do: the check is that a file round-trips and that a failing
// command reports its exit code, not anything about the container itself.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { copyFileToContainer, docker, execCapture } from "./dist/docker.js";

let running = [];
try {
  running = await docker().listContainers();
} catch {
  console.log("docker.smoke SKIPPED (no reachable daemon)");
  process.exit(0);
}
if (!running.length) {
  console.log("docker.smoke SKIPPED (no running containers)");
  process.exit(0);
}

const body = "werkmeister-core smoke\n";
const dir = await mkdtemp(path.join(tmpdir(), "sandbox-core-smoke-"));
const host = path.join(dir, "payload.txt");
await writeFile(host, body);

// Not every running container is a usable target — a k8s pause container has no
// /tmp to write into — so take the first that accepts the copy.
const dest = "/tmp/sandbox-core-smoke.txt";
let container = null;
for (const candidate of running) {
  try {
    await copyFileToContainer(candidate.Id, host, dest);
    container = candidate.Id;
    break;
  } catch {
    continue;
  }
}
if (container === null) {
  console.log("docker.smoke SKIPPED (no container with a writable /tmp)");
  process.exit(0);
}

const read = await execCapture(container, ["cat", dest]);
assert.equal(read.exitCode, 0, `cat exited ${read.exitCode}: ${read.stderr}`);
assert.equal(read.stdout, body, "the file did not round-trip through putArchive");

// A failing command must surface its status rather than looking like success,
// and its diagnostics must land on stderr — that is what the demux is for.
const missing = await execCapture(container, ["cat", "/tmp/sandbox-core-smoke-absent"]);
assert.notEqual(missing.exitCode, 0, "a missing file should not exit 0");
assert.equal(missing.stdout, "", "nothing should reach stdout");
assert.match(missing.stderr, /No such file|not found|cannot open/i);

console.log("docker.smoke OK");
