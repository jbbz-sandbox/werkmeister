/** The Claude Code adapter: today's behaviour behind {@link HarnessAdapter} (SW-187). */
import type { HarnessAdapter } from "../types.js";
import { askClaude, askClaudeJson, askClaudeStrict, reconcileCommand } from "./cli.js";
import { claudeResumeCommand, sessionSignal, startTurn, turnStatus } from "./session.js";
import { listSessionsIn, sessionSourceIn, transcriptIn } from "./transcript.js";
import { usageForDir } from "./usage.js";

export const claudeAdapter: HarnessAdapter = {
  id: "claude",
  ask: askClaude,
  askJson: askClaudeJson,
  askOrThrow: askClaudeStrict,
  sendTurn: startTurn,
  turnStatus,
  transcript: transcriptIn,
  sessionSource: sessionSourceIn,
  listSessions: listSessionsIn,
  agentSignal: sessionSignal,
  usage: usageForDir,
  resumeCommand: claudeResumeCommand,
  reconcileCommand,
};
