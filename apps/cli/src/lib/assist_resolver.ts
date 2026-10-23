/**
 * The Resolver behind `sandbox detect --assist`: one Claude Agent SDK session
 * over the repo, read-only, returning answers as structured output. Imported
 * lazily so the SDK loads only when the user opts in.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Answer, Question, Resolver } from "werkmeister-core/fragment_detect";
import { ANSWER_SCHEMA, assistPrompt } from "werkmeister-core/fragment_detect";

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

/** SW-73: the SDK is an optional dependency, so its absence is an expected state, not a crash. */
export class SdkMissingError extends Error {
  constructor() {
    super(
      "`detect --assist` needs the Claude Agent SDK, which is not installed. " +
        "Install it with: npm install -g @anthropic-ai/claude-agent-sdk",
    );
    this.name = "SdkMissingError";
  }
}

/** Only "not installed" becomes the hint; any other load failure (a broken install) keeps its own message. */
export function sdkLoadError(e: unknown): unknown {
  return (e as { code?: string } | null)?.code === "ERR_MODULE_NOT_FOUND"
    ? new SdkMissingError()
    : e;
}

export const claudeResolver: Resolver = async (
  repoRoot: string,
  questions: Question[],
): Promise<Answer[]> => {
  const { query } = await import("@anthropic-ai/claude-agent-sdk").catch((e) => {
    throw sdkLoadError(e);
  });
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
