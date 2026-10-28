/**
 * The `icm` context strategy: a staged-folder pipeline the agent walks by
 * itself (docs/context-strategies.md). Plain files only — no hooks, no notes,
 * no gate manifest. `CLAUDE.md` routes, `CONTEXT.md` shows the pipeline,
 * `BRIEF.md` is the operator's, `_shared/standards.md` points at the standards
 * tree, `_shared/issues-report.md` says where to file issues, and each
 * `stages/NN_<name>/CONTEXT.md` is one stage's contract. The one hook it
 * installs is the PR guard (hooks_gen.ts), which both strategies share.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { COMPOSE_FILE } from "../compose_file.js";
import { dotDir, IDLE_SERVICE_TYPES } from "../config.js";
import { standardsDirPath, standardsDirProblem } from "../global_config.js";
import { removeWorkspaceHooks, writePrGuardHook, writeWorkspaceSettings } from "../hooks_gen.js";
import { issueIdOfMeta, issueTracker } from "../issue_tracker.js";
import { buildIssuesReportMd } from "../issues_report.js";
import { buildPrRulesMd } from "../pr_rules.js";
import { info, success, warn } from "../reporter.js";
import { RUN_LIMITS } from "../run_start.js";
import {
  loadStandardsModules,
  repoDirs,
  resolveActiveStandards,
  universalStandards,
} from "../standards.js";
import {
  _INPUT_FIELDS,
  isTrue,
  loadConfigFile,
  loadSandboxServiceConfigs,
} from "../workspace_prompts.js";
import { stageDecisions } from "./icm_decisions.js";
import { type IcmVars, SELF_CHECK, type Stage, templateFor } from "./icm_templates.js";
import { renderIssueRef } from "./issue_section.js";
import type { ContextStrategy, InitContext } from "./types.js";

const PONYTAIL_ROW =
  "| ponytail | already loaded: the ponytail plugin's SessionStart hook prints `PONYTAIL MODE ACTIVE` " +
  "in every session. Invoke the `ponytail` skill only if that line is missing from your session context " +
  "| any code edit |";

interface Resolved {
  active: string[];
  notActive: string[];
  modules: Record<string, Record<string, any>>;
}

function list(s: string | undefined): string[] {
  return (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x);
}

function stageDirs(stages: Stage[]): string[] {
  return stages.map((s, i) => `${String(i + 1).padStart(2, "0")}_${s.name}`);
}

/**
 * Stage dirs on disk that this template would not render — a run started under
 * another stage set, e.g. `03_verify`/`04_ship` from before decision 11 renamed
 * them. Rendering over it would add the new dirs beside the old ones (#149).
 */
function foreignStageDirs(root: string, stages: Stage[]): string[] {
  const own = stageDirs(stages);
  let onDisk: string[];
  try {
    onDisk = fs.readdirSync(path.join(root, "stages")).filter((n) => /^\d+_/.test(n));
  } catch {
    return [];
  }
  return onDisk.filter((d) => !own.includes(d)).sort();
}

/** The stage dir that holds PR files, or null for a template with no propose stage (spike). */
function proposeDir(stages: Stage[]): string | null {
  const i = stages.findIndex((s) => s.name === "propose");
  return i < 0 ? null : stageDirs(stages)[i];
}

/** The stage dir whose output holds PR files: propose, else the last stage (spike, SW-83). */
function prDir(stages: Stage[]): string {
  return proposeDir(stages) ?? stageDirs(stages)[stages.length - 1];
}

/**
 * How to reload each service. Container names follow docker-compose.feature.yml.njk
 * (<feature>-<service>); idle types run no watcher, so a restart rebuilds nothing (SW-32).
 */
