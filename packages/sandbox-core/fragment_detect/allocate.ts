/**
 * port_offset and k8s_forward_port allocation (spec §4), and the rewrite of
 * k8s env values that address infrastructure in-cluster.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { portsYamlPath } from "../config.js";
import { discoverFragments } from "../registry_sync.js";

export class AllocationError extends Error {}

export interface Taken {
  offsets: Set<number>;
  forwards: Set<number>;
}

/** `feature_slots.ports_per_slot` from ports.yaml; 20 when unreadable. */
export function portsPerSlot(file = portsYamlPath()): number {
  try {
    const n = parseYaml(fs.readFileSync(file, "utf8"))?.feature_slots?.ports_per_slot;
    return Number.isInteger(n) && n > 0 ? n : 20;
  } catch {
    return 20;
  }
}

function collect(doc: Record<string, any> | null, taken: Taken): void {
  for (const section of ["services", "infrastructure"]) {
    for (const entry of Object.values(doc?.[section] ?? {})) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      if (Number.isInteger(e.port_offset)) taken.offsets.add(e.port_offset as number);
      if (Number.isInteger(e.k8s_forward_port)) taken.forwards.add(e.k8s_forward_port as number);
    }
  }
}

/**
 * Offsets and forward ports already claimed. Other repos' fragments are read
 * directly (not the generated registry), so a repo cloned but not yet synced
 * still counts. This repo's own fragment comes in as *existing*.
 */
export function takenPorts(
  reposRoot: string,
  fragmentPath: string,
  localPath: string,
  existing: Record<string, any> | null,
): Taken {
  const taken: Taken = { offsets: new Set(), forwards: new Set() };
  for (const f of discoverFragments(reposRoot)) {
    if (path.resolve(f.path) !== path.resolve(fragmentPath)) collect(f.doc, taken);
  }
  if (fs.existsSync(localPath)) collect(parseYaml(fs.readFileSync(localPath, "utf8")) ?? null, taken);
  collect(existing, taken);
  return taken;
}

export function allocateOffsets(names: string[], taken: Set<number>, limit: number): Map<string, number> {
  const used = new Set(taken);
  const out = new Map<string, number>();
  for (const name of [...names].sort()) {
    let n = 0;
    while (used.has(n)) n++;
    if (n >= limit) {
      throw new AllocationError(
        `port_offset exhausted: ${limit} offsets (ports.yaml ports_per_slot) are all used — raise ports_per_slot or free one`,
      );
    }
    used.add(n);
    out.set(name, n);
  }
  return out;
}

export function allocateForwards(names: string[], taken: Set<number>, start = 9050): Map<string, number> {
  const used = new Set(taken);
  const out = new Map<string, number>();
  for (const name of [...names].sort()) {
    let n = start;
    while (used.has(n)) n++;
    used.add(n);
    out.set(name, n);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `postgres:5432` (in-cluster) → `k8s-postgres:<forward>` (the sandbox
 * tunnel), in the *keys* that came from k8s only.
 */
export function rewriteEnv(
  env: Record<string, string>,
  keys: string[],
  /** `host` is the in-cluster name when the entry was renamed; it defaults to `name`. */
  tunnels: { name: string; host?: string; port: number; forward: number }[],
): { env: Record<string, string>; rewritten: string[] } {
  const out = { ...env };
  const rewritten: string[] = [];
  for (const key of keys) {
    const before = out[key];
    if (before === undefined) continue;
    let value = before;
    for (const t of tunnels) {
      value = value.replace(new RegExp(`(?<![\\w.-])${escapeRe(t.host ?? t.name)}:${t.port}\\b`, "g"), `k8s-${t.name}:${t.forward}`);
    }
    if (value !== before) {
      out[key] = value;
      rewritten.push(key);
    }
  }
  return { env: out, rewritten };
}
