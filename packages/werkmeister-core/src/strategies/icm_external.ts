/**
 * ICM workflows from outside the werkmeister source (SW-1071 design, SW-1077). A workflow is a folder
 * `<work_type>/` holding `workflow.yaml` (the stage list) and `stages/<name>.md` (each
 * stage's contract, in the same sections as a rendered stage CONTEXT.md and icm-architect's
 * stage template). Looked up in each repo's `.werkmeister/workflows/`, then
 * `~/.werkmeister/workflows/`; the first match replaces the built-in of that name whole.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as YAML from "yaml";

import { getReposRoot, loadReposConfig, sandboxHome } from "../config.js";
import { SandboxError } from "../errors.js";
import { repoDirs } from "../standards.js";
import type { Contract, IcmVars, Stage } from "./icm_templates.js";

/** A workflow folder that can't be loaded; a `SandboxError`, so the CLI prints it as `[err]`. */
export class WorkflowError extends SandboxError {
  constructor(message: string) {
    super(message, "ICM_WORKFLOW");
    this.name = "WorkflowError";
  }
}

/** Grants pre-approve commands for the whole run, so a template from a cloned repo may only ask for the built-ins' own. */
export const ALLOWED_GRANTS = ["issue start", "issue view", "pr push:*"];

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FENCE = /^\s*(```|~~~)/;
const SECTIONS: Record<string, keyof Contract> = {
  inputs: "inputs",
  "do not load": "doNotLoad",
  process: "process",
  outputs: "outputs",
  "human check": "humanCheck",
  "self-check": "selfCheck",
};
const LISTS = new Set<keyof Contract>(["inputs", "process", "outputs"]);

/** Where *workType* is looked up, highest precedence first. */
export function workflowDirs(workspaceRoot: string | undefined, workType: string): string[] {
  const repos = workspaceRoot ? repoDirs(workspaceRoot) : [];
  return [
    ...repos.map((r) => path.join(r, ".werkmeister", "workflows", workType)),
    path.join(sandboxHome(), "workflows", workType),
  ];
}

/** Every external workflow folder for *workType*, highest precedence first; the first one wins. */
export function workflowCandidates(workspaceRoot: string | undefined, workType: string): string[] {
  if (!NAME_RE.test(workType)) return [];
  return workflowDirs(workspaceRoot, workType).filter((d) =>
    fs.existsSync(path.join(d, "workflow.yaml")),
  );
}

/** The external workflow folder that wins for *workType*, or null. */
export function findWorkflow(workspaceRoot: string | undefined, workType: string): string | null {
  return workflowCandidates(workspaceRoot, workType)[0] ?? null;
}

/**
 * The work types found in `~/.werkmeister/workflows/` and in each registered repo's checkout,
 * sorted; for the create form's choices, so it lists folders and never validates them.
 */
export function listWorkflowTypes(): string[] {
  const roots = [
    path.join(sandboxHome(), "workflows"),
    ...Object.keys(loadReposConfig()).map((r) =>
      path.join(getReposRoot(), r, ".werkmeister", "workflows"),
    ),
  ];
  const types = roots.flatMap((root) => {
    try {
      return fs
        .readdirSync(root)
        .filter((t) => NAME_RE.test(t) && fs.existsSync(path.join(root, t, "workflow.yaml")));
    } catch {
      return [];
    }
  });
  return [...new Set(types)].sort();
}

function fail(dir: string, why: string): never {
  throw new WorkflowError(`ICM workflow ${dir}: ${why}`);
}

const VAR_RE = /\{\{\s*([a-z]+)(?::([a-z0-9-]+))?\s*\}\}/g;

/** `{{repos}}`, `{{restart}}`, `{{at:<stage>}}`; any other `{{…}}` fails at load, before init writes a file. */
function checkVars(file: string, text: string, stages: Set<string>): void {
  // Every `{{…}}`, not only VAR_RE's shape, so `{{Repos}}` fails instead of rendering literally.
  for (const [m] of text.matchAll(/\{\{[^}]*\}\}/g)) {
    const [, key, arg] = new RegExp(`^${VAR_RE.source}$`).exec(m) ?? [];
    if ((key === "repos" || key === "restart") && !arg) continue;
    if (key === "at" && arg && stages.has(arg)) continue;
    if (key === "at" && arg) fail(file, `${m} names no stage of this workflow`);
    fail(file, `unknown variable ${m} (use {{repos}}, {{restart}} or {{at:<stage>}})`);
  }
}

function fill(text: string, v: IcmVars): string {
  return text.replace(VAR_RE, (_m, key: string, arg?: string) =>
    key === "at" ? v.at(arg as string) : key === "repos" ? v.repos : v.restart,
  );
}

/** Split a stage file into its contract sections; the text before the first `##` is the one job. */
function parseContract(file: string, body: string): Record<string, string[] | string> {
  const out: Record<string, string[] | string> = {};
  let key: keyof Contract = "oneJob";
  const lines: Record<string, string[]> = { oneJob: [] };
  let fenced = false;
  for (const line of body.split("\n")) {
    // A `#` line inside a code fence is content, as icm_decisions.ts reads it.
    if (FENCE.test(line)) fenced = !fenced;
    const h = fenced || FENCE.test(line) ? null : /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const k = SECTIONS[h[1].toLowerCase()];
      if (!k)
        fail(file, `unknown section "## ${h[1]}" (expected ${Object.keys(SECTIONS).join(", ")})`);
      key = k;
      lines[key] = [];
    } else if (fenced || !/^#\s/.test(line)) lines[key].push(line);
  }
  for (const [k, ls] of Object.entries(lines)) {
    const text = ls.join("\n").trim();
    out[k] = LISTS.has(k as keyof Contract)
      ? text
          .split("\n")
          .filter((l) => /^\s*(-|\d+\.)\s+/.test(l))
          .map((l) => l.replace(/^\s*(-|\d+\.)\s+/, ""))
      : text;
  }
  for (const k of ["oneJob", "inputs", "doNotLoad", "process", "outputs", "humanCheck"]) {
    if (!out[k] || out[k].length === 0)
      fail(
        file,
        `missing or empty ${k === "oneJob" ? "one-job paragraph" : `"## ${Object.keys(SECTIONS).find((s) => SECTIONS[s] === k)}"`}`,
      );
  }
  return out;
}

/** Load and validate the workflow in *dir*; throws with the path and the reason. */
export function loadWorkflow(dir: string): Stage[] {
  let manifest: any;
  try {
    manifest = YAML.parse(fs.readFileSync(path.join(dir, "workflow.yaml"), "utf8"));
  } catch (e) {
    fail(dir, `workflow.yaml: ${(e as Error).message}`);
  }
  if (manifest?.version !== 1) fail(dir, "workflow.yaml: `version: 1` is required");
  const list = manifest.stages;
  if (!Array.isArray(list) || !list.length)
    fail(dir, "workflow.yaml: `stages:` must be a non-empty list");
  const names = new Set<string>();
  const raws: Array<[string, Record<string, string[] | string>]> = [];
  const stages = list.map((s: any, i: number): Stage => {
    const where = `stages[${i}]`;
    for (const k of ["name", "job", "writes", "check"])
      if (typeof s?.[k] !== "string" || !s[k].trim()) fail(dir, `${where}: \`${k}\` is required`);
    if (!NAME_RE.test(s.name)) fail(dir, `${where}: name "${s.name}" must be lowercase-hyphen`);
    if (names.has(s.name)) fail(dir, `${where}: duplicate stage name "${s.name}"`);
    names.add(s.name);
    const grants: string[] = s.grants ?? [];
    if (!Array.isArray(grants)) fail(dir, `${where}: \`grants\` must be a list`);
    const bad = grants.filter((g) => !ALLOWED_GRANTS.includes(g));
    if (bad.length)
      fail(
        dir,
        `${where}: grants ${bad.join(", ")} not allowed (allowed: ${ALLOWED_GRANTS.join(", ")})`,
      );
    const file = path.join(dir, "stages", `${s.name}.md`);
    if (!fs.existsSync(file)) fail(dir, `${where}: no stages/${s.name}.md`);
    const raw = parseContract(file, fs.readFileSync(file, "utf8"));
    raws.push([file, raw]);
    for (const k of ["enter", "gate"])
      if (s[k] !== undefined && typeof s[k] !== "string")
        fail(dir, `${where}: \`${k}\` must be text`);
    const tier = s.standards ?? "none";
    if (
      !(
        tier === "none" ||
        tier === "all" ||
        (Array.isArray(tier) && tier.every((d) => typeof d === "string"))
      )
    )
      fail(dir, `${where}: \`standards\` must be none, all or a list of standards`);
    return {
      name: s.name,
      job: s.job,
      writes: s.writes,
      check: s.check,
      ...(s.enter ? { enter: s.enter } : {}),
      ...(s.gate ? { gate: s.gate } : {}),
      standards: tier,
      ...(grants.length ? { grants } : {}),
      contract: (v) => {
        const at = (x: string) => fill(x, v);
        const c: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(raw))
          c[k] = Array.isArray(val) ? val.map(at) : at(val);
        return c as unknown as Contract;
      },
    };
  });
  // After the loop: `{{at:x}}` may name a later stage.
  for (const [file, raw] of raws) checkVars(file, Object.values(raw).flat().join("\n"), names);
  return stages;
}
