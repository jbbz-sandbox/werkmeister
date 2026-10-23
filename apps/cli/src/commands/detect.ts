/**
 * sandbox detect [repo] [--dry-run] [--yes] [--assist | --no-assist]
 *
 * Generate <repo>/.sandbox/services.yaml from what the repo already says about
 * itself: package manifests, Dockerfiles, compose, Helm, k8s and kustomize.
 * Re-runs only add what is missing. Spec:
 * docs/superpowers/specs/2026-10-02-sandbox-detect-fragment-design.md at 66703fc.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { getReposRoot, servicesLocalYamlPath } from "werkmeister-core/config";
import {
  AllocationError,
  applyAnswers,
  collectQuestions,
  type FieldValue,
  type Plan,
  planFragment,
  portsPerSlot,
  type Resolver,
  renderFragment,
  stdoutRunner,
  validateFragment,
  writeFragment,
} from "werkmeister-core/fragment_detect";
import type { Runner } from "werkmeister-core/machine_setup";
import { RegistryError } from "werkmeister-core/registry_sync";

import { claudeResolver, SdkMissingError } from "../lib/assist_resolver.js";
import { Colors, info, success, warn } from "../lib/config.js";
import { confirm } from "../lib/wizard.js";

export interface DetectArgs {
  repo: string | null;
  dryRun: boolean;
  yes: boolean;
  /** true = --assist, false = --no-assist, undefined = ask when interactive. */
  assist: boolean | undefined;
}

export interface DetectDeps {
  runner: Runner;
  resolver: Resolver;
  interactive: boolean;
  reposRoot: string;
  localPath: string;
  portsPerSlot: number;
  cwd: string;
}

function mark(fv: FieldValue): string {
  return fv.confidence === "stated" ? "" : ` ${Colors.YELLOW}[${fv.confidence}]${Colors.RESET}`;
}

function printFields(fields: Record<string, FieldValue>): void {
  for (const [key, fv] of Object.entries(fields)) {
    console.log(
      `    ${key}: ${JSON.stringify(fv.value)}${mark(fv)}  ${Colors.DIM}${fv.source}${Colors.RESET}`,
    );
  }
}

function printPlan(plan: Plan): void {
  for (const s of plan.services) {
    console.log(
      `\n  ${Colors.BOLD}${s.name}${Colors.RESET} ${Colors.DIM}(${s.dir})${Colors.RESET}`,
    );
    printFields(s.fields);
  }
  for (const i of plan.infrastructure) {
    console.log(
      `\n  ${Colors.BOLD}${i.name}${Colors.RESET} ${Colors.DIM}(infrastructure)${Colors.RESET}`,
    );
    printFields(i.fields);
  }
  if (plan.setup) {
    console.log(
      `\n  ${Colors.BOLD}${plan.setup.name}${Colors.RESET} ${Colors.DIM}(setup service)${Colors.RESET}`,
    );
    printFields(plan.setup.fields);
  }
  const conflicts = plan.services.flatMap((s) => s.conflicts);
  if (conflicts.length) {
    console.log(`\n  ${Colors.BOLD}Conflicts${Colors.RESET}`);
    for (const c of conflicts) {
      const also = c.also.map((a) => `${JSON.stringify(a.value)} (${a.source})`).join(", ");
      console.log(
        `    ${c.service}.${c.key}: ${JSON.stringify(c.chosen.value)} (${c.chosen.source}) over ${also}`,
      );
    }
  }
  if (plan.skipped.length) {
    console.log(`\n  ${Colors.BOLD}Skipped${Colors.RESET}`);
    for (const s of plan.skipped) console.log(`    ${s.item}: ${s.reason}`);
  }
}

