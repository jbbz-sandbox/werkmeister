// The workspace's permissions.allow merge: adds once, keeps the person's rules,
// and removes only what werkmeister recorded adding.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { dotDir } from "./dist/config.js";
import {
  AUTONOMOUS_DENY,
  AUTONOMOUS_RULES,
  autonomousRules,
  buildAllowRules,
  READ_ONLY_GIT_RULES,
  removeWorkspacePermissions,
  workspaceAllowRules,
  workspaceAskRules,
  writeWorkspacePermissions,
} from "./dist/harness/claude/hooks_gen.js";

const HAND_HOOK = { hooks: [{ type: "command", command: "echo mine" }] };

function workspace(settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-perms-"));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(root, ".claude"));
    fs.writeFileSync(
      settingsPath(root),
      typeof settings === "string" ? settings : JSON.stringify(settings),
    );
  }
  return root;
}

const settingsPath = (root) => path.join(root, ".claude", "settings.json");
const recordPath = (root) => path.join(dotDir(root), "claude-permissions.json");
const readSettings = (root) => JSON.parse(fs.readFileSync(settingsPath(root), "utf8"));
const readRecord = (root) => JSON.parse(fs.readFileSync(recordPath(root), "utf8"));

test("no .claude/: the rules land in a new settings.json and the record", () => {
  const root = workspace();
  writeWorkspacePermissions(root, ["a", "b"]);
  assert.deepEqual(readSettings(root), { permissions: { allow: ["a", "b"] } });
  assert.deepEqual(readRecord(root), { allow: ["a", "b"] });
});

test("other keys, hooks, deny rules and the person's allow rules are kept", () => {
  const root = workspace({
    model: "opus",
    hooks: { PreToolUse: [HAND_HOOK] },
    permissions: { deny: ["Bash(rm:*)"], allow: ["mine"] },
  });
  writeWorkspacePermissions(root, ["a"]);
  assert.deepEqual(readSettings(root), {
    model: "opus",
    hooks: { PreToolUse: [HAND_HOOK] },
    permissions: { deny: ["Bash(rm:*)"], allow: ["mine", "a"] },
  });
  assert.deepEqual(readRecord(root), { allow: ["a"] });
});

test("a second write adds nothing and leaves both files untouched", () => {
  const root = workspace();
  writeWorkspacePermissions(root, ["a", "b"]);
  const old = new Date(2000, 0, 1);
  fs.utimesSync(settingsPath(root), old, old);
  fs.utimesSync(recordPath(root), old, old);
  writeWorkspacePermissions(root, ["a", "b"]);
  assert.deepEqual(readSettings(root).permissions.allow, ["a", "b"]);
  assert.equal(fs.statSync(settingsPath(root)).mtimeMs, old.getTime());
  assert.equal(fs.statSync(recordPath(root)).mtimeMs, old.getTime());
});

test("a rule the person already had is not recorded, so removal keeps it", () => {
  const root = workspace({ permissions: { allow: ["a"] } });
  writeWorkspacePermissions(root, ["a", "b"]);
  assert.deepEqual(readSettings(root).permissions.allow, ["a", "b"]);
  assert.deepEqual(readRecord(root), { allow: ["b"] });
  removeWorkspacePermissions(root);
  assert.deepEqual(readSettings(root), { permissions: { allow: ["a"] } });
  assert.ok(!fs.existsSync(recordPath(root)));
});

test("a rule werkmeister added that is no longer wanted is dropped", () => {
  const root = workspace();
  writeWorkspacePermissions(root, ["a", "b"]);
  writeWorkspacePermissions(root, ["b", "c"]);
  assert.deepEqual(readSettings(root).permissions.allow, ["b", "c"]);
  assert.deepEqual(readRecord(root), { allow: ["b", "c"] });
});

test("removal of the only content deletes settings.json, .claude/ and the record", () => {
  const root = workspace();
  writeWorkspacePermissions(root, ["a"]);
  removeWorkspacePermissions(root);
  assert.ok(!fs.existsSync(path.join(root, ".claude")));
  assert.ok(!fs.existsSync(recordPath(root)));
});

test("removal keeps hooks and drops the emptied permissions key", () => {
  const root = workspace({ hooks: { PreToolUse: [HAND_HOOK] } });
  writeWorkspacePermissions(root, ["a"]);
  removeWorkspacePermissions(root);
  assert.deepEqual(readSettings(root), { hooks: { PreToolUse: [HAND_HOOK] } });
});

