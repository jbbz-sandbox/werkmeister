/** Helm charts → `helm template` output → findingsFromManifests. */
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { readText, yamlDocs } from "./files.js";
import { chartDirs, findingsFromManifests } from "./k8s.js";
import type { DetectContext, Finding } from "./types.js";

function chartName(ctx: DetectContext, chart: string): string {
  try {
    const name = parseYaml(readText(ctx, `${chart}/Chart.yaml`))?.name;
    return typeof name === "string" && name ? name : path.posix.basename(chart);
  } catch {
    return path.posix.basename(chart);
  }
}

/**
 * Each `<release>.values.yaml` beside a chart is one release of it
 * (`charts/backend.values.yaml` + `charts/webapp`); a chart with none renders
 * once with its own values under its Chart.yaml name.
 */
export function detectHelm(ctx: DetectContext): Finding[] {
  const charts = chartDirs(ctx.files);
  const out: Finding[] = [];
  for (const chart of charts) {
    const parent = path.posix.dirname(chart);
    const siblings = charts.filter((c) => path.posix.dirname(c) === parent);
    const valuesHere = ctx.files.filter((f) => path.posix.dirname(f) === parent && /[^/]\.values\.ya?ml$/.test(f));
    if (valuesHere.length && siblings.length > 1) {
      if (chart === siblings[0]) {
        for (const v of valuesHere) {
          ctx.skipped.push({ item: v, reason: `several charts in ${parent}/ — can't tell which one ${v} is for` });
        }
      }
      continue;
    }
    const releases = valuesHere.length
      ? valuesHere.map((v) => ({ release: path.posix.basename(v).replace(/\.values\.ya?ml$/, ""), values: v as string | null }))
      : [{ release: chartName(ctx, chart), values: null }];
    for (const { release, values } of releases) {
      const cmd = ["helm", "template", release, path.join(ctx.root, chart)];
      if (values) cmd.push("-f", path.join(ctx.root, values));
      const [rc, text] = ctx.runner(cmd);
      if (rc === 127) {
        ctx.skipped.push({ item: "helm charts", reason: "helm is not installed — charts skipped" });
        return out;
      }
      const item = values ?? chart;
      if (rc !== 0) {
        ctx.skipped.push({ item, reason: `helm template failed: ${text.split("\n")[0]}` });
        continue;
      }
      try {
        out.push(...findingsFromManifests([{ file: `${item} (helm template)`, dir: null, docs: yamlDocs(text) }]));
      } catch (e) {
        ctx.skipped.push({ item, reason: `unparsable helm output: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }
  return out;
}
