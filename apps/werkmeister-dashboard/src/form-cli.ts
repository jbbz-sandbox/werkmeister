/**
 * Standalone browser-form CLI for creating a workspace.
 *
 * This is the entry point the `/werkmeister:workspace` skill (Claude Code) calls via
 * `werkmeister workspace new --browser-form`. It reuses the exact same pieces as the
 * Desktop MCP App and the MCP server's CLI fallback:
 *
 *   getFormSchema()  →  promptViaLocalhostForm()  →  createWorkspace()
 *
 * so there is ONE form and ONE create path across every surface. Unlike
 * the MCP server, this needs no MCP client connection — it just opens the
 * bundled create form in the user's browser, blocks until submit/cancel, then runs
 * `createWorkspace` in-process. A single JSON object describing the outcome is written to
 * stdout; all human-facing progress goes to stderr.
 *
 * Flags:
 *   --prefill <json>      Form values from CLI flags; they win over the issue's.
 *   --issue <ref>         Issue ID/URL (this machine's issue tracker) to pre-fill the form.
 *   --open                Launch VS Code on the new workspace (default: off).
 *   --timeout <seconds>   How long to wait for the form submit (default: 600).
 *
 * Env:
 *   WERKMEISTER_FORM_NO_BROWSER=1   Serve the form but don't open the system browser; the
 *                               caller reads the URL off stderr and opens it itself
 *                               (the /werkmeister:workspace skill does this in the Claude
 *                               Code desktop app to show the form in its Browser pane).
 */
import {
  createWorkspace,
  type FormSchemaBundle,
  fetchIssueFormData,
  getFormSchema,
  WorkspaceError,
} from "werkmeister-core";
import { envVar } from "werkmeister-core/config";
import { promptViaLocalhostForm } from "./lib/localhost-form.js";

interface CliArgs {
  issue?: string;
  prefill?: Record<string, string | string[]>;
  open: boolean;
  timeoutMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { open: false, timeoutMs: 600_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--issue") out.issue = argv[++i];
    else if (arg === "--prefill") {
      try {
        out.prefill = JSON.parse(argv[++i]);
      } catch {
        process.stderr.write("form-cli: ignoring unparseable --prefill\n");
      }
    } else if (arg === "--open") out.open = true;
    else if (arg === "--timeout") out.timeoutMs = Math.max(1, Number(argv[++i]) || 600) * 1000;
  }
  return out;
}

/** Emit the single outcome JSON document the skill parses, then exit. */
function emit(result: Record<string, unknown>, exitCode: number): never {
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(exitCode);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let bundle: FormSchemaBundle;
  try {
    bundle = await getFormSchema();
    // Explicit CLI values win over the issue's.
    if (args.issue) {
      const issueData = await fetchIssueFormData(args.issue);
      bundle.formData = { ...bundle.formData, ...issueData };
    }
    if (args.prefill) bundle.formData = { ...bundle.formData, ...args.prefill };
  } catch (e) {
    const message = e instanceof WorkspaceError ? e.message : (e as Error).message;
    emit({ status: "error", message }, 1);
  }

  const filled = await promptViaLocalhostForm(bundle, {
    timeoutMs: args.timeoutMs,
    open: !envVar("FORM_NO_BROWSER"),
  });
  if (filled.status !== "submitted") {
    // cancelled | timeout — nothing was created; not an error exit.
    emit({ status: filled.status }, 0);
  }

  try {
    // The form's "Open in VS Code" checkbox wins over the --open flag default.
    const result = await createWorkspace(filled.formData ?? {}, { open: filled.open ?? args.open });
    emit({ status: "submitted", create: { ok: true, result } }, 0);
  } catch (e) {
    const error = e instanceof WorkspaceError ? e.message : (e as Error).message;
    emit({ status: "submitted", create: { ok: false, error } }, 1);
  }
}

main().catch((e) => {
  emit({ status: "error", message: (e as Error).message }, 1);
});
