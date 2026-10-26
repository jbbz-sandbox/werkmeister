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

import { infraRoot, loadConfig, stateInfraRoot } from "./config.js";
import { generateK8sForwards, overrideFilePath } from "./k8s_forwards.js";

/** The Compose project name for shared infra (shared-infra.yml's `name:`). */
export const INFRA_PROJECT = "w9r-infra";

/**
 * The project before SW-95. Its containers hold the container names and ports
 * 80/443 the renamed stack needs, so infra start and `down` take it down first.
 */
export const LEGACY_INFRA_PROJECT = "sandbox-infra";

/** The k8s-forwards service's `container_name:` in shared-infra.yml. */
export const K8S_FORWARDS_CONTAINER = "w9r-k8s-forwards";

/**
 * The optional services' profiles (jaeger, redisinsight) the person turned on
 * with `infra.profiles` in config.yaml (SW-76). Anything but a list of names
 * reads as none.
 */
export function infraProfiles(): string[] {
  const infra = loadConfig().infra;
  const profiles = (infra as { profiles?: unknown } | undefined)?.profiles;
  if (!Array.isArray(profiles)) return [];
  return profiles.filter((p): p is string => typeof p === "string" && p !== "");
}

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
      // and pointed every infra call at the workspace's project (#198). It and
      // the profiles go after the files, because callers read the shipped file
      // at argv[3].
      "-p",
      INFRA_PROJECT,
      ...infraProfiles().flatMap((p) => ["--profile", p]),
    ],
    env: { ...process.env, SANDBOX_STATE_DIR: stateInfraRoot() },
    // Compose v5 builds through `buildx bake`, which refuses a secret file
    // outside the working directory unless granted `--allow=fs.read`. The
    // shipped file's corp_ca secret is `${SANDBOX_STATE_DIR}/../corp-ca.crt`.
    cwd: path.dirname(stateInfraRoot()),
  };
}
