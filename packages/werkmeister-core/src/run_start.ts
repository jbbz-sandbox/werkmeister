/**
 * The one copy of a workspace run's start prompt and run limits (SW-153): the pane's
 * ▶ Start work, `werkmeister start-args` (the next-wave skill) and an autonomous BRIEF.md.
 */

export const INTERACTIVE_LINE =
  "This is an interactive run: check with me at each stage's human check.";

export const GATE_LINE =
  "Run `werkmeister up` only when the gate needs it, and `werkmeister stop` this workspace's containers right after `werkmeister pr open` succeeds.";

/** What an autonomous run may not do, as markdown bullets. */
export const RUN_LIMITS = [
  "Tests never call the real Jira or GitHub APIs; the tracker is mocked. The only real issue update is the one `werkmeister pr open` makes for this ticket.",
  "Never read or write the real `~/.werkmeister`; tests use a temporary HOME.",
  "No `npm link`, `npm`/`pnpm install -g`, `npm publish`, `werkmeister proxy-reload`, and no other workspaces.",
  'Where the ticket says "to confirm", use it as written unless the code shows a reason to change it, and record each choice in the stage output for PR review.',
  GATE_LINE,
]
  .map((l) => `- ${l}`)
  .join("\n");

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
