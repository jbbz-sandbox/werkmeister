/**
 * The one way to spell `docker compose` for the shared infra.
 *
 * Two files: the shipped `infra/compose/shared-infra.yml` (read-only, part of
 * the npm package) and the generated `k8s-forwards.override.yml` under
 * `stateInfraRoot()`. The shipped file interpolates `${SANDBOX_STATE_DIR}` for
 * every generated mount, so the env this returns must reach the spawn.
 *
 * A leaf module on purpose: `infra.ts`, `caddy.ts`, `k8s.ts` and `status.ts`
 * all call this, and `infra.ts` already imports `k8s.ts`, so putting it in
 * `infra.ts` would make a cycle.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { infraRoot, stateInfraRoot } from "./config.js";
import { generateK8sForwards, overrideFilePath } from "./k8s_forwards.js";

/** The Compose project name for shared infra (shared-infra.yml's `name:`). */
export const INFRA_PROJECT = "sandbox-infra";

export function composeInvocation(): { argv: string[]; env: NodeJS.ProcessEnv; cwd: string } {
  const override = overrideFilePath();
  // A fresh machine's first `status`/`down` arrives before any `connect` has
  // generated the override, and `-f <missing>` is a hard error. Pure text
  // from the registry, so generating it here is cheap and cannot loop.
  if (!fs.existsSync(override)) {
    generateK8sForwards(true);
  }
  return {
    argv: [
      "docker",
      "compose",
      "-f",
      path.join(infraRoot(), "compose", "shared-infra.yml"),
      "-f",
      override,
      // `-p`, not just the file's `name:`: a workspace container's `.env`
      // exports COMPOSE_PROJECT_NAME=sandbox-<feature>, which outranks `name:`
      // and pointed every infra call at the workspace's project (#198). Last,
      // because callers read the shipped file at argv[3].
      "-p",
      INFRA_PROJECT,
    ],
    env: { ...process.env, SANDBOX_STATE_DIR: stateInfraRoot() },
    // Compose v5 builds through `buildx bake`, which refuses a secret file
    // outside the working directory unless granted `--allow=fs.read`. The
    // shipped file's corp_ca secret is `${SANDBOX_STATE_DIR}/../corp-ca.crt`.
    cwd: path.dirname(stateInfraRoot()),
  };
}