for (const [name, body] of [
  ["unparseable JSON", "{ not json"],
  ["permissions is an array", JSON.stringify({ permissions: [] })],
  ["allow is a string", JSON.stringify({ permissions: { allow: "x" } })],
]) {
  test(`${name}: settings.json is left untouched and nothing is recorded`, () => {
    const root = workspace(body);
    writeWorkspacePermissions(root, ["a"]);
    assert.equal(fs.readFileSync(settingsPath(root), "utf8"), body);
    assert.ok(!fs.existsSync(recordPath(root)));
  });
}

test("buildAllowRules: container form + bare prefix per command, then git; no rule invented", () => {
  assert.deepEqual(
    buildAllowRules("feat", ["svc", "nocmd"], { svc: { test: "npm test" }, nocmd: {} }, {}),
    ["Bash(docker exec feat-svc sh -c 'npm test')", "Bash(npm test:*)", ...READ_ONLY_GIT_RULES],
  );
});

test("buildAllowRules: the command through the temp-HOME wrapper, never the wrapper alone (SW-124)", () => {
  const rules = buildAllowRules("feat", ["svc"], { svc: { test: "npm test" } }, {}, "/ws/w");
  assert.ok(rules.includes("Bash(/ws/w npm test:*)"), rules.join("\n"));
  assert.ok(!rules.includes("Bash(/ws/w:*)"));
});

test("buildAllowRules: a built CLI runs through the temp-HOME wrapper, never the wrapper alone (SW-172)", () => {
  const cli = "/ws/w/werkmeister/apps/cli/werkmeister";
  const rules = buildAllowRules("feat", [], {}, {}, "/ws/w/.werkmeister/bin/with-temp-home", [cli]);
  assert.ok(
    rules.includes(`Bash(/ws/w/.werkmeister/bin/with-temp-home ${cli}:*)`),
    rules.join("\n"),
  );
  assert.ok(!rules.includes("Bash(/ws/w/.werkmeister/bin/with-temp-home:*)"));
  assert.ok(!buildAllowRules("feat", [], {}, {}, "", [cli]).some((r) => r.includes(cli)));
});

test("buildAllowRules: each wrapped rule also has the --no-wait form, never the wrapper alone (SW-367)", () => {
  const w = "/ws/w/.werkmeister/bin/with-temp-home";
  const rules = buildAllowRules("", [], { cli: { test: "pnpm test" } }, {}, w, [], ["cli"]);
  assert.ok(rules.includes(`Bash(${w} --no-wait pnpm test:*)`), rules.join("\n"));
  assert.ok(!rules.includes(`Bash(${w} --no-wait:*)`));
});

test("buildAllowRules: with a built CLI, the fixture wrapper is allowed whole (SW-292)", () => {
  const fixture = "Bash(/ws/w/.werkmeister/bin/with-fixture-workspace:*)";
  const tempHome = "/ws/w/.werkmeister/bin/with-temp-home";
  const cli = "/ws/w/werkmeister/apps/cli/werkmeister";
  assert.ok(buildAllowRules("feat", [], {}, {}, tempHome, [cli]).includes(fixture));
  assert.ok(!buildAllowRules("feat", [], {}, {}, tempHome, []).includes(fixture));
});

// SW-522's threat model (docs/context-strategies.md): only the registered test commands and the
// workspace's own built CLI run unprompted; they may run agent-written code with the real HOME.
test("buildAllowRules: the only pre-approved runners are the registered test command and the built CLI (SW-522)", () => {
  const bin = "/ws/w/.werkmeister/bin";
  const w = `${bin}/with-temp-home`;
  const cli = "/ws/w/werkmeister/apps/cli/werkmeister";
  const rules = buildAllowRules("feat", ["svc"], { svc: { test: "npm test" } }, {}, w, [cli]);
  assert.deepEqual(rules.filter((r) => r.startsWith(`Bash(${bin}/`)).sort(), [
    `Bash(${bin}/with-fixture-workspace:*)`,
    `Bash(${w} --no-wait ${cli}:*)`,
    `Bash(${w} --no-wait npm test:*)`,
    `Bash(${w} ${cli}:*)`,
    `Bash(${w} npm test:*)`,
  ]);
});

test("buildAllowRules: an archetype's {service} template is expanded", () => {
  const rules = buildAllowRules(
    "feat",
    ["api"],
    { api: { archetype: "node" } },
    { node: { test: "npx turbo run test --filter={service}" } },
  );
  assert.deepEqual(rules.slice(0, 2), [
    "Bash(docker exec feat-api sh -c 'npx turbo run test --filter=api')",
    "Bash(npx turbo run test --filter=api:*)",
  ]);
});

