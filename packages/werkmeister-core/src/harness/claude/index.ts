/** The Claude Code adapter: today's behaviour behind {@link HarnessAdapter} (SW-187). */
import { turnStatus } from "../turn.js";
import type { HarnessAdapter } from "../types.js";
import { askClaude, askClaudeJson, askClaudeStrict, reconcileCommand } from "./cli.js";
// biome-ignore lint/suspicious/noImportCycles: jira→harness→…→issue_tracker (SW-188); SW-411
import { claudeResumeCommand, sessionSignal, startTurn } from "./session.js";
import {
  listSessionsIn,
  parseSessionLines,
  sessionSourceIn,
  sessionStartDir,
  transcriptIn,
} from "./transcript.js";
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
  sessionStartDir: (_dir, sessionId) => sessionStartDir(sessionId),
  listSessions: listSessionsIn,
  parseSession: parseSessionLines,
  agentSignal: sessionSignal,
  usage: usageForDir,
  resumeCommand: claudeResumeCommand,
  reconcileCommand,
};
