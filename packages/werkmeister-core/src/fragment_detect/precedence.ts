/** One value per field from a correlated group, in the spec's precedence order (§3). */
import { DATASTORES, type InfraGroup, type ServiceGroup } from "./correlate.js";
import {
  type FieldValue,
  type Finding,
  type FindingKind,
  guessed,
  type Skipped,
  stated,
} from "./types.js";

/**
 * A field two detected files disagree on: the value chosen and the ones it beat.
 *
 * @example
 * ```ts
 * import { type Conflict, planFragment, portsPerSlot, stdoutRunner } from "werkmeister-core/sdk";
 *
 * const plan = planFragment("/home/me/repos/my-app", {
 *   reposRoot: "/home/me/repos",
 *   runner: stdoutRunner,
 *   localPath: "/home/me/.werkmeister/services.local.yaml",
 *   portsPerSlot: portsPerSlot(),
 * });
 * const conflicts: Conflict[] = plan.services.flatMap((s) => s.conflicts);
 * for (const c of conflicts) console.log(c.service, c.key, c.chosen.value, c.also.length);
 * ```
 */
export interface Conflict {
  /** The service the field belongs to. */
  service: string;
  /** The registry field, e.g. `internal_port`. */
  key: string;
  /** The value that won. */
  chosen: FieldValue;
  /** The values it beat, each with its source. */
  also: FieldValue[];
}

/**
 * One service detection found in a repo, with one value per registry field
 * (`services` in {@link Plan}). Where sources disagreed, `fields` holds the winner
 * and `conflicts` the rest.
 *
 * @example
 * ```ts
 * import {
 *   planFragment,
 *   portsPerSlot,
 *   type ResolvedService,
 *   stdoutRunner,
 * } from "werkmeister-core/sdk";
 *
 * const plan = planFragment("/home/me/repos/my-app", {
 *   reposRoot: "/home/me/repos",
 *   runner: stdoutRunner,
 *   localPath: "/home/me/.werkmeister/services.local.yaml",
 *   portsPerSlot: portsPerSlot(),
 * });
 * const web: ResolvedService | undefined = plan.services.find((s) => s.name === "web");
 * console.log(web?.fields["internal_port"]?.value, web?.conflicts.length);
 * ```
 */
export interface ResolvedService {
  /** The service name, as the registry keys it. */
  name: string;
  /** Its source directory, relative to the repo root. */
  dir: string;
  /** One value per registry field, each with where it came from. */
  fields: Record<string, FieldValue>;
  /** Fields where sources disagreed: the value chosen and the ones it beat. */
  conflicts: Conflict[];
  /** Environment keys that came from k8s alone: candidates for the tunnel rewrite. */
  k8sEnvKeys: string[];
  /** Everything the detectors found for this service, before precedence. */
  findings: Finding[];
}

/**
 * One datastore detection found, such as a `postgres` its k8s manifests or
 * compose file run (`infrastructure` in {@link Plan}).
 *
 * @example
 * ```ts
 * import { planFragment, portsPerSlot, type ResolvedInfra, stdoutRunner } from "werkmeister-core/sdk";
 *
 * const plan = planFragment("/home/me/repos/my-app", {
 *   reposRoot: "/home/me/repos",
 *   runner: stdoutRunner,
 *   localPath: "/home/me/.werkmeister/services.local.yaml",
 *   portsPerSlot: portsPerSlot(),
 * });
 * const infra: ResolvedInfra[] = plan.infrastructure;
 * console.log(infra.map((i) => `${i.name}: ${String(i.fields["internal_port"]?.value ?? "?")}`));
 * ```
 */
export interface ResolvedInfra {
  /** The infrastructure name, as the registry keys it. */
  name: string;
  /** One value per registry field, each with where it came from. */
  fields: Record<string, FieldValue>;
}