test("workspaceAllowRules: no .env means the git rules alone, without the registry", () => {
  assert.deepEqual(workspaceAllowRules(workspace()), READ_ONLY_GIT_RULES);
});

test("workspaceAllowRules: a werkmeister worktree gets the wrapped built-CLI rule, no .env needed (SW-172)", () => {
  const root = workspace();
  const cli = path.join(root, "werkmeister", "apps", "cli", "werkmeister");
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.writeFileSync(path.join(root, "werkmeister", ".git"), "gitdir: x\n");
  fs.writeFileSync(cli, "#!/bin/bash\n");
  const wrapper = path.join(root, ".werkmeister", "bin", "with-temp-home");
  // includes, not deepEqual: a machine registry (the gate's container has one) adds the repo's test rules (SW-398).
  const rules = workspaceAllowRules(root, false);
  for (const r of [`Bash(${wrapper} ${cli}:*)`, ...READ_ONLY_GIT_RULES])
    assert.ok(rules.includes(r), r);
  assert.ok(!rules.includes(`Bash(${wrapper}:*)`));
});

test("jit refresh writes its hooks and the same allow rules", async () => {
  const { strategyById } = await import("./dist/strategies/index.js");
  const root = workspace();
  strategyById("jit").refresh(root);
  const settings = readSettings(root);
  assert.ok(settings.hooks.SessionStart, "JIT SessionStart hook");
  assert.equal(settings.hooks.PreToolUse.length, 3, "standards gate + PR guard + agent state");
  assert.deepEqual(settings.permissions.allow, READ_ONLY_GIT_RULES);
});

function setAutonomous(root, on) {
  fs.mkdirSync(dotDir(root), { recursive: true });
  fs.writeFileSync(
    path.join(dotDir(root), "workspace.yml"),
    `context_strategy: icm\nautonomous: ${on}\n`,
  );
}

test("deny rules: added, the person's kept, and dropped once unwanted", () => {
  const root = workspace({ permissions: { deny: ["Bash(rm:*)"] } });
  writeWorkspacePermissions(root, ["a"], ["x", "y"]);
  assert.deepEqual(readSettings(root).permissions, {
    deny: ["Bash(rm:*)", "x", "y"],
    allow: ["a"],
  });
  assert.deepEqual(readRecord(root), { allow: ["a"], deny: ["x", "y"] });
  writeWorkspacePermissions(root, ["a"], ["y"]);
  assert.deepEqual(readSettings(root).permissions.deny, ["Bash(rm:*)", "y"]);
  removeWorkspacePermissions(root);
  assert.deepEqual(readSettings(root), { permissions: { deny: ["Bash(rm:*)"] } });
  assert.ok(!fs.existsSync(recordPath(root)));
});

test("autonomousRules: the feature's own werkmeister and docker targets, exact where extra args reach others", () => {
  const rules = autonomousRules("feat", ["api"]);
  for (const r of [
    "Bash(werkmeister feature up feat)",
    "Bash(w9r feature up feat)",
    "Bash(werkmeister feature restart feat)",
    "Bash(werkmeister feature logs feat:*)",
    "Bash(werkmeister feature test feat:*)",
    "Bash(docker restart feat-api)",
  ])
    assert.ok(rules.includes(r), r);
  // SW-560: no ad-hoc exec; the container's exact registered test comes from buildAllowRules.
  assert.ok(!rules.some((r) => r.startsWith("Bash(docker exec")), "no docker exec rule");
  assert.deepEqual(autonomousRules("", ["api"]), AUTONOMOUS_RULES);
});

