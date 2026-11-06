/**
 * Where OpenCode reads a workspace (SW-385): `AGENTS.md` and `.agents/skills`, like the
 * generic `mcp` layout, plus its own hook files ({@link writeOpencodeHooks}). Kept apart
 * from the adapter so harness/layout.ts does not load the session code.
 */
import type { HarnessLayout } from "../types.js";
import { writeOpencodeHooks } from "./hooks.js";

export const OPENCODE_MISSING_HOOKS = "session-start context, auto-stop";

export const opencodeLayout: HarnessLayout = {
  id: "opencode",
  instructionsFile: "AGENTS.md",
  skillsDir: ".agents/skills",
  hooks: { available: "own", write: writeOpencodeHooks, missing: OPENCODE_MISSING_HOOKS },
  agents: false,
  notice: () =>
    "\n## Harness\n\n" +
    "This workspace was generated for OpenCode. Werkmeister's MCP server is registered in " +
    "`opencode.json`, and `.opencode/plugins/werkmeister.js` runs the standards gate, the PR " +
    "guard and agent state. Session-start context and auto-stop do not run on OpenCode: nothing " +
    "injects the notes when a session starts, and quitting does not stop the containers. A " +
    "`model:` in workspace.yml applies to headless turns only in OpenCode's `provider/model` " +
    "form. Open PRs only with `werkmeister pr open`.\n",
};
