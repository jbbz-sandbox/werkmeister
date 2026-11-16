/**
 * The optional Claude pass, core side (spec §6): which questions to ask, and
 * the rules an answer must pass before it lands in the plan. The CLI supplies
 * the Resolver that actually talks to Claude; core never does.
 */
import { parse as parseYaml } from "yaml";

import type { Plan } from "./plan.js";
import { resolveService } from "./precedence.js";
import type { FieldValue } from "./types.js";

export type QuestionKind =
  | "command"
  | "health_endpoint"
  | "environment"
  | "secrets"
  | "depends_on"
  | "conflict"
  | "unmatched";

/**
 * One thing the scan could not settle, put as a question to whoever reads the repo
 * (usually Claude). {@link collectQuestions} lists them; send back an {@link Answer} per
 * question you can answer.
 *
 * @example
 * ```ts
 * import { collectQuestions, planFragment, type Question } from "werkmeister-core/sdk";
 *
 * const plan = planFragment("/home/me/repos/my-app", {
 *   reposRoot: "/home/me/repos",
 *   runner: () => [1, ""],
 *   localPath: "/home/me/.werkmeister/services.local.yaml",
 *   portsPerSlot: 20,
 * });
 * const questions: Question[] = collectQuestions(plan);
 * for (const q of questions) console.log(`${q.id} (${q.kind}): ${q.prompt}`, q.choices ?? "");
 * ```
 */
export interface Question {
  /** `<service>.<key>`, or `unmatched.<name>`. An answer names it as its `item`. */
  id: string;
  /**
   * What is asked, which sets the rule {@link applyAnswers} checks the answer against:
   * `command`, `health_endpoint`, `environment`, `secrets`, `depends_on`, `conflict` or `unmatched`.
   */
  kind: QuestionKind;
  /** The service asked about, or null for an unmatched finding. */
  service: string | null;
  /** The question in plain English. */
  prompt: string;
  /** What the scan already knows (dir, current guess, files), as a starting point for the answer. */
  facts: Record<string, unknown>;
  /** When set, the answer must be one of these (a subset, for list questions). */
  choices?: unknown[];
}

/**
 * An answer to one {@link Question}, usually from Claude reading the repo. Pass a list
 * of them to {@link applyAnswers}.
 *
 * @example
 * ```ts
 * import type { Answer } from "werkmeister-core/sdk";
 *
 * const answer: Answer = {
 *   item: "api.health_endpoint",
 *   value: "/healthz",
 *   reason: "src/server.ts registers GET /healthz",
 *   files_read: ["src/server.ts"],
 * };
 * ```
 */
export interface Answer {
  /** The `id` of the question answered. */
  item: string;
  /** The proposed value. Checked against the question's kind and choices before use. */
  value: unknown;
  /** One sentence naming the evidence; written into the fragment as a comment. */
  reason: string;
  /** Repo files that support the answer. */
  files_read: string[];
}

export type Resolver = (repoRoot: string, questions: Question[]) => Promise<Answer[]>;

/**
 * What {@link applyAnswers} made of a list of answers: the updated plan, and which
 * answers it took or refused.
 *
 * @example
 * ```ts
 * import { type Answer, type ApplyResult, applyAnswers, planFragment } from "werkmeister-core/sdk";
 *
 * const plan = planFragment("/home/me/repos/my-app", {
 *   reposRoot: "/home/me/repos",
 *   runner: () => [1, ""],
 *   localPath: "/home/me/.werkmeister/services.local.yaml",
 *   portsPerSlot: 20,
 * });
 * const answers: Answer[] = [
 *   {
 *     item: "api.command",
 *     value: "npm run dev",
 *     reason: "package.json dev script",
 *     files_read: ["package.json"],
 *   },
 * ];
 * const result: ApplyResult = applyAnswers(plan, answers);
 * for (const r of result.rejected) console.warn(`${r.item}: ${r.reason}`);
 * ```
 */
export interface ApplyResult {
  /** A copy of the plan with the accepted answers applied; the input plan is unchanged. */
  plan: Plan;
  /** Question ids whose answers landed in the plan. */
  accepted: string[];
  /** Answers left out, each with the rule they broke. */
  rejected: {
    /** The answer's `item`, as sent. */
    item: string;
    /** Why it was refused. */
    reason: string;
  }[];
}

