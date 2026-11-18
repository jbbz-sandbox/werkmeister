// Regenerates the gitignored .claude-plugin/types/ that tsconfig.json extends (SW-327).
// Claude Code writes it when a session loads this folder as a plugin, before it checks the login.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const types = ".claude-plugin/types";
rmSync(types, { recursive: true, force: true });

// CLAUDE_CODE_VERSION=<x.y.z> generates another version's types through npx, so a failure
// seen only with the host's newer Claude Code reproduces in the container (SW-732).
const version = process.env.CLAUDE_CODE_VERSION?.trim();
if (version && !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`gen-types: CLAUDE_CODE_VERSION must be x.y.z, got "${version}"`);
  process.exit(1);
}
const [bin, pre] = version
  ? ["npx", ["-y", `@anthropic-ai/claude-code@${version}`]]
  : ["claude", []];

const home = mkdtempSync(join(tmpdir(), "werkmeister-plugin-types-"));
let run;
try {
  // No key, token or login reaches it, so a logged-in developer's run stops at
  // "Not logged in" instead of spending a real turn. Claude Code writes the types only in
  // dev-mod watch mode (PLUGIN_DIR_WATCH, undocumented; checked on 2.1.316, the CI pin).
  run = spawnSync(bin, [...pre, "--plugin-dir", ".", "-p", "hi"], {
    env: { PATH: process.env.PATH, HOME: home, CLAUDE_CODE_PLUGIN_DIR_WATCH: "1" },
    stdio: "ignore",
    timeout: version ? 300_000 : 60_000, // npx downloads the version first
  });
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (!existsSync(join(types, "tsconfig.json"))) {
  const cause =
    run.error?.code === "ENOENT"
      ? `\`${bin}\` is not on PATH; install Claude Code: https://docs.claude.com/en/docs/claude-code/setup`
      : `\`${[bin, ...pre].join(" ")} --plugin-dir . -p hi\` wrote no types (${run.error?.message ?? `exit ${run.status}`})`;
  console.error(`gen-types: ${types}/tsconfig.json missing: ${cause}`);
  process.exit(1);
}
