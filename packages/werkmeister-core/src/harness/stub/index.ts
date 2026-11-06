/**
 * Proof that {@link HarnessAdapter} needs nothing from harness/claude (SW-383): a
 * session-less adapter that typechecks against the interface. Not dispatched:
 * neither `harness()` nor `harnessFor` returns it.
 */
import { WorkspaceError } from "../../errors.js";
import type { HarnessAdapter } from "../types.js";

const unsupported = (): never => {
  throw new WorkspaceError("Sessions are not supported on this harness.");
};

export const stubAdapter: HarnessAdapter = {
  id: "mcp",
  ask: async () => null,
  askJson: async () => null,
  askOrThrow: async () => unsupported(),
  sendTurn: async () => unsupported(),
  turnStatus: () => ({ state: "idle", startedAt: null, exitCode: null, error: null }),
  transcript: async () => unsupported(),
  sessionSource: async () => unsupported(),
  listSessions: async () => [],
  parseSession: () => [],
  agentSignal: async () => unsupported(),
  usage: async () => unsupported(),
  resumeCommand: () => unsupported(),
  reconcileCommand: () => unsupported(),
};
