// Regenerates the gitignored .claude-plugin/types/ that tsconfig.json extends (SW-327).
// Claude Code writes it when a session loads this folder as a plugin, before it checks the login.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const types = ".claude-plugin/types";
rmSync(types, { recursive: true, force: true });

const home = mkdtempSync(join(tmpdir(), "werkmeister-plugin-types-"));
let run;
try {
  // No key, token or login reaches it, so a logged-in developer's run stops at
  // "Not logged in" instead of spending a real turn. Claude Code writes the types only in
  // dev-mod watch mode (PLUGIN_DIR_WATCH, undocumented; checked on 2.1.316, the CI pin).
  run = spawnSync("claude", ["--plugin-dir", ".", "-p", "hi"], {
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_PLUGIN_DIR_WATCH: "1" },
    stdio: "ignore",
    timeout: 60_000,
  });
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (!existsSync(join(types, "tsconfig.json"))) {
  const cause =
    run.error?.code === "ENOENT"
      ? "`claude` is not on PATH; install Claude Code: https://docs.claude.com/en/docs/claude-code/setup"
      : `\`claude --plugin-dir . -p hi\` wrote no types (${run.error?.message ?? `exit ${run.status}`})`;
  console.error(`gen-types: ${types}/tsconfig.json missing: ${cause}`);
  process.exit(1);
}
