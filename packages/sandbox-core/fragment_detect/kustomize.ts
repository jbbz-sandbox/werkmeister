/** kustomize overlays → `kubectl kustomize` output → findingsFromManifests. */
import * as path from "node:path";

import { yamlDocs } from "./files.js";
import { findingsFromManifests } from "./k8s.js";
import type { DetectContext, Finding } from "./types.js";

export function detectKustomize(ctx: DetectContext): Finding[] {
  const out: Finding[] = [];
  for (const file of ctx.files.filter((f) => /(^|\/)kustomization\.ya?ml$/.test(f))) {
    const dir = path.posix.dirname(file);
    const [rc, text] = ctx.runner(["kubectl", "kustomize", path.join(ctx.root, dir)]);
    if (rc === 127) {
      ctx.skipped.push({ item: "kustomize overlays", reason: "kubectl is not installed — overlays skipped" });
      return out;
    }
    if (rc !== 0) {
      ctx.skipped.push({ item: file, reason: `kubectl kustomize failed: ${text.split("\n")[0]}` });
      continue;
    }
    try {
      out.push(...findingsFromManifests([{ file: `${file} (kubectl kustomize)`, dir: null, docs: yamlDocs(text) }]));
    } catch (e) {
      ctx.skipped.push({ item: file, reason: `unparsable kustomize output: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return out;
}
