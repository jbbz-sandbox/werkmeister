import { describe, it, expect } from "vitest";
import { withClaudeCodePreset } from "../../../server/sdk-options.js";

describe("withClaudeCodePreset", () => {
  it("always requests the claude_code preset", () => {
    // The SDK defaults to a minimal system prompt; without the preset the agent
    // loses Claude Code's tool instructions entirely.
    expect(withClaudeCodePreset({}).systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
  });

  it("moves appendSystemPrompt to systemPrompt.append", () => {
    // A top-level appendSystemPrompt is silently ignored by the SDK — project
    // prompts, user prompts, and memory injection all ride on this conversion.
    const out = withClaudeCodePreset({ appendSystemPrompt: "Project rules" });
    expect(out.systemPrompt.append).toBe("Project rules");
    expect(out.appendSystemPrompt).toBeUndefined();
  });

  it("omits append when there is nothing to append", () => {
    expect(withClaudeCodePreset({ appendSystemPrompt: "" }).systemPrompt.append).toBeUndefined();
  });

  it("passes other options through untouched", () => {
    const abortController = new AbortController();
    const out = withClaudeCodePreset({ cwd: "/tmp", maxTurns: 3, abortController });
    expect(out).toMatchObject({ cwd: "/tmp", maxTurns: 3, abortController });
  });
});
