/** Group findings into services (anchored to a source dir), infrastructure and leftovers. */
import * as path from "node:path";

import type { Finding, Skipped } from "./types.js";

/** Known datastore images → the wire probe `sandbox` can run (`""` = TCP only) and their default port. */
export const DATASTORES: Record<string, { health: string; port: number }> = {
  redis: { health: "redis", port: 6379 },
  postgres: { health: "postgres", port: 5432 },
  postgis: { health: "postgres", port: 5432 },
  mysql: { health: "", port: 3306 },
  mariadb: { health: "", port: 3306 },
  mongo: { health: "", port: 27017 },
  rabbitmq: { health: "", port: 5672 },
};

/** `ghcr.io/acme/backend:1.2@sha256:…` → `backend`. */
export function imageRepoName(image: string): string {
  const last = image.split("@")[0].split("/").pop() ?? image;
  return last.split(":")[0];
}

export interface ServiceGroup {
  name: string;
  dir: string;
  findings: Finding[];
}

export interface InfraGroup {
  name: string;
  datastore: string;
  findings: Finding[];
}

export interface Correlation {
  services: ServiceGroup[];
  infrastructure: InfraGroup[];
  /** Deploy-side findings that matched nothing and aren't datastores. */
  unmatched: Finding[];
  skipped: Skipped[];
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function datastoreOf(f: Finding): string | null {
  const repo = f.image ? imageRepoName(f.image) : "";
  return Object.hasOwn(DATASTORES, repo) ? repo : null;
}

export function correlate(findings: Finding[], repoName: string): Correlation {
  const sourceSide = findings.filter((f) => f.kind === "package" || f.kind === "dockerfile");
  const deploySide = findings.filter((f) => f.kind === "k8s" || f.kind === "compose");

  const dirs = [...new Set(sourceSide.map((f) => f.dir as string))].sort();
  const base = (d: string) => (d === "." ? repoName : path.posix.basename(d));
  const parent = (d: string) => {
    const p = path.posix.dirname(d);
    return p === "." ? repoName : path.posix.basename(p);
  };
  const counts = new Map<string, number>();
  for (const d of dirs) counts.set(base(d), (counts.get(base(d)) ?? 0) + 1);
  const groups: ServiceGroup[] = dirs.map((d) => ({
    dir: d,
    name: (counts.get(base(d)) ?? 0) > 1 ? `${parent(d)}-${base(d)}` : base(d),
    findings: sourceSide.filter((f) => f.dir === d),
  }));

  type Rule = (f: Finding, g: ServiceGroup) => boolean;
  const rules: Rule[] = [
    (f, g) => f.kind === "k8s" && f.dir !== null && g.dir !== "." && (f.dir === g.dir || f.dir.startsWith(`${g.dir}/`)),
    (f, g) => f.kind === "compose" && f.dir !== null && f.dir === g.dir,
    (f, g) => f.name === g.name,
    (f, g) => Boolean(f.image) && imageRepoName(f.image as string) === g.name,
  ];
  const leftover: Finding[] = [];
  for (const f of deploySide) {
    // A datastore can only be claimed by name; location and image would mis-attach it.
    const usable = datastoreOf(f) ? [rules[2]] : rules;
    let target: ServiceGroup | undefined;
    for (const rule of usable) {
      target = groups.find((g) => rule(f, g));
      if (target) break;
    }
    if (target) target.findings.push(f);
    else leftover.push(f);
  }

  const skipped: Skipped[] = [];
  const infra = new Map<string, InfraGroup>();
  const unmatched: Finding[] = [];
  for (const f of leftover) {
    const ds = datastoreOf(f);
    if (ds) {
      const g = infra.get(f.name) ?? { name: f.name, datastore: ds, findings: [] };
      g.findings.push(f);
      infra.set(f.name, g);
    } else {
      unmatched.push(f);
      const what = f.kind === "k8s" ? "Deployment" : "compose service";
      skipped.push({ item: f.file, reason: `found ${what} ${f.name} — no source dir in this repo, skipped` });
    }
  }

  const services = groups.filter((g) => {
    const keep = g.findings.some((f) => f.kind !== "package" || f.runnable);
    if (!keep) {
      skipped.push({ item: g.dir, reason: "library package (no Dockerfile, deploy config or dev/start script), skipped" });
    }
    return keep;
  });

  return { services: services.sort(byName), infrastructure: [...infra.values()].sort(byName), unmatched, skipped };
}
