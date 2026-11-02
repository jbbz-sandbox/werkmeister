/** The whole deterministic pass: detectors → correlation → precedence → allocation. */
import * as fs from "node:fs";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import type { Runner } from "../machine_setup.js";
import { FRAGMENT_REL } from "../registry_sync.js";
import { allocateForwards, allocateOffsets, rewriteEnv, takenPorts } from "./allocate.js";
import { detectCompose } from "./compose.js";
import { correlate } from "./correlate.js";
import { detectDockerfiles } from "./dockerfile.js";
import { listRepoFiles, readText } from "./files.js";
import { detectHelm } from "./helm.js";
import { detectK8s } from "./k8s.js";
import { detectKustomize } from "./kustomize.js";
import { detectPackages } from "./package.js";
import {
  type ResolvedInfra,
  type ResolvedService,
  resolveInfra,
  resolveService,
} from "./precedence.js";
import {
  type DetectContext,
  type FieldValue,
  type Finding,
  guessed,
  type Skipped,
  stated,
  type Workspace,
} from "./types.js";
import { detectWorkspace } from "./workspace.js";

export interface SetupPlan {
  name: string;
  fields: Record<string, FieldValue>;
}

export interface Plan {
  repo: string;
  root: string;
  fragmentPath: string;
  /** The existing fragment's text, or null when the repo has none. */
  existing: string | null;
  services: ResolvedService[];
  infrastructure: ResolvedInfra[];
  setup: SetupPlan | null;
  /** Keys listed in .env.example-style files, per service name. */
  envExample: Record<string, string[]>;
  unmatched: Finding[];
  skipped: Skipped[];
}

export interface PlanOptions {
  reposRoot: string;
  runner: Runner;
  localPath: string;
  portsPerSlot: number;
}

const ENV_EXAMPLES = [".env.example", ".env.sample", ".env.template"];

function safely<T>(skipped: Skipped[], label: string, fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    skipped.push({
      item: label,
      reason: `${label} failed: ${e instanceof Error ? e.message : String(e)}`,
    });
    return fallback;
  }
}

function envExampleKeys(ctx: DetectContext, dir: string): string[] {
  const keys = new Set<string>();
  const candidates = ENV_EXAMPLES.flatMap((n) => [path.posix.join(dir, n), n]);
  for (const file of new Set(candidates)) {
    if (!ctx.files.includes(file)) continue;
    for (const line of readText(ctx, file).split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
      if (m) keys.add(m[1]);
    }
  }
  return [...keys].sort();
}

