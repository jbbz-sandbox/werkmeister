/** Workspace detection: the package manager, the package dirs and the shared install service. */
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { readJson, readText } from "./files.js";
import { stated, type DetectContext, type PackageManager, type Workspace } from "./types.js";

const INSTALL: Record<PackageManager, string> = {
  npm: "npm install",
  pnpm: "corepack enable && pnpm install",
  yarn: "corepack enable && yarn install",
};

/** Glob patterns from `workspaces` / `pnpm-workspace.yaml` → the package dirs present in *files*. */
export function expandWorkspaceGlobs(patterns: string[], files: string[]): string[] {
  const toRe = (pattern: string) =>
    new RegExp(
      "^" +
        pattern
          .replace(/^\.\//, "")
          .replace(/\/+$/, "")
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*\*/g, "\0")
          .replace(/\*/g, "[^/]+")
          .replace(/\0/g, ".+") +
        "$",
    );
  const include = patterns.filter((p) => !p.startsWith("!")).map(toRe);
  const exclude = patterns.filter((p) => p.startsWith("!")).map((p) => toRe(p.slice(1)));
  return files
    .filter((f) => f.endsWith("/package.json"))
    .map((f) => path.posix.dirname(f))
    .filter((d) => include.some((r) => r.test(d)) && !exclude.some((r) => r.test(d)))
    .sort();
}

/**
 * The workspace shape. *existingSetupName* is the `setup_service` an existing
 * fragment already uses, so a re-run doesn't add a second install service
 * under a new name.
 */
export function detectWorkspace(ctx: DetectContext, existingSetupName: string | null = null): Workspace {
  const has = (f: string) => ctx.files.includes(f);
  const pm: PackageManager =
    has("pnpm-lock.yaml") || has("pnpm-workspace.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
  const rootPkg = readJson(ctx, "package.json");
  if (!rootPkg) return { pm, packageDirs: [], setupName: null, setupFields: {} };

  let patterns: string[] = [];
  let source = "package.json";
  if (has("pnpm-workspace.yaml")) {
    const packages = parseYaml(readText(ctx, "pnpm-workspace.yaml"))?.packages;
    patterns = Array.isArray(packages) ? packages.map(String) : [];
    source = "pnpm-workspace.yaml";
  } else {
    const ws = rootPkg["workspaces"];
    patterns = Array.isArray(ws) ? ws.map(String) : Array.isArray(ws?.packages) ? ws.packages.map(String) : [];
    if (patterns.length) source = "package.json → workspaces";
  }
  return {
    pm,
    packageDirs: expandWorkspaceGlobs(patterns, ctx.files),
    setupName: existingSetupName ?? `${path.basename(ctx.root)}-install`,
    setupFields: {
      command: stated(INSTALL[pm], `${source} (${pm})`),
      node_modules_volume: stated("node-modules", source),
    },
  };
}