function restartLine(feature: string, services: string[]): string {
  const [servicesConfig] = loadSandboxServiceConfigs();
  const isIdle = (s: string) => IDLE_SERVICE_TYPES.includes(servicesConfig[s]?.type ?? "");
  const names = (list: string[]) => list.map((s) => `\`${feature}-${s}\``).join(", ");
  const restarted = services.filter((s) => !isIdle(s));
  const idle = services.filter(isIdle);
  return [
    restarted.length ? restarted.map((s) => `\`docker restart ${feature}-${s}\``).join(", ") : "",
    idle.length
      ? `${names(idle)} run no watcher, so a restart rebuilds nothing: build and test inside them with \`docker exec\` as \`.werkmeister/werkmeister-context.md\` § Test commands shows`
      : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function vars(ctx: InitContext, stages: Stage[]): IcmVars {
  const dirs = stageDirs(stages);
  const feature = (ctx.meta["FEATURE"] ?? "").trim();
  const services = list(ctx.meta["SERVICES"]);
  const repos = ctx.repos.map(([name]) => name);
  return {
    at: (name) => `../${dirs[stages.findIndex((s) => s.name === name)]}`,
    repos: repos.length
      ? repos.map((r) => `\`../../${r}/\``).join(", ")
      : "the code worktrees in this workspace",
    restart:
      feature && services.length
        ? restartLine(feature, services)
        : "restart whatever serves the change as `.werkmeister/werkmeister-context.md` describes",
    standards: "",
    autonomous: isTrue(ctx.inputs["autonomous"]),
  };
}

// The same resolution jit's step 5b makes; the gate manifest is not written.
function resolveStandards(ctx: InitContext): Resolved {
  const modules = loadStandardsModules();
  if (!Object.keys(modules).length) {
    warn(
      standardsDirProblem() ||
        `no standard modules found in ${standardsDirPath()} — _shared/standards.md lists none`,
    );
    return { active: [], notActive: [], modules };
  }
  const [servicesConfig, reposConfig] = loadSandboxServiceConfigs();
  const [active, notActive] = resolveActiveStandards(
    ctx.repos.map(([name]) => name),
    servicesConfig,
    reposConfig,
    loadConfigFile(ctx.workspaceRoot, ctx.configOverride),
    modules,
    list(ctx.meta["SERVICES"]),
  );
  return { active, notActive, modules };
}

function appliesWhen(meta: Record<string, any>): string {
  const globs: string[] = Array.isArray(meta["applies_to"]) ? meta["applies_to"].map(String) : [];
  if (!globs.length || globs.includes("**/*")) return "any code edit";
  return "editing " + globs.map((g) => `\`${g}\``).join(", ");
}

// The file is tracked in the run's record, so a machine path here would read
// as drift on any other machine (#163); name the root and say how to find it.
function standardsPath(meta: Record<string, any>): string {
  return (
    "<standards_dir>/" + path.relative(standardsDirPath(), meta["path"]).split(path.sep).join("/")
  );
}

function renderStandards(r: Resolved): string {
  const lines = [
    "# Coding standards (factory)",
    "",
    "Read from their one home, not copied. Load only the rows a stage's contract names.",
    "",
    "| Standard | Read | Applies when |",
    "|---|---|---|",
    ...r.active.map(
      (d) => `| ${d} | \`${standardsPath(r.modules[d])}\` | ${appliesWhen(r.modules[d])} |`,
    ),
    PONYTAIL_ROW,
    "",
    "`<standards_dir>` is this machine's standards tree: `werkmeister standards check` prints its path " +
      "(`overrides.standards_dir` in `werkmeister config`), and `werkmeister setup` grants Claude Code read access to it.",
    "",
  ];
  if (r.notActive.length) {
    lines.push(`Not applicable to this workspace (do not load): ${r.notActive.join(", ")}.`, "");
  }
  lines.push(
    "Before writing code on a path a standard governs, restate the one rule you are applying in a line next to the edit — a rule read twenty tool calls ago no longer steers.",
    "",
  );
  return lines.join("\n");
}

function standardsRef(tier: Stage["standards"], r: Resolved): string {
  if (tier === "none") return "";
  const universal = universalStandards(r.modules);
  const rows = tier === "all" ? r.active : r.active.filter((d) => universal.includes(d));
  return `- Reference (every run): \`../../_shared/standards.md\` — rows ${[...rows, "ponytail"].map((d) => `\`${d}\``).join(", ")}`;
}

// The first stage's start is the one point no code observes, so its contract runs the move (SW-27).
const START_ISSUE =
  "Run `werkmeister issue start`: it moves the issue to In Progress, and does nothing when the issue is already past that or the tracker refuses.";

function renderContract(dir: string, stage: Stage, v: IcmVars, startsIssue = false): string {
  const c = stage.contract(v);
  return [
    `# ${dir} — ${stage.job}`,
    "",
    c.oneJob,
    "",
    "## Inputs",
    ...c.inputs.map((i) => `- ${i}`),
    ...(v.standards ? [v.standards] : []),
    "",
    `Do NOT load: ${c.doNotLoad}`,
    "",
    "## Process",
    // Step 0, so the contracts' own "steps 1–3" references keep their numbers.
    ...(startsIssue ? [`0. ${START_ISSUE}`] : []),
    ...c.process.map((p, i) => `${i + 1}. ${p}`),
    "",
    "## Outputs",
    ...c.outputs.map((o) => `- ${o}`),
    "",
    ...(v.autonomous
      ? ["## Self-check", c.selfCheck ?? SELF_CHECK]
      : ["## Human check", c.humanCheck]),
    "",
  ].join("\n");
}