export function planFragment(root: string, opts: PlanOptions): Plan {
  const abs = path.resolve(root);
  const repo = path.basename(abs);
  const fragmentPath = path.join(abs, FRAGMENT_REL);
  const existing = fs.existsSync(fragmentPath) ? fs.readFileSync(fragmentPath, "utf8") : null;
  // An existing fragment that doesn't parse can't be gap-filled: let the YAML error propagate.
  const existingDoc: Record<string, any> | null = existing ? (parseYaml(existing) ?? null) : null;
  const ctx: DetectContext = {
    root: abs,
    files: listRepoFiles(abs, opts.runner),
    runner: opts.runner,
    skipped: [],
  };

  const existingSetup =
    Object.values(existingDoc?.services ?? {})
      .map((s: any) => s?.setup_service)
      .find((s): s is string => typeof s === "string") ?? null;
  const existingVolume =
    Object.values(existingDoc?.services ?? {})
      .map((s: any) => s?.node_modules_volume)
      .find((v): v is string => typeof v === "string") ?? null;
  const noWorkspace: Workspace = { pm: "npm", packageDirs: [], setupName: null, setupFields: {} };
  const ws = safely(ctx.skipped, "workspace detection", noWorkspace, () =>
    detectWorkspace(ctx, existingSetup, existingVolume),
  );
  const findings: Finding[] = [
    ...safely(ctx.skipped, "package.json detection", [] as Finding[], () =>
      detectPackages(ctx, ws),
    ),
    ...safely(ctx.skipped, "Dockerfile detection", [] as Finding[], () => detectDockerfiles(ctx)),
    ...safely(ctx.skipped, "k8s manifest detection", [] as Finding[], () => detectK8s(ctx)),
    ...safely(ctx.skipped, "Helm detection", [] as Finding[], () => detectHelm(ctx)),
    ...safely(ctx.skipped, "kustomize detection", [] as Finding[], () => detectKustomize(ctx)),
    ...safely(ctx.skipped, "compose detection", [] as Finding[], () => detectCompose(ctx)),
  ];

  const corr = correlate(findings, repo);
  const services = corr.services.map(resolveService);
  const infrastructure = corr.infrastructure.map((g) => resolveInfra(g, corr.skipped));

  // An entry the human renamed keeps its name: a service matched by path, infrastructure by pod prefix.
  const adopt = (section: string, key: string, value: unknown) =>
    Object.entries(existingDoc?.[section] ?? {}).find(
      ([, e]: [string, any]) => e?.[key] === value,
    )?.[0];
  const renamed = new Map<string, string>();
  for (const s of services) {
    const name = adopt("services", "path", s.dir);
    if (name && name !== s.name) {
      renamed.set(s.name, name);
      s.name = name;
      for (const c of s.conflicts) c.service = name;
    }
  }
  const hosts = new Map(infrastructure.map((i) => [i.name, i.name]));
  for (const i of infrastructure) {
    const name = adopt("infrastructure", "k8s_pod_prefix", i.fields.k8s_pod_prefix.value);
    if (name && name !== i.name) {
      renamed.set(i.name, name);
      hosts.set(name, i.name);
      i.name = name;
    }
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  services.sort(byName);
  infrastructure.sort(byName);
  const names = new Set(services.map((s) => s.name));

  // Allocation: never for an entry that already has a value in the file.
  const inFile = (section: string, name: string, key: string) =>
    existingDoc?.[section]?.[name]?.[key] !== undefined;
  const taken = takenPorts(opts.reposRoot, fragmentPath, opts.localPath, existingDoc);
  const offsets = allocateOffsets(
    services.filter((s) => !inFile("services", s.name, "port_offset")).map((s) => s.name),
    taken.offsets,
    opts.portsPerSlot,
  );
  for (const s of services) {
    const n = offsets.get(s.name);
    if (n !== undefined)
      s.fields.port_offset = stated(n, "lowest free offset across registered repos");
  }
  const forwards = allocateForwards(
    infrastructure
      .filter((i) => !inFile("infrastructure", i.name, "k8s_forward_port"))
      .map((i) => i.name),
    taken.forwards,
  );
  for (const i of infrastructure) {
    const n = forwards.get(i.name);
    if (n !== undefined)
      i.fields.k8s_forward_port = stated(n, "lowest free forward port from 9050");
  }

  // k8s env addressed at in-cluster infrastructure → the werkmeister tunnel.
  const tunnels = infrastructure.map((i) => ({
    name: i.name,
    host: hosts.get(i.name),
    port: Number(
      existingDoc?.infrastructure?.[i.name]?.internal_port ?? i.fields.internal_port.value,
    ),
    forward: Number(
      existingDoc?.infrastructure?.[i.name]?.k8s_forward_port ?? i.fields.k8s_forward_port?.value,
    ),
  }));
  for (const s of services) {
    const env = s.fields.environment;
    if (!env) continue;
    const { env: next, rewritten } = rewriteEnv(
      env.value as Record<string, string>,
      s.k8sEnvKeys,
      tunnels,
    );
    if (rewritten.length) {
      s.fields.environment = guessed(
        next,
        `${env.source}; ${rewritten.join(", ")} rewritten from the in-cluster address to the werkmeister tunnel`,
      );
    }
  }

  // depends_on can only name services this fragment defines.
  for (const s of services) {
    const d = s.fields.depends_on;
    if (!d) continue;
    const kept = [...new Set((d.value as string[]).map((n) => renamed.get(n) ?? n))]
      .filter((n) => names.has(n) && n !== s.name)
      .sort();
    if (kept.length) s.fields.depends_on = { ...d, value: kept };
    else delete s.fields.depends_on;
  }

  // The shared install runs on the same image as the services that use its node_modules.
  const nodeServices = services.filter((s) => s.fields.setup_service);
  const setup: SetupPlan | null =
    ws.setupName && nodeServices.length
      ? {
          name: ws.setupName,
          fields: {
            image: {
              ...nodeServices[0].fields.image,
              source: `same image as ${nodeServices[0].name}`,
            },
            ...ws.setupFields,
          },
        }
      : null;

  const envExample: Record<string, string[]> = {};
  for (const s of services) {
    const declared = new Set([
      ...Object.keys((s.fields.environment?.value as Record<string, string>) ?? {}),
      ...((s.fields.secrets?.value as string[]) ?? []),
    ]);
    const keys = envExampleKeys(ctx, s.dir).filter((k) => !declared.has(k));
    if (keys.length) envExample[s.name] = keys;
  }

  return {
    repo,
    root: abs,
    fragmentPath,
    existing,
    services,
    infrastructure,
    setup,
    envExample,
    unmatched: corr.unmatched,
    skipped: [...ctx.skipped, ...corr.skipped],
  };
}

/** The plan as plain JSON for reports (no raw findings). */
export function planSummary(plan: Plan) {
  const fields = (f: Record<string, FieldValue>) =>
    Object.fromEntries(
      Object.entries(f).map(([k, v]) => [
        k,
        { value: v.value, source: v.source, confidence: v.confidence },
      ]),
    );
  return {
    repo: plan.repo,
    fragment: plan.fragmentPath,
    existed: plan.existing !== null,
    services: plan.services.map((s) => ({
      name: s.name,
      dir: s.dir,
      fields: fields(s.fields),
      conflicts: s.conflicts.map((c) => ({ key: c.key, chosen: c.chosen, also: c.also })),
    })),
    infrastructure: plan.infrastructure.map((i) => ({ name: i.name, fields: fields(i.fields) })),
    setup: plan.setup ? { name: plan.setup.name, fields: fields(plan.setup.fields) } : null,
    envExample: plan.envExample,
    skipped: plan.skipped,
  };
}
