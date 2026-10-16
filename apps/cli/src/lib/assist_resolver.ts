/**
 * The Resolver behind `sandbox detect --assist`: one Claude Agent SDK session
 * over the repo, read-only, returning answers as structured output. Imported
 * lazily so the SDK loads only when the user opts in.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Answer, Question, Resolver } from "sandbox-core/fragment_detect";
import { ANSWER_SCHEMA, assistPrompt } from "sandbox-core/fragment_detect";

/**
 * Isolated from the scanned repo's and the user's `.claude/` settings (their hooks,
 * plugins, MCP servers and allow-lists), so Read, Glob and Grep are the only tools.
 * Reads are pre-approved under the repo only (`./**` is relative to cwd); Read
 * rules also govern Glob and Grep, and `dontAsk` denies everything else.
 */
export function assistOptions(repoRoot: string): Options {
  return {
    cwd: repoRoot,
    model: "claude-opus-5-5",
    tools: ["Read", "Glob", "Grep"],
    allowedTools: ["Read(./**)"],
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    plugins: [],
    maxTurns: 40,
    outputFormat: { type: "json_schema", schema: ANSWER_SCHEMA },
  };
}

export const claudeResolver: Resolver = async (
  repoRoot: string,
  questions: Question[],
): Promise<Answer[]> => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  for await (const message of query({
    prompt: assistPrompt(questions),
    options: assistOptions(repoRoot),
  })) {
    if (message.type !== "result") continue;
    if (message.subtype === "success" && message.structured_output) {
      return (message.structured_output as { answers: Answer[] }).answers;
    }
    throw new Error(`Claude returned no answers (${message.subtype})`);
  }
  throw new Error("the Claude session ended without a result");
};
