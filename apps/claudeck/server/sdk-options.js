/**
 * Bridges Claudeck's `appendSystemPrompt` accumulator to the Agent SDK's option shape.
 *
 * The SDK dropped top-level `appendSystemPrompt` and no longer defaults to Claude
 * Code's system prompt. It only honors an appended prompt via `systemPrompt.append`,
 * and only when `type: "preset"`. Setting `appendSystemPrompt` directly is silently
 * ignored — no error, the prompt just never reaches Claude.
 */
export function withClaudeCodePreset({ appendSystemPrompt, ...rest }) {
  return {
    ...rest,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      ...(appendSystemPrompt && { append: appendSystemPrompt }),
    },
  };
}
