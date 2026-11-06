/** The OpenCode adapter (SW-385): sessions over `opencode run` behind {@link HarnessAdapter}. */
import { WorkspaceError } from "../../errors.js";
import { turnStatus } from "../turn.js";
import type { HarnessAdapter } from "../types.js";
import { opencodeResumeCommand, sessionSignal, startTurn } from "./session.js";
import { listSessionsIn, sessionSourceIn, transcriptIn, usageForDir } from "./transcript.js";

const unsupported = (op: string): never => {
  throw new WorkspaceError(`${op} is not supported on the opencode harness.`);
};

export const opencodeAdapter: HarnessAdapter = {
  id: "opencode",
  // Only calls with no workspace use these, and those stay on claude (`harness()`).
  ask: async () => null,
  askJson: async () => null,
  askOrThrow: async () => unsupported("A headless question"),
  sendTurn: startTurn,
  turnStatus,
  transcript: transcriptIn,
  sessionSource: (dir, sessionId) => sessionSourceIn(dir, sessionId),
  // listSessionsIn keeps only sessions started in *dir*.
  sessionStartDir: async (dir, id) =>
    (await listSessionsIn(dir)).some((s) => s.sessionId === id) ? dir : null,
  listSessions: listSessionsIn,
  // No per-session file (sessionFile is null), so the live tailer never reads one.
  parseSession: () => [],
  agentSignal: sessionSignal,
  usage: usageForDir,
  resumeCommand: opencodeResumeCommand,
  reconcileCommand: () => unsupported("PR reconcile"),
};
