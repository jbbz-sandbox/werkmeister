/**
 * Build entry for the agent-state hook (`sandbox hooks agent-state`). Like
 * lib/pr_guard.ts: the `sandbox` wrapper execs `dist/lib/agent_state.js` directly,
 * because PreToolUse and PostToolUse fire it on every tool call.
 */

import { main } from "werkmeister-core/agent_state";

main();
