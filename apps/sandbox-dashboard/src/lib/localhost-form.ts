/**
 * Localhost browser-form fallback for MCP clients that don't render `ui://`
 * MCP App resources (Claude Code CLI, the VS Code extension).
 *
 * The Desktop flow renders the RJSF form inline via ext-apps. Hosts without the
 * `io.modelcontextprotocol/ui` capability can't do that — so for them the
 * `workspace` tool spins up a tiny localhost HTTP server, serves the bundled
 * create-form page (`dist/form.html`, the same src/create-form.ts the browser
 * dashboard's "New workspace" tab renders — fully self-contained, no CDN),
 * opens the user's browser, and blocks until they submit or cancel. It's the
 * localhost-callback (OAuth loopback) pattern: server + browser are both on the
 * user's machine, so collecting input never depends on the MCP client
 * rendering anything.
 *
 * One form definition, one create path — this module only handles *collecting*
 * the values. The page talks the dashboard's `POST /api/tool` bridge protocol,
 * but this throwaway server dispatches only what the form calls:
 * `workspace-form-schema` (the bundle), `refine-prompt`, and the intercepted
 * `create-workspace` / `cancel-form`, which resolve the promise instead of
 * creating anything — the caller (server.ts or form-cli.ts) feeds the result
 * into the shared `createWorkspace()`.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import express from "express";
import type { FormSchemaBundle } from "sandbox-core";
import { fetchIssueFormData, getFormSchema, refinePrompt, WorkspaceError } from "sandbox-core";
import { issueTracker } from "sandbox-core/issue_tracker";

// Works both from source (src/lib/localhost-form.ts via tsx) and compiled
// (dist/lib/localhost-form.js) — the built page always lives at dist/form.html.
const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "..", "..", "dist")
  : path.join(import.meta.dirname, "..");

/**
 * `getFormSchema()` with the configured tracker's label on `issue_id`'s
 * `ui:options.trackerLabel`, so the form's "Fetch from <tracker>" button names
 * the tracker without the browser bundle knowing it. Every surface that hands
 * the form a bundle (server.ts, form-cli.ts) builds it here.
 */
export async function getFormBundle(): Promise<FormSchemaBundle> {
  const bundle = await getFormSchema();
  const ui = (bundle.uiSchema.issue_id ?? {}) as Record<string, unknown>;
  const opts = (ui["ui:options"] ?? {}) as Record<string, unknown>;
  bundle.uiSchema.issue_id = {
    ...ui,
    "ui:options": { ...opts, trackerLabel: issueTracker().label },
  };
  return bundle;
}

export type LocalhostFormStatus = "submitted" | "cancelled" | "timeout";

export interface LocalhostFormResult {
  status: LocalhostFormStatus;
  /** Present only when `status === "submitted"`. */
  formData?: Record<string, unknown>;
  /** The form's "Open in VS Code" checkbox, when submitted. */
  open?: boolean;
}

/** Open the user's default browser at `url`, detached and best-effort. */
export function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // Non-fatal: the URL is also logged to stderr for the user to open manually.
  }
}

/** localhost / 127.0.0.1 / ::1, with any `:port` and IPv6 brackets stripped. */
function isLocalHost(h?: string): boolean {
  if (!h) return false;
  const host = h.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/**
 * Trust boundary shared with lib/browser-ui.ts: `/api/*` dispatches into
 * host-level actions (here: `claude` refine runs + capturing the submit) with
 * NO authentication, so it must only be reachable by the local page. Refuse
 * cross-origin requests (an `Origin` from another site) and non-localhost
 * `Host` headers (DNS-rebinding), independent of any CORS policy upstream.
 * The legitimate page is same-origin on localhost, so it always passes.
 */
export function localOnly(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const origin = req.headers.origin;
  if (origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).hostname;
    } catch {
      /* malformed Origin → treat as untrusted */
    }
    if (!isLocalHost(originHost ?? undefined)) {
      res.status(403).json({ error: "cross-origin request refused" });
      return;
    }
  }
  if (!isLocalHost(req.headers.host)) {
    res.status(403).json({ error: "non-local host refused" });
    return;
  }
  next();
}

/**
 * Serve `bundle` as a localhost form, open the browser, and resolve once the
 * user submits, cancels, or `timeoutMs` elapses. The form's "Refine with Claude"
 * button is wired to {@link refinePrompt} (same local `claude` CLI path the
 * Desktop UI uses). The HTTP server is bound to `127.0.0.1` and torn down before
 * this resolves. `opts.open: false` skips opening the browser (for tests).
 */
export function promptViaLocalhostForm(
  bundle: FormSchemaBundle,
  opts: { timeoutMs?: number; open?: boolean } = {},
): Promise<LocalhostFormResult> {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;

  return new Promise<LocalhostFormResult>((resolve) => {
    const app = express();
    app.use(express.json({ limit: "1mb" }));

    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (result: LocalhostFormResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // Close after the in-flight response flushes.
      setTimeout(() => httpServer.close(() => resolve(result)), 50);
    };

    app.get("/", async (_req, res) => {
      try {
        const html = await fs.readFile(path.join(DIST_DIR, "form.html"), "utf-8");
        res.type("html").send(html);
      } catch {
        res
          .status(500)
          .type("text")
          .send("Form UI bundle missing — run `npm run build` in apps/sandbox-dashboard.");
      }
    });

    app.post("/api/tool", localOnly, async (req, res) => {
      const { name, arguments: args } = (req.body ?? {}) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      try {
        switch (name) {
          case "workspace-form-schema":
            res.json({ structuredContent: bundle });
            return;
          case "refine-prompt": {
            const a = (args ?? {}) as {
              text?: string;
              instruction?: string;
              formData?: Record<string, unknown>;
            };
            const refined = await refinePrompt(a.text ?? "", a.instruction ?? "", a.formData);
            res.json({ structuredContent: { refined } });
            return;
          }
          case "issue-form-data": {
            const ref = typeof args?.ref === "string" ? args.ref : "";
            res.json({ structuredContent: { formData: await fetchIssueFormData(ref) } });
            return;
          }
          case "create-workspace":
            res.json({
              structuredContent: {
                output: "Submitted — return to Claude; the workspace is being created there.",
              },
            });
            settle({
              status: "submitted",
              formData: (args?.formData ?? {}) as Record<string, unknown>,
              open: typeof args?.open === "boolean" ? args.open : undefined,
            });
            return;
          case "cancel-form":
            res.json({ structuredContent: null });
            settle({ status: "cancelled" });
            return;
          default:
            res.status(400).json({ error: `unknown tool ${String(name)}` });
        }
      } catch (e) {
        const msg = e instanceof WorkspaceError ? e.message : (e as Error).message;
        res.status(500).json({ error: msg });
      }
    });

    const httpServer = app.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/`;
      console.error(`[workspaces] workspace form: ${url}`);
      if (opts.open !== false) openBrowser(url);
    });

    httpServer.on("error", () => settle({ status: "cancelled" }));
    timer = setTimeout(() => settle({ status: "timeout" }), timeoutMs);
  });
}
