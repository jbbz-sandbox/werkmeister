/** One value per field from a correlated group, in the spec's precedence order (§3). */
import { DATASTORES, type InfraGroup, type ServiceGroup } from "./correlate.js";
import { guessed, stated, type FieldValue, type Finding, type FindingKind } from "./types.js";

export interface Conflict {
  service: string;
  key: string;
  chosen: FieldValue;
  also: FieldValue[];
}

export interface ResolvedService {
  name: string;
  dir: string;
  fields: Record<string, FieldValue>;
  conflicts: Conflict[];
  /** Environment keys that came from k8s alone: candidates for the tunnel rewrite. */
  k8sEnvKeys: string[];
  findings: Finding[];
}

export interface ResolvedInfra {
  name: string;
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
    ...findings.filter((f) => f.kind === kind && f.fields.environment).map((f) => f.fields.environment.value as Record<string, string>),
  );
}

export function resolveService(group: ServiceGroup): ResolvedService {
  const fields: Record<string, FieldValue> = { path: stated(group.dir, "source directory") };
  const conflicts: Conflict[] = [];
  for (const [key, kinds] of Object.entries(ORDER)) {
    const candidates = kinds.flatMap((k) =>
      group.findings.filter((f) => f.kind === k && f.fields[key] !== undefined).map((f) => f.fields[key]),
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

  fields.internal_port ??= guessed(3000, "no port in any source — default 3000");
  fields.health_endpoint ??= guessed("", "no readiness probe or healthcheck — TCP-only");
  fields.type ??= guessed("api", "no package.json — assumed a service");
  fields.image ??= guessed("alpine:3", "no usable FROM and no package.json — set the dev image");
  if (!fields.feature_router && fields.type.value === "web") {
    fields.feature_router = guessed({}, "type: web — routed through Caddy");
  }

  const k8sEnv = envOf(group.findings, "k8s");
  const composeEnv = envOf(group.findings, "compose");
  const env = { ...k8sEnv, ...composeEnv };
  if (Object.keys(env).length) {
    const from = [Object.keys(composeEnv).length ? "compose environment" : "", Object.keys(k8sEnv).length ? "k8s env" : ""];
    fields.environment = stated(sortKeys(env), from.filter(Boolean).join(" + "));
  }
  const k8sEnvKeys = Object.keys(k8sEnv).filter((k) => !(k in composeEnv)).sort();

  return { name: group.name, dir: group.dir, fields, conflicts, k8sEnvKeys, findings: group.findings };
}

export function resolveInfra(group: InfraGroup): ResolvedInfra {
  const ds = DATASTORES[group.datastore];
  const k8s = group.findings.find((f) => f.kind === "k8s");
  const port = k8s?.fields.internal_port ?? group.findings.find((f) => f.fields.internal_port)?.fields.internal_port;
  const noManifest = "no k8s manifest for this datastore";
  return {
    name: group.name,
    fields: {
      internal_port: port ?? stated(ds.port, `${group.datastore} default port`),
      k8s_namespace: k8s?.fields.k8s_namespace ?? guessed("default", noManifest),
      k8s_pod_prefix: k8s?.fields.k8s_pod_prefix ?? guessed(group.name, noManifest),
      health_endpoint: stated(ds.health, ds.health ? `${group.datastore} wire probe` : "no wire probe for this datastore — TCP-only"),
    },
  };
}