function renderClaudeMd(ctx: InitContext, stages: Stage[]): string {
  const dirs = stageDirs(stages);
  const v = vars(ctx, stages);
  return [
    `# Workspace: ${ctx.workspaceName}`,
    "",
    ctx.task,
    "",
    ...(ctx.issue ? [renderIssueRef(ctx.issue)] : []),
    "Read this file, then `CONTEXT.md`, then only the one stage `CONTEXT.md` the routing table sends you to. Nothing else up front.",
    "",
    "## Where things live",
    "",
    "| Path | Holds |",
    "|---|---|",
    "| `BRIEF.md` | the run's input: goal, acceptance criteria, open questions |",
    ...(ctx.issue?.fetchedAt
      ? [
          "| `.werkmeister/issue.md` | the issue as fetched at creation; refresh with `werkmeister init-workspace --refresh-issue` |",
        ]
      : []),
    "| `CONTEXT.md` | the pipeline in one screen |",
    "| `stages/NN_*/` | one stage each: `CONTEXT.md` (contract) + `output/` (this run's artifacts) |",
    "| `_shared/` | factory: the coding standards and `issues-report.md` (fix a bug here or file an issue — bug, feature or task — and how), same every run |",
    ...ctx.repos.map(
      ([name, branch]) =>
        `| \`${name}/\` | code worktree${branch ? `, branch \`${branch}\`` : ""} |`,
    ),
    "| this folder's git branch | the run's record (contracts + stage outputs): commit and push it; never open a PR from it or merge it |",
    "| `.werkmeister/werkmeister-context.md` | generated infra facts: how to validate, test command, ports, container names |",
    `| \`.werkmeister/*.yml\`, \`${COMPOSE_FILE}\`, \`.env\` | generated by \`werkmeister\`; do not hand-edit |`,
    "",
    `\`werkmeister up\` is safe here. Do not rerun \`werkmeister init-workspace\` unless you mean to regenerate this file and the stage contracts. To reload code after an edit, ${v.restart}.`,
    "",
    "## Route by what just happened",
    "",
    "| If | Go to | Stop when |",
    "|---|---|---|",
    ...stages.map(
      (s, i) =>
        `| ${i === 0 ? "starting the run" : (s.enter ?? `\`${dirs[i - 1]}\` output ${v.autonomous ? "self-checked" : "approved"}`)} | \`stages/${dirs[i]}/CONTEXT.md\` | ${v.autonomous ? "`output/` written and self-checked" : "a person has read `output/`"} |`,
    ),
    "| asked to open or create a PR — including `/create-pr` or `finishing-a-development-branch` | `_shared/pr-rules.md`, then `werkmeister pr open`, then Auto-fix on (rule 5) | PR URL is in the PR file and Auto-fix is on |",
    "| a PR merged or released, or asked to close out | `werkmeister pr status`, then the werkmeister `postmortem` skill (writes `postmortem.md`), then ask the person before `werkmeister close-out` | `postmortem.md` written, then closed out after the person says yes |",
    "| asked for status | `ls stages/*/output/` | report which stages hold artifacts |",
    "| containers / ports / routing broken | `.werkmeister/werkmeister-context.md` | — |",
    "| you hit a bug or need to log a feature/task — in the `werkmeister` tool or in a repo's code | `_shared/issues-report.md`: if this workspace's changes caused a bug, fix it here; otherwise file an issue where it belongs | fixed, or issue URL reported to the person |",
    "",
    ...(v.autonomous ? stopPoints(stages) : ONE_RULE),
    "",
  ].join("\n");
}

const ONE_RULE = [
  "## The one rule",
  "",
  "Nothing moves to the next stage until a person has read — and edited if needed — the previous stage's `output/`. The next stage reads whatever is there. The person's edit (a `decided` status, or a \"proceed\" after a gate) is the approval; never ask them to confirm it a second time.",
];

// `autonomous` (#175): the person's review moves to the PR, so these replace the one rule.
function stopPoints(stages: Stage[]): string[] {
  return [
    "## Stop points",
    "",
    "Walk every stage without stopping: each stage's self-check is its approval. Stop only at:",
    "",
    proposeDir(stages)
      ? "1. the PR URL from `werkmeister pr open`"
      : "1. the last stage's `output/` written",
    "2. a question only a person can answer",
    "3. a gate failure outside this issue's scope",
    "",
    "The gate (`werkmeister pr gate`: tests, clean worktree, exercise PASS, release check) still applies; `skip_tests` only for a service this workspace doesn't run, with the reason.",
  ];
}

