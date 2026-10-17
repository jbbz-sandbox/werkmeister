/** kustomize overlays → `kubectl kustomize` output → findingsFromManifests. */
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { readText, yamlDocs } from "./files.js";
import { findingsFromManifests, KUSTOMIZATION } from "./k8s.js";
import type { DetectContext, Finding } from "./types.js";

/** Dirs another kustomization lists under resources/bases/components: they render as part of it. */
function referencedDirs(ctx: DetectContext, files: string[]): Set<string> {
  const out = new Set<string>();
  for (const file of files) {
    let doc: any;
    try {
      doc = parseYaml(readText(ctx, file));
    } catch {
      continue; // kubectl reports it when this one is rendered
    }
    const dir = path.posix.dirname(file);
    for (const ref of [doc?.resources, doc?.bases, doc?.components].flatMap((l) =>
      Array.isArray(l) ? l : [],
    )) {
      if (typeof ref === "string")
        out.add(path.posix.normalize(path.posix.join(dir, ref)).replace(/\/$/, ""));
    }
  }
  return out;
}

export function detectKustomize(ctx: DetectContext): Finding[] {
  const out: Finding[] = [];
  const files = ctx.files.filter((f) => KUSTOMIZATION.test(f));
  const bases = referencedDirs(ctx, files);
  for (const file of files) {
    const dir = path.posix.dirname(file);
    if (bases.has(dir)) continue;
    const [rc, text] = ctx.runner(["kubectl", "kustomize", path.join(ctx.root, dir)]);
    if (rc === 127) {
      ctx.skipped.push({
        item: "kustomize overlays",
        reason: "kubectl is not installed — overlays skipped",
      });
      return out;
    }
    if (rc !== 0) {
      ctx.skipped.push({ item: file, reason: `kubectl kustomize failed: ${text.split("\n")[0]}` });
      continue;
    }
    try {
      out.push(
        ...findingsFromManifests([
          { file: `${file} (kubectl kustomize)`, dir: null, docs: yamlDocs(text) },
        ]),
      );
    } catch (e) {
      ctx.skipped.push({
        item: file,
        reason: `unparsable kustomize output: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return out;
}