test("autonomous rules reach nothing shared: no blanket command or server, deny covers the shared acts", () => {
  const blanket = /^Bash\((sandbox|werkmeister|w9r|docker|npm|gh|claude|claude plugin):\*\)$/;
  assert.ok(!AUTONOMOUS_RULES.some((r) => blanket.test(r)), "no blanket rule");
  assert.ok(!AUTONOMOUS_RULES.includes("mcp__plugin_werkmeister_werkmeister"), "no whole server");
  assert.ok(!AUTONOMOUS_RULES.some((r) => r.startsWith("Bash(npm install")), "no npm install");
  // SW-31: the only pnpm install is the lockfile one; adding a dependency waits for a person.
  assert.deepEqual(
    AUTONOMOUS_RULES.filter((r) => /^Bash\(pnpm (install|i|add)\b/.test(r)),
    ["Bash(pnpm install --frozen-lockfile)"],
  );
  for (const r of [
    "Bash(werkmeister infra proxy-reload:*)",
    "Bash(werkmeister remove-workspace:*)",
    "Bash(werkmeister feature down:*)",
    "Bash(w9r infra proxy-reload:*)",
    "Bash(docker stop:*)",
    "Bash(docker rm:*)",
    "Bash(npm publish:*)",
    "Bash(npm link:*)",
    "Bash(npm install -g:*)",
    "Bash(pnpm publish:*)",
    "Bash(pnpm link:*)",
    "Bash(pnpm add -g:*)",
    "mcp__plugin_werkmeister_werkmeister__kube-switch",
    "mcp__plugin_werkmeister_werkmeister__up",
    "mcp__plugin_werkmeister_werkmeister__down",
    "mcp__plugin_werkmeister_werkmeister__proxy-reload",
  ])
    assert.ok(AUTONOMOUS_DENY.includes(r), r);
  const allowed = new Set(autonomousRules("feat", ["api"]));
  assert.ok(!AUTONOMOUS_DENY.some((r) => allowed.has(r)), "no rule both allowed and denied");
  // SW-23: the pre-SW-9 plugin prefix is no longer generated.
  assert.ok(![...AUTONOMOUS_DENY, ...allowed].some((r) => r.includes("sandbox-tools")));
});

test("SW-521: autonomous rules never pre-approve an interpreter that runs any file with the real HOME", () => {
  // A `Bash(x:*)` rule matches any command starting with `x`; deny outranks allow.
  const matches = (rules, cmd) =>
    rules.some((r) => {
      const m = /^Bash\((.*?)(:\*)?\)$/.exec(r);
      return m && (m[2] ? cmd.startsWith(m[1]) : cmd === m[1]);
    });
  // The settings.json list, and the one a headless wake passes as --allowedTools (session.ts).
  // fhir's registered chain ends in a bare `node --test` segment, allowed as its own rule.
  const chain = { svc: { test: "cd x && node --test" } };
  const lists = [
    autonomousRules("feat", ["api"]),
    workspaceAllowRules(workspace(), true),
    buildAllowRules("feat", ["svc"], chain, {}, "/ws/w/.werkmeister/bin/with-temp-home"),
  ];
  for (const allow of lists)
    for (const cmd of [
      "node x.mjs",
      "node --test x.test.mjs",
      "node -e 1",
      "npx tsx x.ts",
      "pnpm exec node x.mjs",
      "python3 x.py",
    ])
      assert.ok(!matches(allow, cmd) || matches(AUTONOMOUS_DENY, cmd), cmd);
});

test("SW-560: no route past the registered commands to scripts, readers, docker exec or git config", () => {
  // Claude Code's matching: `:*` is a word-boundary prefix, any other `*` a wildcard (probed on 2.1.319).
  const re = (r) => {
    const m = /^Bash\((.*?)(:\*)?\)$/.exec(r);
    if (!m) return null;
    const body = m[1].replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${body}${m[2] ? "( .*)?" : ""}$`);
  };
  const matches = (rules, cmd) => rules.some((r) => re(r)?.test(cmd));
  for (const allow of [autonomousRules("feat", ["api"]), workspaceAllowRules(workspace(), true)]) {
    const runs = (cmd) => matches(allow, cmd) && !matches(AUTONOMOUS_DENY, cmd);
    for (const cmd of [
      "sed -i '' s/a/b/ f",
      "sed -n 'w x' f",
      "find . -delete",
      "find . -exec touch x ;",
      "mkdir -p /Users/x/.werkmeister/locks/install-1",
      "cat /Users/x/.ssh/id_ed25519",
      "grep -r TOKEN /Users/x/features",
      "ls -la /Users/x/.ssh",
      "docker exec feat-api curl http://host.docker.internal:3002/api/tool",
      "npm run x",
      "pnpm run x",
      "npm test",
      "pnpm test",
      "pnpm turbo run x",
      "git -c alias.x=!y x",
      "git config alias.y !z",
      "git --config-env=core.pager=HOME log",
      "git clone --config core.fsmonitor=x . sub",
      "git --exec-path=. x",
      "git --git-dir=/x status",
      "git init --template=/x sub",
    ])
      assert.ok(!runs(cmd), cmd);
    for (const cmd of [
      "npm ci",
      "pnpm install --frozen-lockfile",
      "git status",
      "git -C werkmeister diff",
      "git commit -m x",
      "git commit -m fix config loader",
      "git add config src",
      "git grep -c x",
      "git -C . log -1 -- config",
    ])
      assert.ok(runs(cmd), cmd);
  }
});

test("SW-560: a workspace's services keep only their exact registered test in the container", async () => {
  const { withSandboxHome } = await import("./fixtures.mjs");
  await withSandboxHome(
    async () => {
      const root = workspace();
      fs.mkdirSync(dotDir(root), { recursive: true });
      fs.writeFileSync(path.join(root, ".env"), "FEATURE=feat\nSERVICES=api\n");
      const rules = workspaceAllowRules(root, true);
      assert.deepEqual(
        rules.filter((r) => r.startsWith("Bash(docker exec")),
        ["Bash(docker exec feat-api sh -c 'pnpm test')"],
      );
      assert.ok(!rules.includes("Bash(pnpm run:*)"), "no generic run rule");
    },
    {
      services:
        "services:\n  api:\n    type: library\n    repo: demo\n    path: api\n    test: pnpm test\n",
    },
  );
});

test("SW-186: each pre-rename spelling keeps its rule through the window, beside its noun-group twin", () => {
  for (const name of ["werkmeister", "w9r"]) {
    for (const [old, now] of [
      ["up", "feature up"],
      ["restart", "feature restart"],
      ["init-workspace:*", "workspace init:*"],
      ["status:*", "feature status:*"],
      ["status:*", "infra status:*"],
    ]) {
      assert.ok(AUTONOMOUS_RULES.includes(`Bash(${name} ${old})`), `${name} ${old}`);
      assert.ok(AUTONOMOUS_RULES.includes(`Bash(${name} ${now})`), `${name} ${now}`);
    }
    for (const [old, now] of [
      ["proxy-reload", "infra proxy-reload"],
      ["down", "feature down"],
      ["remove", "feature drop"],
      ["clean", "machine clean"],
      ["setup", "machine setup"],
      ["connect", "infra connect"],
      ["intercept", "infra intercept"],
      ["up infra", "infra up"],
      ["down", "infra down"],
      ["restart infra", "infra restart"],
      ["stop infra", "infra stop"],
    ]) {
      assert.ok(AUTONOMOUS_DENY.includes(`Bash(${name} ${old}:*)`), `deny ${name} ${old}`);
      assert.ok(AUTONOMOUS_DENY.includes(`Bash(${name} ${now}:*)`), `deny ${name} ${now}`);
    }
    // `workspace:*` would also deny `workspace init`, so creating is denied by verb.
    assert.ok(!AUTONOMOUS_DENY.includes(`Bash(${name} workspace:*)`));
    for (const verb of ["workspace new", "ws new"])
      assert.ok(AUTONOMOUS_DENY.includes(`Bash(${name} ${verb}:*)`), verb);
  }
  // The own feature's one-service start (SW-132) is the only new prefix rule on `feature up`.
  const featureUp = autonomousRules("feat", ["api"]).filter((r) => r.includes(" feature up"));
  assert.ok(
    featureUp.every((r) => !r.endsWith(":*)") || r.includes("--service:*")),
    featureUp.join(),
  );
});

// A `Bash(…)` rule is a literal prefix: one written only for `werkmeister` never
// matched a `w9r` call, so autonomous runs stalled on them.
test("every CLI rule covers each launcher name", () => {
  const names = ["werkmeister", "w9r"];
  for (const list of [autonomousRules("feat", ["api"]), AUTONOMOUS_DENY]) {
    const cliRules = list.filter((r) => /^Bash\((werkmeister|w9r) /.test(r));
    assert.ok(cliRules.length > 0);
    for (const r of cliRules)
      for (const name of names) {
        const twin = r.replace(/^Bash\(\w+ /, `Bash(${name} `);
        assert.ok(list.includes(twin), `${r} has no ${name} form`);
      }
  }
});

// #175: a headless claude-send run needs these with nobody to approve them.
test("autonomous adds the headless rules on icm refresh, keeps the PR guard, and turning it off removes them", async () => {
  const { strategyById } = await import("./dist/strategies/index.js");
  const root = workspace({ permissions: { allow: ["Bash(git:*)"] } });
  setAutonomous(root, true);
  strategyById("icm").refresh(root);
  let settings = readSettings(root);
  for (const rule of AUTONOMOUS_RULES) assert.ok(settings.permissions.allow.includes(rule), rule);
  assert.deepEqual(settings.permissions.deny, AUTONOMOUS_DENY);
  assert.ok(settings.permissions.allow.includes("Bash(claude plugin test:*)"));
  assert.ok(
    !readRecord(root).allow.includes("Bash(git:*)"),
    "the person's own rule is not recorded",
  );
  assert.ok(
    settings.hooks.PreToolUse.some((e) =>
      e.hooks.some((h) => h.command.includes("werkmeister internal pr-guard")),
    ),
    "PR guard still installed",
  );

  setAutonomous(root, false);
  strategyById("icm").refresh(root);
  settings = readSettings(root);
  const ask = workspaceAskRules(root);
  assert.deepEqual(settings.permissions, { allow: ["Bash(git:*)", ...READ_ONLY_GIT_RULES], ask });
  assert.deepEqual(readRecord(root), { allow: READ_ONLY_GIT_RULES, ask });
});

// The rules before narrowing, as a record from an earlier release holds them.
test("a refresh replaces the old broad autonomous rules recorded earlier", async () => {
  const { strategyById } = await import("./dist/strategies/index.js");
  const old = [
    "Bash(sandbox:*)",
    "Bash(docker:*)",
    "Bash(npm:*)",
    "Bash(gh:*)",
    "mcp__plugin_werkmeister_werkmeister",
  ];
  const root = workspace({ permissions: { allow: ["mine", ...old] } });
  fs.mkdirSync(path.join(root, ".werkmeister"), { recursive: true });
  fs.writeFileSync(recordPath(root), JSON.stringify({ allow: old }));
  setAutonomous(root, true);
  strategyById("icm").refresh(root);
  const { allow, deny } = readSettings(root).permissions;
  for (const rule of old) assert.ok(!allow.includes(rule), rule);
  assert.ok(allow.includes("mine"));
  assert.deepEqual(deny, AUTONOMOUS_DENY);
});

// SW-398: werkmeister-context.md names the allow rules that cover the stage test command and the
// fixture form; each must be a rule the workspace is given, or a headless run is refused.
test("SW-398: every allow rule werkmeister-context.md names is generated", async () => {
  const { buildSandboxContextMd } = await import("./dist/harness/claude/claude_md.js");
  const { loadServices } = await import("./dist/config.js");
  const { withSandboxHome } = await import("./fixtures.mjs");
  await withSandboxHome(
    async () => {
      const wrapper = "/ws/w/.werkmeister/bin/with-temp-home";
      const doc = buildSandboxContextMd(
        "t",
        1,
        11100,
        11119,
        [],
        loadServices(),
        "",
        null,
        ["cli"],
        false,
        wrapper,
      );
      const named = [...doc.matchAll(/`(Bash\([^`]+\))`/g)].map((m) => m[1]);
      assert.ok(named.length, "the doc names an allow rule");
      const rules = buildAllowRules("", [], loadServices(), {}, wrapper, [], ["cli"]);
      const generic = named.map((r) => r.replace("<test command>", "pnpm test"));
      for (const r of generic)
        assert.ok(rules.includes(r), `${r} missing from:\n${rules.join("\n")}`);
      assert.ok(!rules.includes(`Bash(${wrapper}:*)`), "never the wrapper alone");
    },
    {
      services:
        "services:\n  cli:\n    type: cli\n    repo: demo\n    path: apps/cli\n    test: pnpm test\n",
    },
  );
});

test("SW-398, SW-660: a chained test command through the wrapper is one exact sh -c rule, no bare segment", () => {
  const w = "/ws/w/.werkmeister/bin/with-temp-home";
  const rules = buildAllowRules(
    "",
    [],
    { cli: { test: "pnpm turbo run test && pnpm --filter x run docs:links" } },
    {},
    w,
    [],
    ["cli"],
  );
  assert.ok(
    rules.includes(`Bash(${w} sh -c 'pnpm turbo run test && pnpm --filter x run docs:links')`),
  );
  assert.ok(!rules.includes("Bash(pnpm --filter x run docs:links:*)"), "no part runs unwrapped");
  assert.ok(!rules.some((r) => r.includes("docker exec")), "host-only service: no container rule");
});

test("ask rules land beside allow, are recorded, and removal drops them (SW-473)", () => {
  const root = workspace({ permissions: { ask: ["mine"] } });
  writeWorkspacePermissions(root, ["a"], [], ["q"]);
  assert.deepEqual(readSettings(root).permissions, { ask: ["mine", "q"], allow: ["a"] });
  assert.deepEqual(readRecord(root), { allow: ["a"], ask: ["q"] });
  removeWorkspacePermissions(root);
  assert.deepEqual(readSettings(root).permissions, { ask: ["mine"] });
});

test("node --test through the temp-HOME wrapper asks, both forms, never allowed (SW-510)", () => {
  const w = "/ws/w/.werkmeister/bin/with-temp-home";
  const cli = "/ws/w/werkmeister/apps/cli/werkmeister";
  const forms = [
    `Bash(${w} env WERKMEISTER_ROOT=* node --test:*)`,
    `Bash(${w} --no-wait env WERKMEISTER_ROOT=* node --test:*)`,
  ];
  const allow = buildAllowRules("feat", ["svc"], { svc: { test: "npm test" } }, {}, w, [cli]);
  assert.ok(!allow.some((r) => r.includes("node --test")), allow.join("\n"));
  const root = workspace();
  const bin = path.join(dotDir(root), "bin");
  assert.deepEqual(
    workspaceAskRules(root),
    forms.map((r) => r.replaceAll("/ws/w/.werkmeister/bin", bin)),
  );
});

test("--exec-runs forms of the fixture wrapper and built CLI ask; only node --test without a built CLI (SW-473)", () => {
  const root = workspace();
  const nodeTest = (bin) => [
    `Bash(${bin}/with-temp-home env WERKMEISTER_ROOT=* node --test:*)`,
    `Bash(${bin}/with-temp-home --no-wait env WERKMEISTER_ROOT=* node --test:*)`,
  ];
  assert.deepEqual(workspaceAskRules(root), nodeTest(path.join(dotDir(root), "bin")));
  const cli = path.join(root, "werkmeister", "apps", "cli");
  fs.mkdirSync(cli, { recursive: true });
  fs.mkdirSync(path.join(root, "werkmeister", ".git"));
  fs.writeFileSync(path.join(cli, "werkmeister"), "");
  const bin = path.join(dotDir(root), "bin");
  assert.deepEqual(workspaceAskRules(root), [
    `Bash(${bin}/with-fixture-workspace --exec-runs:*)`,
    `Bash(${bin}/with-fixture-workspace --no-wait --exec-runs:*)`,
    `Bash(${bin}/with-temp-home ${cli}/werkmeister internal fixture --exec-runs:*)`,
    `Bash(${bin}/with-temp-home --no-wait ${cli}/werkmeister internal fixture --exec-runs:*)`,
    ...nodeTest(bin),
  ]);
});

// shortcut: approximates Claude Code's Bash matcher (each `&&` `||` `;` `|` part outside quotes needs an
// exact or `:*` prefix rule); upgrade if the harness exposes its parser.
function allowed(rules, cmd) {
  const parts = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") quoted = !quoted;
    const op =
      !quoted && (["&&", "||"].includes(cmd.slice(i, i + 2)) ? 2 : ";|".includes(c) ? 1 : 0);
    if (op) {
      parts.push(cur.trim());
      cur = "";
      i += op - 1;
    } else cur += c;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean).every((p) =>
    rules.some((r) => {
      const body = r.slice(5, -1);
      if (!body.endsWith(":*")) return r.startsWith("Bash(") && body === p;
      const prefix = body.slice(0, -2);
      return p === prefix || p.startsWith(`${prefix} `);
    }),
  );
}

const W660 = "/ws/w/.werkmeister/bin/with-temp-home";
const BRACE = "{ command -v lsof >/dev/null || apt-get install -y lsof; } && pnpm test";

test("SW-660: the repo's lint the context file appends is allowed with the test, all under the temp HOME", async () => {
  const { wrappedTestCommand } = await import("./dist/archetypes.js");
  const services = { svc: { repo: "r", test: "pnpm test" } };
  const repos = { r: { lint: "pnpm lint && pnpm run docs:check" } };
  const rules = buildAllowRules("", [], services, {}, W660, [], ["svc"], repos);
  const printed = wrappedTestCommand(W660, "pnpm test", repos.r.lint);
  assert.equal(printed, `${W660} sh -c 'pnpm test && pnpm lint && pnpm run docs:check'`);
  assert.ok(allowed(rules, printed), rules.join("\n"));
  assert.ok(
    allowed(rules, `${W660} --no-wait sh -c 'pnpm test && pnpm lint && pnpm run docs:check'`),
  );
  assert.ok(!allowed(rules, `${printed} && rm -rf x`), "nothing rides after the quote");
  assert.ok(!rules.some((r) => r.startsWith("Bash(pnpm ")), "no unwrapped lint rule");
});

test("SW-660: a { …; } / || test command is printed and allowed as one exact sh -c line that parses", async () => {
  const { spawnSync } = await import("node:child_process");
  const { wrappedTestCommand } = await import("./dist/archetypes.js");
  const services = { svc: { repo: "r", test: BRACE } };
  const repos = { r: { lint: "pnpm lint" } };
  const rules = buildAllowRules("feat", ["svc"], services, {}, W660, [], [], repos);
  const printed = wrappedTestCommand(W660, BRACE, "pnpm lint");
  assert.equal(printed, `${W660} sh -c '${BRACE} && pnpm lint'`);
  assert.equal(spawnSync("sh", ["-n", "-c", printed]).status, 0, "printed command is valid shell");
  assert.ok(rules.includes(`Bash(${printed})`), rules.join("\n"));
  assert.ok(rules.includes(`Bash(${W660} --no-wait sh -c '${BRACE} && pnpm lint')`));
  assert.ok(allowed(rules, printed));
  // Only the container form and the sh -c lines hold the group; no split-up segment rules.
  const withBrace = rules.filter((r) => r.includes("}"));
  assert.deepEqual(withBrace, [
    `Bash(docker exec feat-svc sh -c '${BRACE}')`,
    `Bash(${printed})`,
    `Bash(${W660} --no-wait sh -c '${BRACE} && pnpm lint')`,
  ]);
});

test("SW-660: a ' in a non-plain test command survives the sh -c quoting", async () => {
  const { spawnSync } = await import("node:child_process");
  const { wrappedTestCommand } = await import("./dist/archetypes.js");
  const cmd = "printf '%s' a || true";
  const printed = wrappedTestCommand("env", cmd);
  const out = spawnSync("sh", ["-c", printed], { encoding: "utf8" });
  assert.equal(out.stdout, "a");
});

test("SW-660: only services.yaml's commands run through the wrapper; validate: adds nothing", () => {
  const services = {
    svc: { repo: "r", test: "pnpm test" },
    brace: { repo: "r", test: BRACE },
    prose: { repo: "r", validate: "pnpm test" },
  };
  const rules = buildAllowRules("", [], services, {}, W660, [], ["svc", "brace", "prose"]);
  for (const probe of [
    `${W660} rm -rf x`,
    `${W660} node --test x.mjs`,
    `${W660} pnpm test; rm -rf x`,
    `${W660} pnpm test && rm -rf x`,
    `${W660} sh -c 'rm -rf x'`,
    `${W660} --no-wait rm -rf x`,
  ])
    assert.ok(!allowed(rules, probe), probe);
  for (const blanket of [`Bash(${W660}:*)`, `Bash(${W660} *)`, `Bash(${W660} --no-wait:*)`])
    assert.ok(!rules.includes(blanket), blanket);
  assert.ok(!rules.some((r) => r.includes("sh -c:*")), "no sh -c prefix rule");
  assert.deepEqual(
    buildAllowRules("", [], { prose: services.prose }, {}, W660, [], ["prose"]),
    READ_ONLY_GIT_RULES,
  );
});

test("SW-660: the headless wake passes the workspace's rules, lint and sh -c forms included", async () => {
  const { withSandboxHome } = await import("./fixtures.mjs");
  const { claudeSendArgs } = await import("./dist/harness/claude/session.js");
  await withSandboxHome(
    async () => {
      const root = workspace();
      fs.mkdirSync(dotDir(root), { recursive: true });
      fs.writeFileSync(path.join(root, ".env"), "FEATURE=feat\nSERVICES=api,core\n");
      const rules = workspaceAllowRules(root, true);
      const w = path.join(dotDir(root), "bin", "with-temp-home");
      assert.ok(rules.includes(`Bash(${w} sh -c 'pnpm test && pnpm lint')`), rules.join("\n"));
      assert.ok(rules.includes(`Bash(${w} sh -c '${BRACE} && pnpm lint')`), rules.join("\n"));
      const args = claudeSendArgs("hi", null, null, { allow: rules });
      assert.deepEqual(args[args.indexOf("--allowedTools") + 1].split(","), rules);
    },
    {
      services:
        "repos:\n  demo:\n    lint: pnpm lint\n" +
        "services:\n  api:\n    type: library\n    repo: demo\n    path: api\n    test: pnpm test\n" +
        `  core:\n    type: library\n    repo: demo\n    path: core\n    test: "${BRACE}"\n`,
    },
  );
});