function renderPipeline(ctx: InitContext, stages: Stage[]): string {
  const dirs = stageDirs(stages);
  return [
    `# ${ctx.workspaceName} — the pipeline`,
    "",
    `| Stage | Job | Output | ${isTrue(ctx.inputs["autonomous"]) ? "Self-check" : "Human check"} |`,
    "|---|---|---|---|",
    ...stages.map((s, i) => `| \`${dirs[i]}\` | ${s.job} | ${s.writes} | ${s.check} |`),
    "",
    "Factory (stable, every run): `_shared/standards.md`, `_shared/issues-report.md`",
    "Product (new each run): each stage's `output/`, plus the commits in the code worktrees",
    "",
    "Status is whatever exists: a stage is COMPLETE when its `output/` holds a real artifact — `.gitkeep` does not count.",
    "",
  ].join("\n");
}

const NO_PROMPT =
  "_No starting prompt was given. Write the goal, acceptance criteria and open questions here before starting the first stage._";
const READ_ISSUE =
  "_Read `.werkmeister/issue.md`, then write the goal, acceptance criteria and open questions here before starting the first stage._";

/** A brief nobody has touched: what renderBrief wrote with no issue and no prompt. */
export const PLACEHOLDER_BRIEF_RE =
  /^---\nsource: \.(?:sandbox|werkmeister)\/workspace\.yml \(starting_prompt\)\n---\n\n# Brief: [^\n]*\n\n_No starting prompt was given\. [^\n]*_\n$/; // name-check: ignore

function renderBrief(ctx: InitContext): string {
  const prompt = (ctx.inputs["starting_prompt"] ?? "").trim();
  const description = (ctx.inputs["description"] ?? "").trim();
  const copy = !!ctx.issue?.fetchedAt;
  const limits = isTrue(ctx.inputs["autonomous"]) ? ["## Run limits", "", RUN_LIMITS, ""] : [];
  if (!ctx.issue || (!copy && !description && !prompt)) {
    // Unchanged from before the issue copy existed; with no copy yet, still the placeholder --refresh-issue rebuilds.
    return [
      "---",
      "source: .werkmeister/workspace.yml (starting_prompt)",
      "---",
      "",
      `# Brief: ${ctx.task}`,
      "",
      prompt || NO_PROMPT,
      "",
      // Never on the placeholder: PLACEHOLDER_BRIEF_RE must still match it.
      ...(prompt ? limits : []),
    ].join("\n");
  }
  return [
    "---",
    `source: .werkmeister/workspace.yml (description, starting_prompt)${copy ? ", .werkmeister/issue.md" : ""}`,
    "---",
    "",
    `# Brief: ${ctx.task}`,
    "",
    renderIssueRef(ctx.issue),
    ...(description ? [description, ""] : []),
    ...(prompt ? [prompt, ""] : []),
    ...(copy && !description && !prompt ? [READ_ISSUE, ""] : []),
    ...limits,
  ].join("\n");
}

/** The regenerable files — what `check` diffs and `sync` rewrites. */
function render(ctx: InitContext): Record<string, string> {
  const stages = templateFor(ctx.inputs["work_type"] ?? "");
  const dirs = stageDirs(stages);
  const r = resolveStandards(ctx);
  const base = vars(ctx, stages);
  const files: Record<string, string> = {
    "_shared/standards.md": renderStandards(r),
    "_shared/issues-report.md": buildIssuesReportMd(
      ctx.workspaceName,
      issueIdOfMeta(ctx.meta),
      issueTracker({ project: ctx.inputs["project"], text: issueIdOfMeta(ctx.meta) }),
    ),
  };
  files["_shared/pr-rules.md"] = buildPrRulesMd(`stages/${prDir(stages)}/output/`, base.autonomous);
  stages.forEach((stage, i) => {
    files[`stages/${dirs[i]}/CONTEXT.md`] = renderContract(
      dirs[i],
      stage,
      { ...base, standards: standardsRef(stage.standards, r) },
      i === 0 && Boolean(issueIdOfMeta(ctx.meta)),
    );
  });
  return files;
}

