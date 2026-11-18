/**
 * The one way to spell `docker compose` for the shared infra.
 *
 * Two files: the shipped `infra/compose/shared-infra.yml` (read-only, part of
 * the npm package) and the generated `k8s-forwards.override.yml` under
 * `stateInfraRoot()`, plus `baseline.override.yml` once `connect` has written
 * it (baseline.ts). The shipped file interpolates `${WERKMEISTER_STATE_DIR}` for
 * every generated mount, so the env this returns must reach the spawn.
 *
 * A leaf module on purpose: `infra.ts`, `caddy.ts`, `k8s.ts` and `status.ts`
 * all call this, and `infra.ts` already imports `k8s.ts`, so putting it in
 * `infra.ts` would make a cycle.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type Dockerode from "dockerode";

import { baselineOverridePath } from "./baseline.js";
import { infraRoot, isFixture, loadConfig, stateInfraRoot } from "./config.js";
import { docker } from "./docker.js";
import { insideContainer } from "./global_config.js";
import { generateK8sForwards, overrideFilePath } from "./k8s_forwards.js";
import { warn } from "./reporter.js";

/** The Compose project name for shared infra (shared-infra.yml's `name:`). */
export const INFRA_PROJECT = "w9r-infra";

/**
 * The project before SW-95. Its containers hold the container names and ports
 * 80/443 the renamed stack needs, so infra start and `down` take it down first.
 */
export const LEGACY_INFRA_PROJECT = "sandbox-infra"; // name-check: ignore

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
  // Only `connect` writes this one: generating it here would let a bad
  // infra.baseline entry break `status` and `down` too (SW-102).
  const baseline = baselineOverridePath();
  return {
    argv: [
      "docker",
      "compose",
      "-f",
      path.join(infraRoot(), "compose", "shared-infra.yml"),
      "-f",
      override,
      ...(fs.existsSync(baseline) ? ["-f", baseline] : []),
      // `-p`, not just the file's `name:`: a workspace container's `.env`
      // exports COMPOSE_PROJECT_NAME=sandbox-<feature>, which outranks `name:` // name-check: ignore
      // and pointed every infra call at the workspace's project (#198). It and
      // the profiles go after the files, because callers read the shipped file
      // at argv[3].
      "-p",
      INFRA_PROJECT,
      ...infraProfiles().flatMap((p) => ["--profile", p]),
    ],
    env: { ...process.env, WERKMEISTER_STATE_DIR: stateInfraRoot() },
    // Compose v5 builds through `buildx bake`, which refuses a secret file
    // outside the working directory unless granted `--allow=fs.read`. The
    // shipped file's corp_ca secret is `${WERKMEISTER_STATE_DIR}/../corp-ca.crt`.
    cwd: path.dirname(stateInfraRoot()),
  };
}

/** An infra container left over from another checkout (SW-610). */
export interface StaleInfraContainer {
  name: string;
  service: string;
  reason: string;
}

/**
 * Why *c* no longer matches the shipped compose file at *composeFile*, or null.
 * Compose stamps the files it ran with; after a checkout moves, a container made
 * from the old path keeps its relative bind mounts (the Caddy picker UI) pointed
 * there, and `feature up` / `proxy-reload` never recreate it. The label, not the
 * bind sources: a missing source comes back as an empty dir on restart, and from
 * a container the host's paths don't exist at all.
 */
export function staleInfraReason(
  c: Pick<Dockerode.ContainerInfo, "Labels">,
  composeFile: string,
): string | null {
  const from = c.Labels?.["com.docker.compose.project.config_files"]?.split(",")[0];
  return from && path.resolve(from) !== path.resolve(composeFile) ? `created from ${from}` : null;
}

/**
 * The shared-infra containers {@link staleInfraReason} flags. Never throws: empty when
 * docker is unreachable or there is no machine config to say where the compose file is.
 */
export async function staleInfraContainers(): Promise<StaleInfraContainer[]> {
  // A workspace container's checkout is /app, so every host-made label differs, and a
  // recreate from there would mount /app paths the host lacks (SW-554). Fixtures never start infra.
  if (insideContainer() && !isFixture()) return [];
  let list: Dockerode.ContainerInfo[];
  let composeFile: string;
  try {
    list = await docker().listContainers({
      all: true,
      filters: { label: [`com.docker.compose.project=${INFRA_PROJECT}`] },
    });
    composeFile = composeInvocation().argv[3];
  } catch {
    return [];
  }
  return list.flatMap((c) => {
    const reason = staleInfraReason(c, composeFile);
    const name = c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12);
    return reason
      ? [{ name, service: c.Labels?.["com.docker.compose.service"] ?? "", reason }]
      : [];
  });
}

/** One warning per stale infra container, naming the command that recreates it. */
export async function warnStaleInfra(): Promise<void> {
  for (const s of await staleInfraContainers()) {
    warn(
      `${s.name} was ${s.reason}, not this checkout: run \`werkmeister infra up\` to recreate it`,
    );
  }
}

/**
 * Split *stale* into the services `up` can recreate (those in *started*, this run's list)
 * and leftovers whose service this checkout's file no longer has: naming one to
 * `compose up` fails every run, or turns on a profile that is off.
 */
export function recreatePlan(
  stale: StaleInfraContainer[],
  started: string[],
): { recreate: string[]; leftover: StaleInfraContainer[] } {
  const known = stale.filter((s) => started.includes(s.service));
  return {
    recreate: [...new Set(known.map((s) => s.service))],
    leftover: stale.filter((s) => !started.includes(s.service)),
  };
}
