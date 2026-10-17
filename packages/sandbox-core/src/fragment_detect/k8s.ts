/**
 * Kubernetes manifests → per-workload findings. Raw files, `helm template`
 * output and `kubectl kustomize` output all come through findingsFromManifests.
 */
import * as path from "node:path";

import { COMPOSE_FILE } from "./compose.js";
import { readText, yamlDocs } from "./files.js";
import { type DetectContext, type Finding, stated } from "./types.js";

export interface ManifestSource {
  /** Repo-relative file, or a label such as `x.values.yaml (helm template)`. */
  file: string;
  /** Directory used for location matching; null for rendered output. */
  dir: string | null;
  docs: unknown[];
}

const WORKLOADS = new Set(["Deployment", "StatefulSet"]);

/** `512Mi` → `512M`, `1Gi` → `1G`; anything compose can't read is dropped. */
function memory(v: unknown): string | undefined {
  const m = /^(\d+)([KMG])?i?$/.exec(String(v ?? ""));
  return m ? `${m[1]}${m[2] ?? ""}` : undefined;
}

function ingressBackends(ing: any): string[] {
  const rules: any[] = ing?.spec?.rules ?? [];
  return [
    ing?.spec?.defaultBackend?.service?.name,
    ...rules.flatMap((r) => (r?.http?.paths ?? []).map((p: any) => p?.backend?.service?.name)),
  ].filter((n): n is string => typeof n === "string");
}

export function findingsFromManifests(sources: ManifestSource[]): Finding[] {
  const items = sources.flatMap((s) =>
    s.docs
      .flatMap((d: any) => (d?.kind === "List" && Array.isArray(d.items) ? d.items : [d]))
      .filter((d: any) => d && typeof d === "object" && typeof d.kind === "string")
      .map((doc: any) => ({ doc, source: s })),
  );
  const services = items.filter((i) => i.doc.kind === "Service").map((i) => i.doc);
  const routed = new Set(
    items.filter((i) => i.doc.kind === "Ingress").flatMap((i) => ingressBackends(i.doc)),
  );

  const out: Finding[] = [];
  for (const { doc: w, source } of items.filter((i) => WORKLOADS.has(i.doc.kind))) {
    const name = w.metadata?.name;
    const c = w.spec?.template?.spec?.containers?.[0];
    if (typeof name !== "string" || !c) continue;
    const src = (field: string) => `${source.file} → ${field}`;
    const fields: Finding["fields"] = {
      k8s_namespace: w.metadata?.namespace
        ? stated(w.metadata.namespace, src("metadata.namespace"))
        : stated("default", `${source.file} → no metadata.namespace (Kubernetes default)`),
      k8s_pod_prefix: stated(name, src(`${w.kind} ${name}`)),
    };
    if (w.kind === "Deployment") fields.k8s_deployment = stated(name, src(`Deployment ${name}`));

    const port = c.ports?.[0]?.containerPort;
    if (Number.isInteger(port)) fields.internal_port = stated(port, src("containerPort"));
    const probe = c.readinessProbe?.httpGet?.path
      ? (["readinessProbe", c.readinessProbe.httpGet.path] as const)
      : c.livenessProbe?.httpGet?.path
        ? (["livenessProbe", c.livenessProbe.httpGet.path] as const)
        : null;
    if (probe) fields.health_endpoint = stated(String(probe[1]), src(`${probe[0]}.httpGet.path`));

    const limit = memory(c.resources?.limits?.memory);
    const request = memory(c.resources?.requests?.memory);
    if (limit) fields.memory_limit = stated(limit, src("resources.limits.memory"));
    if (request) fields.memory_reservation = stated(request, src("resources.requests.memory"));

    const env: Record<string, string> = {};
    const secrets: string[] = [];
    for (const e of Array.isArray(c.env) ? c.env : []) {
      if (typeof e?.name !== "string") continue;
      if (e.valueFrom?.secretKeyRef) secrets.push(e.name);
      else if (e.value !== undefined && e.value !== null) env[e.name] = String(e.value);
    }
    if (Object.keys(env).length) fields.environment = stated(env, src("env"));
    if (secrets.length)
      fields.secrets = stated([...secrets].sort(), src("env[].valueFrom.secretKeyRef"));

    const labels: Record<string, string> = w.spec?.template?.metadata?.labels ?? {};
    const svc = services.find((s: any) => {
      const sel: Record<string, string> = s.spec?.selector ?? {};
      return Object.keys(sel).length > 0 && Object.entries(sel).every(([k, v]) => labels[k] === v);
    });
    const svcName: string | undefined = svc?.metadata?.name;
    const sp = svc?.spec?.ports?.[0];
    if (Number.isInteger(sp?.port))
      fields.k8s_port = stated(sp.port, src(`Service ${svcName} port`));
    if (typeof sp?.name === "string")
      fields.k8s_port_name = stated(sp.name, src(`Service ${svcName} port name`));
    if (svcName && routed.has(svcName))
      fields.feature_router = stated({}, src(`Ingress → Service ${svcName}`));

    out.push({
      kind: "k8s",
      name,
      dir: source.dir,
      file: source.file,
      ...(typeof c.image === "string" ? { image: c.image } : {}),
      fields,
    });
  }
  return out;
}

/** Every directory holding a Chart.yaml. */
export function chartDirs(files: string[]): string[] {
  return files
    .filter((f) => path.posix.basename(f) === "Chart.yaml")
    .map((f) => path.posix.dirname(f));
}

export const KUSTOMIZATION = /(^|\/)kustomization\.ya?ml$/;

const NOT_RAW = [
  /(^|\/)values[^/]*\.ya?ml$/,
  /\.values\.ya?ml$/,
  /^pnpm-workspace\.yaml$/,
  COMPOSE_FILE,
];
/** Cheap pre-filter, so YAML that isn't k8s is never parsed or reported. */
const K8S_KIND = /^\s*kind:\s*(Deployment|StatefulSet|Service|Ingress|List)\b/m;

/** Raw manifests in the repo. Chart sources are left to detectHelm, kustomize dirs to detectKustomize. */
export function detectK8s(ctx: DetectContext): Finding[] {
  const owned = [
    ...chartDirs(ctx.files),
    ...ctx.files.filter((f) => KUSTOMIZATION.test(f)).map((f) => path.posix.dirname(f)),
  ];
  const ownedElsewhere = (f: string) => owned.some((c) => c === "." || f.startsWith(`${c}/`));
  const sources: ManifestSource[] = [];
  for (const file of ctx.files) {
    if (!/\.ya?ml$/.test(file) || ownedElsewhere(file) || NOT_RAW.some((r) => r.test(file)))
      continue;
    const text = readText(ctx, file);
    if (!K8S_KIND.test(text)) continue;
    try {
      sources.push({ file, dir: path.posix.dirname(file), docs: yamlDocs(text) });
    } catch (e) {
      ctx.skipped.push({
        item: file,
        reason: `unparsable YAML: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return findingsFromManifests(sources);
}