/** Which detectors may supply each field, highest precedence first. `environment` is merged separately. */
const ORDER: Record<string, FindingKind[]> = {
  type: ["package"],
  archetype: ["package"],
  test: ["package"],
  internal_port: ["k8s", "compose", "dockerfile"],
  health_endpoint: ["k8s", "compose"],
  setup_service: ["package"],
  image: ["dockerfile", "package"],
  dockerfile: ["dockerfile"],
  command: ["package", "compose", "dockerfile"],
  memory_limit: ["k8s"],
  memory_reservation: ["k8s"],
  node_modules_volume: ["package"],
  secrets: ["k8s"],
  k8s_deployment: ["k8s"],
  k8s_namespace: ["k8s"],
  k8s_port: ["k8s"],
  k8s_port_name: ["k8s"],
  k8s_pod_prefix: ["k8s"],
  feature_router: ["k8s"],
  depends_on: ["compose"],
};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function sortKeys(o: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function envOf(findings: Finding[], kind: FindingKind): Record<string, string> {
  return Object.assign(
    {},
    ...findings
      .filter((f) => f.kind === kind && f.fields.environment)
      .map((f) => f.fields.environment.value as Record<string, string>),
  );
}

export function resolveService(group: ServiceGroup): ResolvedService {
  const fields: Record<string, FieldValue> = { path: stated(group.dir, "source directory") };
  const conflicts: Conflict[] = [];
  for (const [key, kinds] of Object.entries(ORDER)) {
    const candidates = kinds.flatMap((k) =>
      group.findings
        .filter((f) => f.kind === k && f.fields[key] !== undefined)
        .map((f) => f.fields[key]),
    );
    if (!candidates.length) continue;
    const chosen = candidates[0];
    fields[key] = chosen;
    if (chosen.confidence !== "stated") continue;
    const also = candidates
      .slice(1)
      .filter((c) => c.confidence === "stated" && !same(c.value, chosen.value))
      .filter((c, i, all) => all.findIndex((o) => same(o.value, c.value)) === i);
    if (also.length) conflicts.push({ service: group.name, key, chosen, also });
  }

  // SW-928: with no port, or a command that only idles, nothing serves: guess an idle type.
  const idles = /(^|&& )(exec )?sleep infinity$/.test(String(fields.command?.value ?? ""));
  const idleWhy = idles
    ? "the command is `sleep infinity`"
    : !fields.internal_port && "no port in any source";
  fields.internal_port ??= guessed(3000, "no port in any source — default 3000");
  fields.health_endpoint ??= guessed("", "no readiness probe or healthcheck — TCP-only");
  fields.type ??= idleWhy
    ? guessed("cli", `${idleWhy} — assumed idle; a person must confirm the type`)
    : guessed("api", "no package.json — assumed a service");
  fields.image ??= guessed("alpine:3", "no usable FROM and no package.json — set the dev image");
  if (!fields.feature_router && fields.type.value === "web") {
    fields.feature_router = guessed({}, "type: web — routed through Caddy");
  }

  const k8sEnv = envOf(group.findings, "k8s");
  const composeEnv = envOf(group.findings, "compose");
  const env = { ...k8sEnv, ...composeEnv };
  if (Object.keys(env).length) {
    const from = [
      Object.keys(composeEnv).length ? "compose environment" : "",
      Object.keys(k8sEnv).length ? "k8s env" : "",
    ];
    fields.environment = stated(sortKeys(env), from.filter(Boolean).join(" + "));
  }
  const k8sEnvKeys = Object.keys(k8sEnv)
    .filter((k) => !(k in composeEnv))
    .sort();

  return {
    name: group.name,
    dir: group.dir,
    fields,
    conflicts,
    k8sEnvKeys,
    findings: group.findings,
  };
}

/** *skipped* receives one entry per later k8s source that disagrees with the first on port or namespace. */
export function resolveInfra(group: InfraGroup, skipped: Skipped[] = []): ResolvedInfra {
  const ds = DATASTORES[group.datastore];
  const k8sAll = group.findings.filter((f) => f.kind === "k8s");
  const k8s = k8sAll[0];
  for (const other of k8sAll.slice(1)) {
    for (const key of ["internal_port", "k8s_namespace"]) {
      const kept = k8s.fields[key];
      const v = other.fields[key];
      if (kept && v && !same(kept.value, v.value)) {
        skipped.push({
          item: other.file,
          reason: `infrastructure ${group.name}: ${key} ${v.value} disagrees with ${kept.value} (${kept.source}), kept ${kept.value}`,
        });
      }
    }
  }
  const port =
    k8s?.fields.internal_port ??
    group.findings.find((f) => f.fields.internal_port)?.fields.internal_port;
  const noManifest = "no k8s manifest for this datastore";
  return {
    name: group.name,
    fields: {
      internal_port: port ?? stated(ds.port, `${group.datastore} default port`),
      k8s_namespace: k8s?.fields.k8s_namespace ?? guessed("default", noManifest),
      k8s_pod_prefix: k8s?.fields.k8s_pod_prefix ?? guessed(group.name, noManifest),
      health_endpoint: stated(
        ds.health,
        ds.health ? `${group.datastore} wire probe` : "no wire probe for this datastore — TCP-only",
      ),
    },
  };
}
