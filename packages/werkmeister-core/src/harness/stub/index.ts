/**
 * Proof that {@link HarnessAdapter} needs nothing from harness/claude (SW-383): a
 * session-less adapter that typechecks against the interface. Not dispatched:
 * `harness()` never returns it. The Codex adapter (SW-189) starts from this shape.
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
  agentSignal: async () => unsupported(),
  usage: async () => unsupported(),
  resumeCommand: () => unsupported(),
  reconcileCommand: () => unsupported(),
};
