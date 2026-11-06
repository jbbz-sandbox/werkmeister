/** The Codex session adapter (SW-384), beside the layout in ./index.js so layout.ts's imports stay as they were. */
import { turnStatus } from "../turn.js";
import type { HarnessAdapter } from "../types.js";
import { askCodex, askCodexJson, askCodexStrict, codexReconcileCommand } from "./cli.js";
import { codexResumeCommand, codexSignal, codexStartTurn } from "./session.js";
import {
  codexListSessionsIn,
  codexSessionSourceIn,
  codexSessionStartDir,
  codexTranscriptIn,
  parseCodexLines,
} from "./transcript.js";
import { codexUsageForDir } from "./usage.js";

export const codexAdapter: HarnessAdapter = {
  id: "codex",
  ask: askCodex,
  askJson: askCodexJson,
  askOrThrow: askCodexStrict,
  sendTurn: codexStartTurn,
  turnStatus,
  transcript: codexTranscriptIn,
  sessionSource: codexSessionSourceIn,
  sessionStartDir: codexSessionStartDir,
  listSessions: codexListSessionsIn,
  parseSession: parseCodexLines,
  agentSignal: codexSignal,
  usage: codexUsageForDir,
  resumeCommand: codexResumeCommand,
  reconcileCommand: codexReconcileCommand,
};
