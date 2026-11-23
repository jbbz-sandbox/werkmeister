/**
 * SW-1071 spike: ICM workflows from outside the werkmeister source. A workflow is a folder
 * `<work_type>/` holding `workflow.yaml` (the stage list) and `stages/<name>.md` (each
 * stage's contract, in the same sections as a rendered stage CONTEXT.md and icm-architect's
 * stage template). Looked up in each repo's `.werkmeister/workflows/`, then
 * `~/.werkmeister/workflows/`; the first match replaces the built-in of that name whole.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import * as YAML from "yaml";

import { sandboxHome } from "../config.js";
import { repoDirs } from "../standards.js";
import type { Contract, IcmVars, Stage } from "./icm_templates.js";

/** Grants pre-approve commands for the whole run, so a template from a cloned repo may only ask for the built-ins' own. */
export const ALLOWED_GRANTS = ["issue start", "issue view", "pr push:*"];

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
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

/** The first external workflow folder for *workType*, or null. */
export function findWorkflow(workspaceRoot: string | undefined, workType: string): string | null {
  if (!NAME_RE.test(workType)) return null;
  return (
    workflowDirs(workspaceRoot, workType).find((d) => fs.existsSync(path.join(d, "workflow.yaml"))) ??
    null
  );
}

function fail(dir: string, why: string): never {
  throw new Error(`ICM workflow ${dir}: ${why}`);
}

/** `{{repos}}`, `{{restart}}`, `{{at:<stage>}}`; any other `{{…}}` is an error, so a typo never renders. */
function fill(text: string, v: IcmVars, where: string): string {
  return text.replace(/\{\{\s*([a-z]+)(?::([a-z0-9-]+))?\s*\}\}/g, (m, key: string, arg?: string) => {
    if (key === "repos" && !arg) return v.repos;
    if (key === "restart" && !arg) return v.restart;
    if (key === "at" && arg) {
      const p = v.at(arg);
      if (p.endsWith("/undefined")) throw new Error(`${where}: ${m} names no stage of this workflow`);
      return p;
    }
    throw new Error(`${where}: unknown variable ${m} (use {{repos}}, {{restart}} or {{at:<stage>}})`);
  });
}

/** Split a stage file into its contract sections; the text before the first `##` is the one job. */
function parseContract(file: string, body: string): Record<string, string[] | string> {
  const out: Record<string, string[] | string> = {};
  let key: keyof Contract = "oneJob";
  const lines: Record<string, string[]> = { oneJob: [] };
  for (const line of body.split("\n")) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      const k = SECTIONS[h[1].toLowerCase()];
      if (!k) fail(file, `unknown section "## ${h[1]}" (expected ${Object.keys(SECTIONS).join(", ")})`);
      key = k;
      lines[key] = [];
    } else if (!/^#\s/.test(line)) lines[key].push(line);
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
    if (!out[k] || out[k].length === 0) fail(file, `missing or empty ${k === "oneJob" ? "one-job paragraph" : `"## ${Object.keys(SECTIONS).find((s) => SECTIONS[s] === k)}"`}`);
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
  if (!Array.isArray(list) || !list.length) fail(dir, "workflow.yaml: `stages:` must be a non-empty list");
  const names = new Set<string>();
  return list.map((s: any, i: number): Stage => {
    const where = `stages[${i}]`;
    for (const k of ["name", "job", "writes", "check"])
      if (typeof s?.[k] !== "string" || !s[k].trim()) fail(dir, `${where}: \`${k}\` is required`);
    if (!NAME_RE.test(s.name)) fail(dir, `${where}: name "${s.name}" must be lowercase-hyphen`);
    if (names.has(s.name)) fail(dir, `${where}: duplicate stage name "${s.name}"`);
    names.add(s.name);
    const grants: string[] = s.grants ?? [];
    const bad = grants.filter((g) => !ALLOWED_GRANTS.includes(g));
    if (bad.length) fail(dir, `${where}: grants ${bad.join(", ")} not allowed (allowed: ${ALLOWED_GRANTS.join(", ")})`);
    const file = path.join(dir, "stages", `${s.name}.md`);
    if (!fs.existsSync(file)) fail(dir, `${where}: no stages/${s.name}.md`);
    const raw = parseContract(file, fs.readFileSync(file, "utf8"));
    return {
      name: s.name,
      job: s.job,
      writes: s.writes,
      check: s.check,
      ...(s.enter ? { enter: s.enter } : {}),
      ...(s.gate ? { gate: s.gate } : {}),
      standards: s.standards ?? "none",
      ...(grants.length ? { grants } : {}),
      contract: (v) => {
        const at = (x: string) => fill(x, v, file);
        const c: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(raw)) c[k] = Array.isArray(val) ? val.map(at) : at(val);
        return c as unknown as Contract;
      },
    };
  });
}
