// SW-632: the generated autonomous rules against the real Claude Code matcher, not the regex model in
// workspace-permissions.test.mjs, which drifted from it three times in SW-560. Opt-in: it needs a logged-in
// `claude` (CLAUDE_BIN, default `claude`) and spends a few haiku calls, so it is never in CI.
// Recipe (SW-822): `--settings <file>`, since an untrusted folder's .claude/settings.json allow list is ignored.
//   WERKMEISTER_REAL_CLAUDE=1 node --test test/real-claude-permissions.test.mjs

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { cli } from "../dist/harness/autonomous_deny.js";
import {
  AUTONOMOUS_DENY,
  autonomousRules,
  buildAllowRules,
} from "../dist/harness/claude/hooks_gen.js";
import { stageGrants } from "../dist/strategies/icm_templates.js";

const REAL = process.env.WERKMEISTER_REAL_CLAUDE === "1";
const run = promisify(execFile);

/** A temp git repo, a stub dir whose `werkmeister`, `w9r` and `with-temp-home` only log their argv, and the rules. */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "real-claude-"));
  const repo = path.join(dir, "repo");
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "calls.log");
  fs.mkdirSync(repo);
  fs.mkdirSync(bin);
  for (const name of ["werkmeister", "w9r", "with-temp-home"]) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\n`, {
      mode: 0o755,
    });
  }
  const tempHome = path.join(bin, "with-temp-home");
  // SW-660's row: a `{ …; }` group plus a repo lint, wrapped as one exact `sh -c` line.
  const wrapped = buildAllowRules(
    "feat",
    [],
    { svc: { repo: "r", test: "{ true; } && pnpm test" } },
    {},
    tempHome,
    [],
    ["svc"],
    { r: { lint: "pnpm lint" } },
  ).filter((r) => r.startsWith(`Bash(${tempHome} `));
  const settings = path.join(dir, "settings.json");
  fs.writeFileSync(
    settings,
    JSON.stringify({
      permissions: {
        // An ICM bugfix run's stage grants (SW-807), as workspaceAllowRules adds them.
        allow: [
          ...autonomousRules("feat", ["api"]),
          ...wrapped,
          ...stageGrants("bugfix").flatMap(cli),
        ],
        deny: AUTONOMOUS_DENY,
      },
    }),
  );
  return { dir, repo, bin, log, settings, wrapped: wrapped.map((r) => r.slice(5, -1)) };
}

async function setup(f) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  await run("git", ["-C", f.repo, "init", "-q"], { env });
  fs.writeFileSync(path.join(f.repo, "a.txt"), "a\n");
  await run("git", ["-C", f.repo, "add", "a.txt"], { env });
  await run("git", ["-C", f.repo, "commit", "-q", "-m", "init"], { env });
}

/** Ask claude to run *cmd* once; returns the commands it was refused. */
async function probe(f, cmd) {
  const { stdout } = await run(
    process.env.CLAUDE_BIN || "claude",
    [
      "-p",
      "--model",
      "haiku",
      "--setting-sources",
      "project",
      "--settings",
      f.settings,
      "--permission-mode",
      "default",
      "--output-format",
      "json",
      `Run this exact command once with the Bash tool, unchanged, then stop: ${cmd}`,
    ],
    {
      cwd: f.repo,
      env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` },
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return (JSON.parse(stdout).permission_denials ?? []).map((d) => d.tool_input?.command ?? "");
}

const calls = (f) => (fs.existsSync(f.log) ? fs.readFileSync(f.log, "utf8") : "");

test("SW-632: everyday commands run under the real matcher; escapes are refused", {
  skip: !REAL && "set WERKMEISTER_REAL_CLAUDE=1",
}, async () => {
  const f = fixture();
  await setup(f);
  const mustRun = [
    "git status",
    "git log --oneline -1",
    "werkmeister feature logs feat",
    "w9r pr gate --tests",
    // SW-963: the static-page server the contracts name.
    "werkmeister workspace serve stages",
    // SW-1092: the seeded dashboard the werkmeister-dashboard Validation text names.
    "werkmeister workspace serve --dashboard",
    // SW-1059: the fixup fold the grouped contracts name.
    "werkmeister pr autosquash",
    // SW-1085: the bare start stays pre-approved.
    "werkmeister issue start",
    ...f.wrapped,
  ];
  const mustDeny = [
    "werkmeister feature test feat -w ../other --scaffold",
    "werkmeister pr watch --install",
    "werkmeister workspace init --feature other",
    "git rebase -x 'touch rebase.mark' HEAD",
    "git -c alias.x='!touch alias.mark' x",
    "git -C /tmp status",
    // SW-855 review: the playwright config route, and git routes past the repo.
    "werkmeister feature test feat",
    "git grep -lO'touch grep.mark' a",
    "git fetch --upl='touch fetch.mark;false' .",
    "git log -1 --format=tformat:x --output=output.mark",
    "git remote -v add evil /tmp",
    "git diff --no-index /dev/null /etc/hosts",
    `${f.wrapped[0]} && touch chain.mark`,
    // SW-963: python3 stays denied, raw or chained after the allowed serve.
    "python3 -I -u -m http.server 0 -b 127.0.0.1 -d stages",
    "werkmeister workspace serve stages && touch serve.mark",
    // SW-1059: both raw non-interactive autosquash forms stay refused.
    "git -c sequence.editor=true rebase -q -i --autosquash HEAD",
    "GIT_SEQUENCE_EDITOR=true git rebase -q -i --autosquash HEAD",
    "werkmeister pr autosquash && touch squash.mark",
    // SW-1085: a ref moves another ticket; --attach rewrites the issue_id the --relates rule keys on.
    "werkmeister issue start SW-1",
    "werkmeister issue start SW-1 --attach",
    "w9r issue start --attach SW-1",
  ];
  // Sequential: parallel haiku sessions in one folder would share its transcript dir.
  for (const cmd of mustRun) {
    const denied = await probe(f, cmd);
    assert.deepEqual(denied, [], `must run: ${cmd}`);
  }
  for (const cmd of mustDeny) {
    const denied = await probe(f, cmd);
    assert.ok(denied.length > 0, `must be refused: ${cmd}`);
  }
  // Markers prove nothing refused ran: neither a stub call nor a touch.
  assert.doesNotMatch(calls(f), /--scaffold|pr watch|--feature other|&& touch/);
  for (const mark of [
    "rebase.mark",
    "alias.mark",
    "chain.mark",
    "grep.mark",
    "fetch.mark",
    "output.mark",
    "serve.mark",
    "squash.mark",
  ])
    assert.ok(!fs.existsSync(path.join(f.repo, mark)), mark);
  assert.doesNotMatch(calls(f), /feature test/);
  assert.match(calls(f), /^werkmeister feature logs feat$/m, "the allowed stub call ran");
  assert.doesNotMatch((await run("git", ["-C", f.repo, "remote"])).stdout, /evil/);
});
