/**
 * SW-615: `feature up` (and `--service`) exits non-zero when compose's `--wait`
 * times out and leaves the service Created.
 *
 * A subprocess of the built CLI, like `up_flags.test.ts`: the exit status is
 * main()'s. The fixture's fake docker hangs on `compose up` until killed, and
 * WERKMEISTER_UP_TIMEOUT_S shrinks the 20-minute up timeout to 2 s, so this
 * is the real timeout path (child killed → ETIMEDOUT), not a plain non-zero exit.
 *
 * The two cases wait out their timeout side by side, each in its own fixture.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { FIXTURE_FEATURE, seedFixture } from "werkmeister-core/fixture_workspace";

const MAIN = path.join(path.resolve(fileURLToPath(import.meta.url), "../../../.."), "dist/main.js");

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** Runs `werkmeister <argv>` in a fresh initialised fixture whose `compose up` hangs. */
async function upInFixture(...argv: string[]): Promise<{ status: number | null; out: string }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "up-exit-")));
  roots.push(root);
  const fx = seedFixture(root);
  // `compose … up -d` hangs until killed (compose traps SIGTERM and exits 130, SW-86); every
  // other call answers at once in sh, as the stock fake does, so the shrunk timeouts never hit it.
  const docker = path.join(root, "docker-hangs-on-up");
  fs.writeFileSync(
    docker,
    `#!/bin/sh
case " $* " in
  *" compose "*" up -d "*)
    trap 'kill $!; exit 130' TERM
    echo " Container ${FIXTURE_FEATURE}-lib Starting"
    sleep 60 >/dev/null 2>&1 & wait; exit 0;;
  " inspect "*) echo false;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = { ...process.env, ...fx.env, WERKMEISTER_DOCKER_BIN: docker };
  // A shell-exported root renders templates from that checkout, not this build (SW-671; bdd/steps.ts does the same).
  delete env.WERKMEISTER_ROOT;
  const init = spawn(process.execPath, [MAIN, "workspace", "init"], {
    cwd: fx.workspace,
    env,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 60_000,
  });
  let initErr = "";
  init.stderr.on("data", (d) => (initErr += d));
  expect(await new Promise((resolve) => init.on("close", resolve)), initErr).toBe(0);
  // `up` alone times out in 2 s; WERKMEISTER_TIMEOUT_SCALE would shrink every docker call with it (SW-755).
  env.WERKMEISTER_UP_TIMEOUT_S = "2";
  // Not spawnSync: it would block this worker, and the other case with it, for the whole wait.
  const child = spawn(process.execPath, [MAIN, ...argv], {
    cwd: fx.workspace,
    env,
    timeout: 60_000,
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, out };
}

it.concurrent("feature up --service exits non-zero on a compose --wait timeout", async () => {
  const { status, out } = await upInFixture("feature", "up", FIXTURE_FEATURE, "--service", "lib");
  expect(out).toContain("docker compose timed out");
  expect(out).not.toContain(`Started ${FIXTURE_FEATURE}-lib`);
  expect(status, out).not.toBe(0);
});

it.concurrent("feature up exits non-zero on a compose timeout", async () => {
  const { status, out } = await upInFixture("feature", "up", FIXTURE_FEATURE);
  expect(out).toContain("docker compose timed out");
  expect(out).not.toContain("is ready");
  expect(status, out).not.toBe(0);
});