/** Rebuild what `render` needs from the workspace on disk, for check/sync. */
function contextFromDisk(root: string): InitContext {
  const cfg = loadConfigFile(root, null);
  const inputs: Record<string, string> = {};
  for (const [, , field] of _INPUT_FIELDS) {
    const value = cfg[field];
    if (value !== undefined && value !== null) {
      inputs[field] = Array.isArray(value) ? value.map(String).join(",") : String(value);
    }
  }
  return {
    workspaceRoot: root,
    workspaceName: path.basename(root),
    repos: repoDirs(root).map((d): [string, string] => [path.basename(d), ""]),
    task: inputs["task"] ?? "",
    meta: { FEATURE: inputs["feature"] ?? "", SERVICES: inputs["services"] ?? "" },
    inputs,
    configOverride: null,
  };
}

function writeRel(root: string, rel: string, body: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

function drifted(root: string): Array<[string, string]> {
  const ctx = contextFromDisk(root);
  if (foreignStageDirs(root, templateFor(ctx.inputs["work_type"] ?? "")).length) return [];
  return Object.entries(render(ctx)).filter(([rel, body]) => {
    try {
      return fs.readFileSync(path.join(root, rel), "utf8") !== body;
    } catch {
      return true;
    }
  });
}

function init(ctx: InitContext): void {
  const root = ctx.workspaceRoot;
  const stages = templateFor(ctx.inputs["work_type"] ?? "");
  const foreign = foreignStageDirs(root, stages);
  if (foreign.length) {
    warn(
      `stages/ holds ${foreign.join(", ")}, which the current ${ctx.inputs["work_type"] || "feature"} template does not render — ` +
        "left CLAUDE.md, CONTEXT.md, _shared/ and stages/ as they are so the run keeps its pipeline. " +
        "To regenerate them from the current template, move stages/ aside and rerun.",
    );
  }
  const files: Record<string, string> = foreign.length
    ? {}
    : {
        "CLAUDE.md": renderClaudeMd(ctx, stages),
        "CONTEXT.md": renderPipeline(ctx, stages),
        ...render(ctx),
      };
  // The brief is the operator's once written — same rule as seedStartingHandoff —
  // except an untouched placeholder, rebuilt once there is an issue copy to brief from.
  const briefPath = path.join(root, "BRIEF.md");
  const existing = fs.existsSync(briefPath) ? fs.readFileSync(briefPath, "utf8") : null;
  if (existing === null || (ctx.issue?.fetchedAt && PLACEHOLDER_BRIEF_RE.test(existing))) {
    files["BRIEF.md"] = renderBrief(ctx);
  }
  for (const [rel, body] of Object.entries(files)) {
    writeRel(root, rel, body);
    success(`Wrote ${rel}`);
  }
  // Never write into an existing output/: it holds a run in progress.
  for (const dir of foreign.length ? [] : stageDirs(stages)) {
    const out = path.join(root, "stages", dir, "output");
    if (!fs.existsSync(out)) {
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, ".gitkeep"), "");
    }
  }
  // Switching from jit without --prune-context leaves its SessionStart/gate
  // hooks live until the next `up` — and SessionStart's `skills check ||
  // skills sync` would then hit icm's own sync and overwrite hand-edited
  // stage contracts. refresh() is idempotent and silent on a clean workspace.
  icm.refresh(root);
}

export const icm: ContextStrategy = {
  id: "icm",
  init,
  // The repair path for a workspace whose pre-strategy `up` installed the JIT
  // hooks. `_isManaged` is exact, so hand-added hooks survive. `werkmeister up`
  // runs this too, which is how existing workspaces get the PR guard, allow rules and model.
  refresh(root) {
    for (const command of removeWorkspaceHooks(root)) {
      info(`Removed JIT hook from .claude/settings.json: ${command}`);
    }
    const gateDir = path.join(dotDir(root), ".gate");
    if (fs.existsSync(gateDir)) {
      fs.rmSync(gateDir, { recursive: true, force: true });
      info(`Removed ${path.basename(dotDir(root))}/.gate/`);
    }
    writePrGuardHook(root);
    writeWorkspaceSettings(root);
  },
  check: (root) => drifted(root).map(([rel]) => rel),
  sync(root) {
    const wrote: string[] = [];
    for (const [rel, body] of drifted(root)) {
      writeRel(root, rel, body);
      info(`wrote ${rel}`);
      wrote.push(rel);
    }
    return { wrote };
  },
  // Re-injection is the route table the agent reads by itself; there is no hook.
  sessionContext: () => null,
  gate() {},
  ownedPaths: () => ["CLAUDE.md", "CONTEXT.md", "BRIEF.md", "_shared", "stages"],
  decisions: stageDecisions,
};
