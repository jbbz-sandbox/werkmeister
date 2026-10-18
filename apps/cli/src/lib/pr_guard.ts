/**
 * Build entry for the PR-guard PreToolUse hook (`sandbox hooks pr-guard`).
 * Like lib/gate.ts: the `sandbox` wrapper execs `dist/lib/pr_guard.js` directly,
 * because the hook fires on every Bash call and must skip the CLI's import chain.
 */

import { main } from "werkmeister-core/pr_guard";

main();