export async function runDetect(args: DetectArgs, deps: DetectDeps): Promise<number> {
  let root: string;
  if (args.repo) {
    root = path.resolve(deps.cwd, args.repo);
    if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
      warn(`${root} is not a directory — pass the repo path: sandbox detect <repo>`);
      return 2;
    }
  } else {
    const [rc, out] = deps.runner(["git", "-C", deps.cwd, "rev-parse", "--show-toplevel"]);
    if (rc !== 0) {
      warn("Not inside a git repo — pass the repo path: sandbox detect <repo>");
      return 2;
    }
    root = out.trim();
  }

  let plan: Plan;
  try {
    plan = planFragment(root, {
      reposRoot: deps.reposRoot,
      runner: deps.runner,
      localPath: deps.localPath,
      portsPerSlot: deps.portsPerSlot,
    });
  } catch (e) {
    if (e instanceof AllocationError || e instanceof RegistryError) {
      warn(e.message);
      return 1;
    }
    throw e;
  }

  console.log(`\n${Colors.BOLD}=== sandbox detect: ${plan.repo} ===${Colors.RESET}`);
  printPlan(plan);
  if (!plan.services.length && !plan.infrastructure.length) {
    warn(`No services found in ${root}.`);
    return 1;
  }

  const questions = collectQuestions(plan);
  if (questions.length && args.dryRun) {
    info(`${questions.length} field(s) are guesses; --assist would ask Claude about:`);
    for (const q of questions) console.log(`    ? ${q.id}: ${q.prompt}`);
  } else if (questions.length) {
    const ask =
      args.assist ??
      (await confirm(
        `  ${questions.length} field(s) are guesses — ask Claude to resolve them?`,
        false,
        deps.interactive,
      ));
    if (ask) {
      try {
        const result = applyAnswers(plan, await deps.resolver(plan.root, questions));
        plan = result.plan;
        for (const item of result.accepted) success(`Claude resolved ${item}`);
        for (const r of result.rejected) warn(`Ignored Claude's answer for ${r.item}: ${r.reason}`);
      } catch (e) {
        warn(
          e instanceof SdkMissingError
            ? `${e.message}\n  Keeping the deterministic guesses.`
            : `Claude pass failed (${e instanceof Error ? e.message : String(e)}) — keeping the deterministic guesses.`,
        );
      }
    }
  }

  const rendered = renderFragment(plan);
  for (const s of rendered.skipped) warn(s);
  if (!rendered.changed) {
    success(`${rendered.path} is up to date — nothing to add.`);
    return 0;
  }
  const errors = validateFragment(rendered, plan, deps.reposRoot);
  if (errors.length) {
    for (const e of errors) warn(e);
    warn("Not written: the generated fragment failed validation.");
    return 1;
  }
  console.log(
    plan.existing === null ? `\n${rendered.yaml}` : `\n  Would add: ${rendered.added.join(", ")}`,
  );

  if (args.dryRun) return 0;
  if (!args.yes && !deps.interactive) {
    info("Not a TTY — nothing written (pass --yes to write).");
    return 0;
  }
  if (!args.yes && !(await confirm(`  Write ${rendered.path}?`, false, deps.interactive))) {
    info("Nothing written.");
    return 0;
  }
  writeFragment(rendered);
  success(`Wrote ${rendered.path}`);
  if (rendered.added.some((a) => a.endsWith(".port_offset"))) {
    info(
      "port_offset is machine-wide — a collision on another machine shows up at `sandbox registry sync`.",
    );
  }
  info("next: sandbox registry sync");
  return 0;
}

export async function run(args: Record<string, unknown>): Promise<void> {
  const code = await runDetect(
    {
      repo: (args.repo as string | null) ?? null,
      dryRun: Boolean(args.dryRun),
      yes: Boolean(args.yes),
      assist: args.assist as boolean | undefined,
    },
    {
      runner: stdoutRunner,
      resolver: claudeResolver,
      interactive: Boolean(process.stdin.isTTY),
      reposRoot: getReposRoot(),
      localPath: servicesLocalYamlPath(),
      portsPerSlot: portsPerSlot(),
      cwd: process.cwd(),
    },
  );
  if (code) process.exit(code);
}