export const ANSWER_SCHEMA = {
  type: "object",
  required: ["answers"],
  additionalProperties: false,
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        required: ["item", "value", "reason", "files_read"],
        additionalProperties: false,
        properties: {
          item: { type: "string" },
          value: {},
          reason: { type: "string" },
          files_read: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

/**
 * Lists what is worth asking about a plan: guessed commands and health endpoints,
 * `.env.example` keys, `depends_on`, values two files disagree on, and findings that
 * matched no service. Keys the existing fragment already sets are not asked. Runs
 * in-process; it only builds the questions, and getting them answered (for example by
 * Claude) is up to you.
 *
 * @param plan - A plan from {@link planFragment}.
 * @returns One {@link Question} per open item, possibly none.
 * @throws `Error` from the YAML parser when `plan.existing` doesn't parse.
 *
 * @example
 * ```ts
 * import { collectQuestions, planFragment } from "werkmeister-core/sdk";
 *
 * const plan = planFragment("/home/me/repos/my-app", {
 *   reposRoot: "/home/me/repos",
 *   runner: () => [1, ""],
 *   localPath: "/home/me/.werkmeister/services.local.yaml",
 *   portsPerSlot: 20,
 * });
 * const questions = collectQuestions(plan);
 * console.log(JSON.stringify(questions, null, 2));
 * ```
 */
export function collectQuestions(plan: Plan): Question[] {
  const existing = plan.existing ? (parseYaml(plan.existing) ?? {}) : {};
  const inFile = (svc: string, key: string) => existing?.services?.[svc]?.[key] !== undefined;
  const names = plan.services.map((s) => s.name);
  const qs: Question[] = [];
  for (const s of plan.services) {
    const f = s.fields;
    const ask = (key: string, q: Omit<Question, "id" | "service">) => {
      if (!inFile(s.name, key)) qs.push({ id: `${s.name}.${key}`, service: s.name, ...q });
    };
    if (f.command?.confidence === "guessed") {
      ask("command", {
        kind: "command",
        prompt: `What command starts ${s.name} for local development? It runs with the repo root mounted at /app as the working directory.`,
        facts: { dir: s.dir, guess: f.command.value, why: f.command.source },
      });
    }
    if (f.health_endpoint?.confidence === "guessed") {
      ask("health_endpoint", {
        kind: "health_endpoint",
        prompt: `Which HTTP path answers 200 when ${s.name} is healthy? Answer "" if it has none.`,
        facts: { dir: s.dir, port: f.internal_port?.value },
      });
    }
    const example = plan.envExample[s.name] ?? [];
    if (example.length) {
      ask("environment", {
        kind: "environment",
        prompt: `Which environment variables does ${s.name} need for local development, with development values? Leave secrets out.`,
        facts: { dir: s.dir, env_example_keys: example, current: f.environment?.value ?? {} },
      });
      if (!f.secrets) {
        ask("secrets", {
          kind: "secrets",
          prompt: `Which of these keys must be set for ${s.name} to start at all? A declared secret that is missing stops \`werkmeister feature up\`.`,
          facts: { dir: s.dir },
          choices: example,
        });
      }
    }
    const others = names.filter((n) => n !== s.name);
    if (others.length && !f.depends_on) {
      ask("depends_on", {
        kind: "depends_on",
        prompt: `Which of these services must be running before ${s.name} starts (it calls them at startup)? Answer [] for none.`,
        facts: { dir: s.dir },
        choices: others,
      });
    }
    for (const c of s.conflicts) {
      ask(c.key, {
        kind: "conflict",
        prompt: `Sources disagree on ${s.name}.${c.key}. Which value is right for local development?`,
        facts: {
          sources: [c.chosen, ...c.also].map((x) => ({ value: x.value, source: x.source })),
        },
        choices: [c.chosen.value, ...c.also.map((a) => a.value)],
      });
    }
  }
  for (const name of [...new Set(plan.unmatched.map((u) => u.name))]) {
    const found = plan.unmatched.filter((u) => u.name === name);
    const files = found.map((u) => u.file).join(", ");
    qs.push({
      id: `unmatched.${name}`,
      kind: "unmatched",
      service: null,
      prompt: `${files} define${found.length > 1 ? "" : "s"} ${name}, but no source directory matched it. Which service is it? Answer null if its code lives in another repo.`,
      facts: { files: found.map((u) => u.file), image: found.find((u) => u.image)?.image ?? null },
      choices: [...names, null],
    });
  }
  return qs;
}

const isStringMap = (v: unknown): v is Record<string, string> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "string");
const subsetOf = (v: unknown, choices: unknown[]): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string" && choices.includes(x));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function applyUnmatched(next: Plan, id: string, value: unknown, reason: string): string | null {
  if (value === null) return null;
  const target =
    typeof value === "string" ? next.services.find((s) => s.name === value) : undefined;
  const found = next.unmatched.filter((u) => `unmatched.${u.name}` === id);
  if (!target || !found.length) return "expected one of this repo's services, or null";
  const fresh = resolveService({
    name: target.name,
    dir: target.dir,
    findings: [...target.findings, ...found],
  });
  for (const [k, fv] of Object.entries(fresh.fields)) {
    if (!(k in target.fields))
      target.fields[k] = {
        ...fv,
        confidence: "inferred",
        source: `${fv.source}; matched by Claude: ${reason}`,
      };
  }
  target.findings.push(...found);
  next.unmatched = next.unmatched.filter((u) => !found.includes(u));
  next.skipped = next.skipped.filter(
    (s) => !found.some((f) => s.item === f.file && s.reason.includes(` ${f.name} — `)),
  );
  return null;
}

