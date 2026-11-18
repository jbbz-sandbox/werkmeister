// putArchive and exec are the two Engine API calls with real machinery behind
// them — a tar stream going in, a frame-tagged multiplexed stream coming back —
// so they are exercised against a live daemon rather than mocked. The target is
// a throwaway container this smoke starts and removes: never one from the host's
// list, which holds other workspaces' containers, paused ones included (SW-663).
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { copyFileToContainer, docker, execCapture } from "../dist/docker.js";

// The digest k8s-port-forward/Dockerfile pins, so a host that built it needs no pull.
const IMAGE = "alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d";

const skip = (why) => {
  console.log(`docker.smoke SKIPPED (${why})`);
  process.exit(0);
};
const reason = (e) => e?.json?.message ?? e?.message ?? String(e);

try {
  await docker().ping();
} catch {
  skip("no reachable daemon");
}
try {
  await docker().getImage(IMAGE).inspect();
} catch {
  try {
    const stream = await docker().pull(IMAGE);
    await new Promise((resolve, reject) =>
      docker().modem.followProgress(stream, (e) => (e ? reject(e) : resolve())),
    );
  } catch (e) {
    skip(`no smoke image: ${reason(e)}`);
  }
}

// sleep + AutoRemove: an interrupted run's container exits and removes itself.
let container;
try {
  container = await docker().createContainer({
    Image: IMAGE,
    Cmd: ["sleep", "120"],
    Labels: { "com.werkmeister.smoke": "docker.smoke" },
    HostConfig: { AutoRemove: true },
  });
  await container.start();
} catch (e) {
  await container?.remove({ force: true }).catch(() => {});
  skip(`could not start a smoke container: ${reason(e)}`);
}

try {
  const body = "werkmeister-core smoke\n";
  const dir = await mkdtemp(path.join(tmpdir(), "werkmeister-core-smoke-"));
  const host = path.join(dir, "payload.txt");
  await writeFile(host, body);
  const dest = "/tmp/werkmeister-core-smoke.txt";
  await copyFileToContainer(container.id, host, dest);

  const read = await execCapture(container.id, ["cat", dest]);
  assert.equal(read.exitCode, 0, `cat exited ${read.exitCode}: ${read.stderr}`);
  assert.equal(read.stdout, body, "the file did not round-trip through putArchive");

  // A failing command must surface its status rather than looking like success,
  // and its diagnostics must land on stderr — that is what the demux is for.
  const missing = await execCapture(container.id, ["cat", "/tmp/werkmeister-core-smoke-absent"]);
  assert.notEqual(missing.exitCode, 0, "a missing file should not exit 0");
  assert.equal(missing.stdout, "", "nothing should reach stdout");
  assert.match(missing.stderr, /No such file|not found|cannot open/i);
} finally {
  await container.remove({ force: true }).catch(() => {});
}

console.log("docker.smoke OK");
