/**
 * The one copy of a workspace run's start prompt and run limits (SW-153): the pane's
 * ▶ Start work, `werkmeister workspace prompt --args` (the next-wave skill) and an autonomous BRIEF.md.
 */

export const INTERACTIVE_LINE =
  "This is an interactive run: check with me at each stage's human check.";

export const GATE_LINE =
  "Run `werkmeister feature up` only when the gate needs it, and `werkmeister feature stop` this workspace's containers right after `werkmeister pr open` succeeds.";

/** What an autonomous run may not do, as markdown bullets. */
export const RUN_LIMITS = [
  "Tests never call the real Jira or GitHub APIs; the tracker is mocked. The only real issue update is the one `werkmeister pr open` makes for this ticket.",
  "Never read or write the real `~/.werkmeister`; tests use a temporary HOME. To see the machine config's shape run `werkmeister machine config`: it masks secrets such as `jira.api_token`.",
  "No `npm link`, `npm`/`pnpm install -g`, `npm publish`, `werkmeister infra proxy-reload`, and no other workspaces.",
  'Where the ticket says "to confirm", use it as written unless the code shows a reason to change it, and record each choice in the stage output for PR review.',
  GATE_LINE,
]
  .map((l) => `- ${l}`)
  .join("\n");

// SW-296: steps that write machine state, which RUN_LIMITS forbid; a ticket's fix often asks for one.
// Each note avoids starting with a backtick so a second pass doesn't take it for a step.
const MACHINE_STEPS: Array<[RegExp, string]> = [
  [
    /werkmeister registry sync/,
    "- Registry sync: the next `werkmeister registry sync` after merge picks up the change; the gate reads the branch's own `.werkmeister/services.yaml` fragment.",
  ],
  [
    /werkmeister infra proxy-reload/,
    "- Proxy reload: the next `werkmeister infra proxy-reload` after merge applies the change.",
  ],
  [
    /(?:npm|pnpm|yarn) link\b/,
    "- Linking the CLI: after merge, if at all; the run runs the built binary with `node`.",
  ],
  [
    /(?:(?:npm|pnpm|yarn) (?:install|i|add)\b[^`\n]*?(?: -g\b| --global\b)|yarn global add\b)/,
    "- Global installs: after merge, if at all; the run uses the workspace's own install.",
  ],
];

// A step is imperative: the command opens the sentence, or follows "run" that isn't quoting the ticket.
const stepRe = (cmd: RegExp) => new RegExp(`(?:^|(?<!["“'])\\brun )\`?${cmd.source}`, "i");
const STEP_RES = MACHINE_STEPS.map(([cmd]) => stepRe(cmd));
const LIST_PREFIX_RE = /^(\s*(?:[-*]|\d+\.) +(?:\[[ x]\] +)?)?(.*)$/;

/** Drop machine-writing run steps from a starting prompt and say they happen after merge instead. */
export function deferMachineSteps(prompt: string): string {
  const found = new Set<number>();
  const lines = prompt.split("\n").flatMap((line) => {
    const [, prefix = "", rest = ""] = LIST_PREFIX_RE.exec(line) ?? [];
    const kept = rest.split(/(?<=[.!?]) +/).filter((sentence) => {
      const hits = STEP_RES.flatMap((re, i) => (re.test(sentence) ? [i] : []));
      for (const i of hits) found.add(i);
      return !hits.length;
    });
    if (kept.join(" ") === rest) return [line];
    return kept.length ? [prefix + kept.join(" ")] : [];
  });
  if (!found.size) return prompt;
  return [
    lines.join("\n").trimEnd(),
    "",
    "## After merge",
    "",
    "Not steps for this run: the run limits forbid writing machine state under `~/.werkmeister` and global installs. These happen after the PR merges:",
    ...MACHINE_STEPS.filter((_, i) => found.has(i)).map(([, note]) => note),
  ].join("\n");
}

export function startPrompt(autonomous: boolean): string {
  return autonomous
    ? `start the run\n\nRun limits:\n${RUN_LIMITS}`
    : `start the run\n\n${INTERACTIVE_LINE}\n${GATE_LINE}`;
}

/** start_session's arguments besides initiation, cwd, use_worktree and context. */
export interface StartArgs {
  title: string;
  model?: string;
  prompt: string;
  background: string;
}

export function buildStartArgs(w: {
  name: string;
  issueId: string | null;
  task: string | null;
  model: string | null;
  autonomous: boolean;
}): StartArgs {
  // start_session takes a title under 60 characters: cut at the last word that fits beside the "…" (SW-157).
  const full = [w.issueId, w.task].filter(Boolean).join(" ") || w.name;
  const space = full.lastIndexOf(" ", 58);
  // ponytail: a space before 40 means one huge "word" (a URL, a path); cut that mid-word rather than keep only the key.
  const title = full.length < 60 ? full : `${full.slice(0, space > 40 ? space : 58).trimEnd()}…`;
  return {
    title,
    ...(w.model ? { model: w.model } : {}),
    prompt: startPrompt(w.autonomous),
    // The run reads its own CLAUDE.md and issue copy; this only points at them. The fixed text keeps it over
    // start_session's 80-character minimum for a fresh context.
    background: `Workspace \`${w.name}\`${w.issueId ? ` for ${w.issueId}` : ""}. Read \`CLAUDE.md\`, then \`.werkmeister/issue.md\`; its routing table picks the stage.`,
  };
}
