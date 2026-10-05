/**
 * Standalone browser-form CLI for creating a sandbox workspace.
 *
 * This is the entry point the `/sandbox-workspace` skill (Claude Code) calls via
 * `sandbox workspace --browser-form`. It reuses the exact same pieces as the
 * Desktop MCP App and the MCP server's CLI fallback:
 *
 *   getFormSchema()  →  promptViaLocalhostForm()  →  createWorkspace()
 *
 * so there is ONE form and ONE create path across every surface. Unlike
 * the MCP server, this needs no MCP client connection — it just opens the
 * bundled create form in the user's browser, blocks until submit/cancel, then shells
 * `sandbox workspace`. A single JSON object describing the outcome is written to
 * stdout; all human-facing progress goes to stderr.
 *
 * Flags:
 *   --jira <ref>          Jira ticket id/URL to pre-fill the form.
 *   --open                Launch VS Code on the new workspace (default: off).
 *   --timeout <seconds>   How long to wait for the form submit (default: 600).
 */
import {
  createWorkspace,
  fetchJiraFormData,
  getFormSchema,
  WorkspaceError,
} from "sandbox-core";
import { promptViaLocalhostForm } from "./lib/localhost-form.js";

interface CliArgs {
  jira?: string;
  open: boolean;
  timeoutMs: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { open: false, timeoutMs: 600_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--jira") out.jira = argv[++i];
    else if (arg === "--open") out.open = true;
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

  let bundle;
  try {
    bundle = await getFormSchema();
    if (args.jira) {
      const jiraData = await fetchJiraFormData(args.jira);
      bundle.formData = { ...bundle.formData, ...jiraData };
    }
  } catch (e) {
    const message = e instanceof WorkspaceError ? e.message : (e as Error).message;
    emit({ status: "error", message }, 1);
  }

  const filled = await promptViaLocalhostForm(bundle!, { timeoutMs: args.timeoutMs });
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
