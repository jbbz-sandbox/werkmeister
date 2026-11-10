/**
 * SW-615: `feature up` (and `--service`) exits non-zero when compose's `--wait`
 * times out and leaves the service Created.
 *
 * A subprocess of the built CLI, like `up_flags.test.ts`: the exit status is
 * main()'s. The fixture's fake docker hangs on `compose up` until killed, and
 * WERKMEISTER_TIMEOUT_SCALE shrinks the 20-minute up timeout to 20 s, so this
 * is the real timeout path (child killed → ETIMEDOUT), not a plain non-zero exit.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FIXTURE_FEATURE, seedFixture } from "werkmeister-core/fixture_workspace";

const MAIN = path.join(path.resolve(fileURLToPath(import.meta.url), "../../../.."), "dist/main.js");

let root: string;
let fx: ReturnType<typeof seedFixture>;
let env: NodeJS.ProcessEnv;

beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "up-exit-")));
  fx = seedFixture(root);
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
  env = { ...process.env, ...fx.env, WERKMEISTER_DOCKER_BIN: docker };
  const init = cli("workspace", "init");
  expect(init.status, init.stderr).toBe(0);
  // 1200 s → 20 s for `up`; a 30 s docker call gets 500 ms, since 125 ms (1/240) timed out under host load.
  env.WERKMEISTER_TIMEOUT_SCALE = String(1 / 60);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function cli(...argv: string[]) {
  return spawnSync(process.execPath, [MAIN, ...argv], {
    cwd: fx.workspace,
    env,
    encoding: "utf-8",
    timeout: 60_000,
  });
}

it("feature up --service exits non-zero on a compose --wait timeout", () => {
  const res = cli("feature", "up", FIXTURE_FEATURE, "--service", "lib");
  const out = res.stdout + res.stderr;
  expect(out).toContain("docker compose timed out");
  expect(out).not.toContain(`Started ${FIXTURE_FEATURE}-lib`);
  expect(res.status, out).not.toBe(0);
});

it("feature up exits non-zero on a compose timeout", () => {
  const res = cli("feature", "up", FIXTURE_FEATURE);
  const out = res.stdout + res.stderr;
  expect(out).toContain("docker compose timed out");
  expect(out).not.toContain("is ready");
  expect(res.status, out).not.toBe(0);
});
