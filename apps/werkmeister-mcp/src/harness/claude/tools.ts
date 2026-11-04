/**
 * The Claude Code session tools (SW-187): read, drive and reopen a workspace's
 * Claude session. Registered by registerWorkspaceTools at the same point as
 * before, so `tools/list` order is unchanged.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  getClaudeTranscript,
  getClaudeTurnStatus,
  listSessions,
  relayPickedUp,
  resumeClaudeInTerminal,
  sendToClaudeSession,
} from "werkmeister-core";
import { z } from "zod";
import { launcherOf } from "../../lib/feature.js";
import { headersOf } from "../../tools.js";

/** The workspace_tools.ts helpers these tools share with the rest. */
export interface SessionToolHelpers {
  fail: (e: unknown) => CallToolResult;
  sessionArg: { workspace: z.ZodOptional<z.ZodString> };
  sessionKey: (explicit: string | undefined, extra: unknown) => string;
}

export function registerClaudeTools(
  server: McpServer,
  { fail, sessionArg, sessionKey }: SessionToolHelpers,
): void {
  // --- Tool: newest Claude Code transcript for a workspace ------------------
  // Reads ~/.claude/projects/<encoded-ws-path>/*.jsonl; used by the workspaces
  // table's per-workspace chat panel to show recent history.
  server.registerTool(
    "claude-transcript",
    {
      title: "Claude Code Session Transcript",
      description:
        "Return the newest Claude Code session for a workspace: session ID plus the last N " +
        "user/assistant messages, with tool calls included as compact `tool` activity rows. " +
        "sessionId is null when the workspace has no sessions yet. Pass the `workspace` " +
        "from `list-workspaces`.",
      inputSchema: {
        ...sessionArg,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max messages to return (default 20)."),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Read this specific session instead of the newest (from `sessions[]`); stale/unknown ids fall back to newest.",
          ),
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({
        sessionId: z.string().nullable(),
        workspacePath: z.string(),
        messages: z.array(
          z.object({
            role: z.enum(["user", "assistant", "tool"]),
            text: z.string(),
            timestamp: z.string().nullable(),
          }),
        ),
        sessionCount: z.number(),
        updatedAt: z.string().nullable(),
        sessions: z
          .array(
            z.object({
              sessionId: z.string(),
              title: z.string(),
              updatedAt: z.string(),
              isNewest: z.boolean(),
            }),
          )
          .describe(
            "All sessions for this workspace, newest first — drives the chat panel's session picker.",
          ),
      }),
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const name = sessionKey(args.workspace, extra);
        const [result, sessions] = await Promise.all([
          getClaudeTranscript(name, args.limit ?? 20, args.sessionId),
          listSessions(name),
        ]);
        const text = result.sessionId
          ? `Session ${result.sessionId} (${result.messages.length} recent messages, ${result.sessionCount} session(s) total).`
          : `No Claude Code sessions found for ${name}.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { ...result, sessions } as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Tool: did a relayed message run in the workspace's session? ----------
  // A SendMessage success and an idle notice do not prove the turn ran: a
  // UserPromptSubmit hook can drop the prompt and the session is idle at once
  // (SW-348). The check-in skill's step 4 calls this after the idle notice.
  server.registerTool(
    "relay-check",
    {
      title: "Relay Check",
      description:
        "Whether a message relayed to a workspace's live Claude Code session was picked up: " +
        "a user turn after `sentAt` holding `text` in the newest transcript. When it was not, " +
        "`hint` is the line to report instead of a success: `not picked up: type <text> in <session>`.",
      inputSchema: {
        ...sessionArg,
        sentAt: z.string().describe("ISO time the message was sent (just before SendMessage)."),
        text: z.string().describe("The message text as sent, or a distinctive part of it."),
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({
        pickedUp: z.boolean(),
        sessionId: z.string().nullable(),
        hint: z.string(),
      }),
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const name = sessionKey(args.workspace, extra);
        const { sessionId, messages } = await getClaudeTranscript(name, 200);
        const pickedUp = relayPickedUp(messages, { sentAt: args.sentAt, text: args.text });
        const hint = pickedUp
          ? `picked up: ${name} ran the relayed message`
          : `not picked up: type ${JSON.stringify(args.text)} in ${name}`;
        return {
          content: [{ type: "text", text: hint }],
          structuredContent: { pickedUp, sessionId, hint },
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Tool: send one message to a workspace's Claude Code session -----------
  // Headless `claude -p --resume <id>` in the workspace dir — continues the same
  // session on disk. Quick follow-ups only; long agentic turns should use
  // `claude-resume` (real terminal) instead.
  server.registerTool(
    "claude-send",
    {
      title: "Send to Claude Code Session",
      description:
        "Send one message to a workspace's newest Claude Code session (headless " +
        "`claude -p --resume`), continuing the same session on disk (starts a new session " +
        "if none exists). Fire-and-forget: returns as soon as the turn is started — poll " +
        "`claude-transcript` to watch the reply appear. For a fully interactive session " +
        "use `claude-resume`.",
      inputSchema: {
        ...sessionArg,
        message: z.string().describe("The message to send."),
        sessionId: z
          .string()
          .optional()
          .describe(
            "Resume this specific session instead of the newest; `--resume` bumps it back to newest afterwards.",
          ),
      },
      annotations: { readOnlyHint: false },
      outputSchema: z.object({
        sessionId: z.string().nullable(),
        started: z.boolean(),
        startedNew: z.boolean(),
      }),
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const name = sessionKey(args.workspace, extra);
        const result = await sendToClaudeSession(name, args.message, args.sessionId);
        const text = result.startedNew
          ? "Started a new session; poll claude-transcript for the reply."
          : `Turn started on session ${result.sessionId}; poll claude-transcript for the reply.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Tool: state of the most recent claude-send turn -----------------------
  // Lets the chat panel show the typing indicator exactly while the turn runs
  // and report real failures, instead of guessing from transcript quiescence.
  server.registerTool(
    "claude-turn-status",
    {
      title: "Claude Turn Status",
      description:
        "Report the state of the most recent `claude-send` turn for a workspace: running, " +
        "done, failed (with error detail), or idle when no turn was started by this server " +
        "process (fall back to polling `claude-transcript`).",
      inputSchema: {
        ...sessionArg,
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({
        state: z.enum(["idle", "running", "done", "failed"]),
        startedAt: z.string().nullable(),
        exitCode: z.number().nullable(),
        error: z.string().nullable(),
      }),
      _meta: { ui: { visibility: ["app"] } }, // app-only: hidden from the model
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const name = sessionKey(args.workspace, extra);
        const result = await getClaudeTurnStatus(name);
        return {
          content: [
            {
              type: "text",
              text: `Turn state for ${name}: ${result.state}${result.error ? ` (${result.error})` : ""}`,
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  // --- Tool: resume a workspace's Claude session in Terminal -----------------
  server.registerTool(
    "claude-resume",
    {
      title: "Resume Claude Session in Terminal",
      description:
        "Open a terminal in the workspace directory resuming its newest Claude " +
        "Code session (`claude --resume <id>`), fully interactive. Starts a fresh session " +
        "when the workspace has none, or when `new` is set. A VS Code integrated terminal " +
        "when the calling session runs in VS Code (`TERM_PROGRAM=vscode`, `CLAUDE_CODE_ENTRYPOINT=claude-vscode`, " +
        "or `WERKMEISTER_LAUNCHER=vscode`), " +
        "else a macOS Terminal window; the reply says which.",
      inputSchema: {
        ...sessionArg,
        sessionId: z
          .string()
          .optional()
          .describe("Resume this specific session instead of the newest."),
        new: z
          .boolean()
          .optional()
          .describe("Start a fresh session instead of resuming one; ignores `sessionId`."),
        prompt: z
          .string()
          .optional()
          .describe("Text sent as the first message of the opened session."),
      },
      annotations: { readOnlyHint: false },
      outputSchema: z.object({
        path: z.string(),
        sessionId: z.string().nullable(),
        launcher: z.enum(["terminal", "vscode"]),
      }),
    },
    async (args, extra): Promise<CallToolResult> => {
      try {
        const name = sessionKey(args.workspace, extra);
        const result = await resumeClaudeInTerminal(
          name,
          args.sessionId,
          args.new === true,
          args.prompt,
          launcherOf(headersOf(extra)),
        );
        const where = result.launcher === "vscode" ? "a VS Code terminal" : "Terminal";
        const text = result.sessionId
          ? `Opened ${where} resuming session ${result.sessionId} in ${result.path}.`
          : `Opened ${where} with a new Claude session in ${result.path}.`;
        return {
          content: [{ type: "text", text }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return fail(e);
      }
    },
  );
}