/**
 * Checks each answer against the question it names and applies the ones that pass, as
 * `inferred` fields. An answer to an unknown question, a second answer to the same
 * question, or a value that breaks the question's rule is rejected with the reason.
 * Runs in-process; the input plan is not changed.
 *
 * @param plan - The plan the questions came from (see {@link collectQuestions}).
 * @param answers - The answers, each naming its question's `id` as `item`.
 * @returns An {@link ApplyResult}: the updated copy of the plan, and the accepted and rejected items.
 * @throws `Error` from the YAML parser when `plan.existing` doesn't parse.
 *
 * @example
 * ```ts
 * import { applyAnswers, planFragment, renderFragment } from "werkmeister-core/sdk";
 *
 * const plan = planFragment("/home/me/repos/my-app", {
 *   reposRoot: "/home/me/repos",
 *   runner: () => [1, ""],
 *   localPath: "/home/me/.werkmeister/services.local.yaml",
 *   portsPerSlot: 20,
 * });
 * const { plan: next, accepted } = applyAnswers(plan, [
 *   {
 *     item: "api.health_endpoint",
 *     value: "/healthz",
 *     reason: "src/server.ts registers GET /healthz",
 *     files_read: ["src/server.ts"],
 *   },
 * ]);
 * console.log(accepted, renderFragment(next).yaml);
 * ```
 */
export function applyAnswers(plan: Plan, answers: Answer[]): ApplyResult {
  const next: Plan = structuredClone(plan);
  const questions = new Map(collectQuestions(plan).map((q) => [q.id, q]));
  const accepted: string[] = [];
  const rejected: { item: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const a of answers) {
    const q = questions.get(a.item);
    if (!q) {
      rejected.push({ item: a.item, reason: "not one of the questions asked" });
      continue;
    }
    if (seen.has(a.item)) {
      rejected.push({ item: a.item, reason: "answered twice; kept the first" });
      continue;
    }
    seen.add(a.item);
    const reason = a.reason?.trim() || "no reason given";
    const inferred = (value: unknown): FieldValue => ({
      value,
      source: reason,
      confidence: "inferred",
    });
    const svc = q.service ? next.services.find((s) => s.name === q.service) : undefined;
    let problem: string | null = null;

    if (q.kind === "unmatched") problem = applyUnmatched(next, q.id, a.value, reason);
    else if (!svc) problem = `no service named ${q.service} in this plan`;
    else
      switch (q.kind) {
        case "command":
          if (typeof a.value === "string" && a.value.trim())
            svc.fields.command = inferred(a.value.trim());
          else problem = "expected a non-empty command string";
          break;
        case "health_endpoint":
          if (typeof a.value === "string" && (a.value === "" || a.value.startsWith("/")))
            svc.fields.health_endpoint = inferred(a.value);
          else problem = 'expected "" or a path starting with /';
          break;
        case "environment": {
          if (!isStringMap(a.value)) {
            problem = "expected an object of string values";
            break;
          }
          const current = (svc.fields.environment?.value ?? {}) as Record<string, string>;
          const merged = Object.fromEntries(
            Object.entries({ ...a.value, ...current }).sort(([x], [y]) => x.localeCompare(y)),
          );
          const before = svc.fields.environment?.source;
          svc.fields.environment = inferred(merged);
          if (before) svc.fields.environment.source = `${before}; Claude added keys: ${reason}`;
          break;
        }
        case "secrets":
          if (subsetOf(a.value, q.choices ?? [])) {
            if (a.value.length) svc.fields.secrets = inferred([...a.value].sort());
          } else problem = "expected a list of keys from .env.example";
          break;
        case "depends_on":
          if (subsetOf(a.value, q.choices ?? [])) {
            if (a.value.length) svc.fields.depends_on = inferred([...a.value].sort());
          } else problem = "expected a list of this repo's other services";
          break;
        case "conflict": {
          const choice = (q.choices ?? []).find((c) => same(c, a.value));
          if (choice === undefined) {
            problem = "not one of the conflicting values";
            break;
          }
          const key = q.id.slice(svc.name.length + 1);
          svc.fields[key] = inferred(choice);
          svc.conflicts = svc.conflicts.filter((c) => c.key !== key);
          break;
        }
      }
    if (problem) rejected.push({ item: a.item, reason: problem });
    else accepted.push(a.item);
  }
  return { plan: next, accepted, rejected };
}

export function assistPrompt(questions: Question[]): string {
  return [
    "You are helping generate a werkmeister service-registry fragment for the repository in your working directory.",
    "A deterministic scan already filled every field it could read from package manifests, Dockerfiles, compose files and Kubernetes manifests.",
    "The questions below are the fields it had to guess. Answer each one from the repository's own files, using Read, Glob and Grep.",
    "",
    "Rules:",
    "- Answer only the questions listed, using each question's `id` as `item`.",
    "- When a question has `choices`, `value` must be one of them; for list questions, a subset of them.",
    "- Leave a question out if the repository doesn't settle it. A missing answer keeps the scan's guess; a wrong answer is worse than none.",
    "- Never put credentials, tokens or keys in environment values. Those belong in `secrets`.",
    '- `reason` is one short sentence naming the evidence, e.g. "apps/api/src/main.ts registers GET /healthz". It is written into the file as a comment.',
    "- `files_read` lists the files that support the answer.",
    "",
    "Questions (JSON):",
    JSON.stringify(questions, null, 2),
  ].join("\n");
}
