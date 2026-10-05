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

export function composeInvocation(): { argv: string[]; env: NodeJS.ProcessEnv } {
  const override = overrideFilePath();
  // A fresh machine's first `status`/`down` arrives before any `connect` has
  // generated the override, and `-f <missing>` is a hard error. Pure text
  // from the registry, so generating it here is cheap and cannot loop.
  if (!fs.existsSync(override)) {
    generateK8sForwards(true);
  }
  return {
    argv: [
      "docker", "compose",
      "-f", path.join(infraRoot(), "compose", "shared-infra.yml"),
      "-f", override,
    ],
    env: { ...process.env, SANDBOX_STATE_DIR: stateInfraRoot() },
  };
}
