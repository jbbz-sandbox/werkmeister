// The workspace's permissions.allow merge: adds once, keeps the person's rules,
// and removes only what werkmeister recorded adding.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

import { dotDir } from "../dist/config.js";
import {
  AUTONOMOUS_DENY,
  AUTONOMOUS_RULES,
  autonomousRules,
  buildAllowRules,
  READ_ONLY_GIT_RULES,
  removeWorkspacePermissions,
  workspaceAllowRules,
  workspaceAskRules,
  workspaceDenyRules,
  writeWorkspacePermissions,
} from "../dist/harness/claude/hooks_gen.js";

// SW-958: the rules every workspace gets, from the builder, so a test pins what it is about, not this set.
const BASE = buildAllowRules("", [], {}, {});
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
    ["Bash(docker exec feat-svc sh -c 'npm test')", "Bash(npm test:*)", ...BASE],
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
  assert.deepEqual(workspaceAllowRules(workspace()), BASE);
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
  const { strategyById } = await import("../dist/strategies/index.js");
  const root = workspace();
  strategyById("jit").refresh(root);
  const settings = readSettings(root);
  assert.ok(settings.hooks.SessionStart, "JIT SessionStart hook");
  assert.equal(settings.hooks.PreToolUse.length, 3, "standards gate + PR guard + agent state");
  assert.deepEqual(settings.permissions.allow, BASE);
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
    "Bash(werkmeister feature logs feat)",
    "Bash(werkmeister feature logs feat api)",
    "Bash(docker restart feat-api)",
  ])
    assert.ok(rules.includes(r), r);
  // SW-855: `feature test` runs the workspace's own playwright config with the real HOME, so it asks.
  assert.ok(!rules.some((r) => / test feat/.test(r)), "no feature test rule");
  // SW-560: no ad-hoc exec; the container's exact registered test comes from buildAllowRules.
  assert.ok(!rules.some((r) => r.startsWith("Bash(docker exec")), "no docker exec rule");
  assert.deepEqual(autonomousRules("", ["api"]), AUTONOMOUS_RULES);
});

test("autonomous rules reach nothing shared: no blanket command or server, deny covers the shared acts", () => {
  const blanket = /^Bash\((sandbox|werkmeister|w9r|docker|npm|gh|claude|claude plugin):\*\)$/;
  assert.ok(!AUTONOMOUS_RULES.some((r) => blanket.test(r)), "no blanket rule");
  assert.ok(!AUTONOMOUS_RULES.includes("mcp__plugin_werkmeister_werkmeister"), "no whole server");
  assert.ok(!AUTONOMOUS_RULES.some((r) => r.startsWith("Bash(npm install")), "no npm install");
  // SW-649: no fixed install; the repo's exact lockfile one comes from workspaceAllowRules.
  assert.deepEqual(
    AUTONOMOUS_RULES.filter((r) => /^Bash\((npm|pnpm|yarn|uv) (ci|install|i|add|sync)\b/.test(r)),
    [],
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
  // Claude Code's matching: `:*` is a word-boundary prefix, any other `*` a wildcard (probed on 2.1.319); never both in one rule (SW-807).
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
    // SW-649: a repo-less workspace has no lockfile install; the per-repo ones are tested below.
    // SW-626: and no `-C` rule; the per-repo ones are tested there.
    for (const cmd of [
      "git status",
      "git diff",
      "git commit -m x",
      "git commit -m fix config loader",
      "git add config src",
      "git log -1 -- config",
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
      ["init-workspace", "workspace init"],
      ["init-workspace --refresh-issue", "workspace init --refresh-issue"],
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
  // SW-843: no prefix rule on `feature up`; the one-service start (SW-132) is exact per service.
  const featureUp = autonomousRules("feat", ["api"]).filter((r) => r.includes(" feature up"));
  assert.ok(
    featureUp.every((r) => !r.endsWith(":*)")),
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
  const { strategyById } = await import("../dist/strategies/index.js");
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
  // SW-828: a workspace without a built CLI has no asks by default, and an empty list writes no key.
  const ask = workspaceAskRules(root);
  assert.deepEqual(ask, []);
  // SW-807: an icm refresh keeps the stage grants once autonomous is off.
  const allow = workspaceAllowRules(root, false);
  const deny = workspaceDenyRules(root, false);
  assert.deepEqual(settings.permissions, { allow: ["Bash(git:*)", ...allow], deny });
  assert.deepEqual(readRecord(root), { allow, deny });
});

// The rules before narrowing, as a record from an earlier release holds them.
test("a refresh replaces the old broad autonomous rules recorded earlier", async () => {
  const { strategyById } = await import("../dist/strategies/index.js");
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
  const { buildSandboxContextMd } = await import("../dist/harness/claude/claude_md.js");
  const { loadServices } = await import("../dist/config.js");
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
      const generic = named.map((r) =>
        r.replace("<worktree>", "/ws/w/demo").replace("<test command>", "pnpm test"),
      );
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

// SW-835: a hand `jq 'del(.permissions.ask)'` leaves the record; the next write puts the block back.
test("a rewrite after the ask block was deleted restores it from the record (SW-835)", () => {
  const root = workspace({});
  writeWorkspacePermissions(root, ["a"], [], ["q", "r"]);
  const settings = readSettings(root);
  delete settings.permissions.ask;
  fs.writeFileSync(settingsPath(root), JSON.stringify(settings, null, 2));
  writeWorkspacePermissions(root, ["a"], [], ["q", "r"]);
  assert.deepEqual(readSettings(root).permissions, { allow: ["a"], ask: ["q", "r"] });
  assert.deepEqual(readRecord(root), { allow: ["a"], ask: ["q", "r"] });
});

test("node --test through the temp-HOME wrapper asks when turned on, every form, never allowed (SW-510, SW-720)", () => {
  const w = "/ws/w/.werkmeister/bin/with-temp-home";
  const cli = "/ws/w/werkmeister/apps/cli/werkmeister";
  const forms = [
    `Bash(${w} env WERKMEISTER_ROOT=* node --test*)`,
    `Bash(${w} --no-wait env WERKMEISTER_ROOT=* node --test*)`,
    `Bash(${w} node --test*)`,
    `Bash(${w} --no-wait node --test*)`,
    `Bash(docker exec * ${w} node --test*)`,
    `Bash(docker exec * ${w} --no-wait node --test*)`,
  ];
  const allow = buildAllowRules("feat", ["svc"], { svc: { test: "npm test" } }, {}, w, [cli]);
  assert.ok(!allow.some((r) => r.includes("node --test")), allow.join("\n"));
  const root = workspace();
  const bin = path.join(dotDir(root), "bin");
  assert.deepEqual(
    withConfig("workspace_ask_rules: true\n", () => workspaceAskRules(root)),
    forms.map((r) => r.replaceAll("/ws/w/.werkmeister/bin", bin)),
  );
});

test("--exec-runs forms of the fixture wrapper and built CLI ask, host and container; none without a built CLI (SW-473, SW-828)", () => {
  const root = workspace();
  assert.deepEqual(workspaceAskRules(root), []);
  const cli = path.join(root, "werkmeister", "apps", "cli");
  fs.mkdirSync(cli, { recursive: true });
  fs.mkdirSync(path.join(root, "werkmeister", ".git"));
  fs.writeFileSync(path.join(cli, "werkmeister"), "");
  const bin = path.join(dotDir(root), "bin");
  assert.deepEqual(workspaceAskRules(root), [
    `Bash(${bin}/with-fixture-workspace --exec-runs:*)`,
    `Bash(${bin}/with-fixture-workspace --no-wait --exec-runs:*)`,
    `Bash(docker exec * ${bin}/with-fixture-workspace --exec-runs*)`,
    `Bash(docker exec * ${bin}/with-fixture-workspace --no-wait --exec-runs*)`,
    `Bash(${bin}/with-temp-home ${cli}/werkmeister internal fixture --exec-runs:*)`,
    `Bash(${bin}/with-temp-home --no-wait ${cli}/werkmeister internal fixture --exec-runs:*)`,
    "Bash(werkmeister internal branch-cli:*)",
    "Bash(w9r internal branch-cli:*)",
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

// SW-688: the container may hold the Docker socket and the real ~/.werkmeister, so the lint-joined line asks.
test("SW-688: the lint-joined container test line is not pre-approved; the bare test rule is unchanged", () => {
  const services = { svc: { repo: "r", test: "pnpm test" } };
  const rules = buildAllowRules("feat", ["svc"], services, {}, "", [], [], {
    r: { lint: "pnpm lint" },
  });
  assert.ok(rules.includes("Bash(docker exec feat-svc sh -c 'pnpm test')"), rules.join("\n"));
  assert.ok(!rules.some((r) => r.includes("pnpm lint")), rules.join("\n"));
});

test("SW-660: the repo's lint the context file joins is allowed with the test, all under the temp HOME", async () => {
  const { wrappedTestCommand } = await import("../dist/archetypes.js");
  const services = { svc: { repo: "r", test: "pnpm test" } };
  const repos = { r: { lint: "pnpm lint && pnpm run docs:check" } };
  const rules = buildAllowRules("", [], services, {}, W660, [], ["svc"], repos);
  const printed = wrappedTestCommand(W660, "pnpm test", repos.r.lint, "r");
  assert.equal(
    printed,
    `${W660} --cwd /ws/w/r sh -c 'pnpm lint && pnpm run docs:check && pnpm test'`,
  );
  assert.ok(allowed(rules, printed), rules.join("\n"));
  assert.ok(
    allowed(
      rules,
      `${W660} --no-wait --cwd /ws/w/r sh -c 'pnpm lint && pnpm run docs:check && pnpm test'`,
    ),
  );
  assert.ok(!allowed(rules, `${printed} && rm -rf x`), "nothing rides after the quote");
  assert.ok(!rules.some((r) => r.startsWith("Bash(pnpm ")), "no unwrapped lint rule");
});

// SW-652: a test command runs from its repo's worktree; the shell's cwd drifts, and a `cd` would lose this rule.
test("SW-652: the wrapped test command runs from its repo's worktree via --cwd, printed and allowed alike", async () => {
  const { wrappedTestCommand } = await import("../dist/archetypes.js");
  const services = { svc: { repo: "r", test: "pnpm test" }, chain: { repo: "r", test: "a && b" } };
  const rules = buildAllowRules("", [], services, {}, W660, [], ["svc", "chain"]);
  const simple = wrappedTestCommand(W660, "pnpm test", undefined, "r");
  assert.equal(simple, `${W660} --cwd /ws/w/r pnpm test`);
  const chained = wrappedTestCommand(W660, "a && b", undefined, "r");
  assert.equal(chained, `${W660} --cwd /ws/w/r sh -c 'a && b'`);
  for (const cmd of [simple, chained]) {
    assert.ok(allowed(rules, cmd), `${cmd}\n${rules.join("\n")}`);
    assert.ok(allowed(rules, cmd.replace(`${W660} `, `${W660} --no-wait `)), `--no-wait ${cmd}`);
    assert.ok(!/(^|\s)cd\s/.test(cmd), "no cd");
  }
  assert.ok(!allowed(rules, `${W660} --cwd /elsewhere pnpm test`), "only the worktree's --cwd");
  assert.ok(rules.includes(`Bash(${chained})`), "the sh -c line stays an exact rule past --cwd");
  assert.ok(!allowed(rules, `${chained} ; rm -rf x`), "nothing rides after the quote");
  // No repo, no worktree to name: the command runs where it is, as before.
  assert.equal(wrappedTestCommand(W660, "pnpm test"), `${W660} pnpm test`);
});

test("SW-660: a { …; } / || test command is printed and allowed as one exact sh -c line that parses", async () => {
  const { spawnSync } = await import("node:child_process");
  const { wrappedTestCommand } = await import("../dist/archetypes.js");
  const services = { svc: { repo: "r", test: BRACE } };
  const repos = { r: { lint: "pnpm lint" } };
  const rules = buildAllowRules("feat", ["svc"], services, {}, W660, [], [], repos);
  const printed = wrappedTestCommand(W660, BRACE, "pnpm lint", "r");
  assert.equal(printed, `${W660} --cwd /ws/w/r sh -c 'pnpm lint && ${BRACE}'`);
  assert.equal(spawnSync("sh", ["-n", "-c", printed]).status, 0, "printed command is valid shell");
  assert.ok(rules.includes(`Bash(${printed})`), rules.join("\n"));
  assert.ok(rules.includes(`Bash(${W660} --no-wait --cwd /ws/w/r sh -c 'pnpm lint && ${BRACE}')`));
  assert.ok(allowed(rules, printed));
  // Only the container form and the sh -c lines hold the group; no split-up segment rules.
  const withBrace = rules.filter((r) => r.includes("}"));
  assert.deepEqual(withBrace, [
    `Bash(docker exec feat-svc sh -c '${BRACE}')`,
    `Bash(${printed})`,
    `Bash(${W660} --no-wait --cwd /ws/w/r sh -c 'pnpm lint && ${BRACE}')`,
  ]);
});

test("SW-660: a ' in a non-plain test command survives the sh -c quoting", async () => {
  const { spawnSync } = await import("node:child_process");
  const { wrappedTestCommand } = await import("../dist/archetypes.js");
  const cmd = "printf '%s' a || true";
  const printed = wrappedTestCommand("env", cmd);
  const out = spawnSync("sh", ["-c", printed], { encoding: "utf8" });
  assert.equal(out.stdout, "a");
});

// SW-721: the container form quotes like wrappedTestCommand, so the line and its allow rule run the registered command.
test("SW-721: a ' in a test command survives the docker exec sh -c quoting", async () => {
  const { spawnSync } = await import("node:child_process");
  const { containerTestCommand } = await import("../dist/archetypes.js");
  const printed = containerTestCommand("feat", "api", "printf '%s' 'a b'");
  assert.equal(printed, `docker exec feat-api sh -c 'printf '\\''%s'\\'' '\\''a b'\\'''`);
  // The part after `docker exec feat-api` is what the container's sh gets.
  const out = spawnSync("sh", ["-c", printed.replace(/^docker exec feat-api /, "")], {
    encoding: "utf8",
  });
  assert.equal(out.stdout, "a b");
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
    BASE,
  );
});

test("SW-660: the headless wake passes the workspace's rules, lint and sh -c forms included", async () => {
  const { withSandboxHome } = await import("./fixtures.mjs");
  const { claudeSendArgs } = await import("../dist/harness/claude/session.js");
  await withSandboxHome(
    async () => {
      const root = workspace();
      fs.mkdirSync(dotDir(root), { recursive: true });
      fs.writeFileSync(path.join(root, ".env"), "FEATURE=feat\nSERVICES=api,core\n");
      const rules = workspaceAllowRules(root, true);
      const w = path.join(dotDir(root), "bin", "with-temp-home");
      assert.ok(
        rules.includes(
          `Bash(${w} --cwd ${path.join(root, "demo")} sh -c 'pnpm lint && pnpm test')`,
        ),
        rules.join("\n"),
      );
      assert.ok(
        rules.includes(`Bash(${w} --cwd ${path.join(root, "demo")} sh -c 'pnpm lint && ${BRACE}')`),
        rules.join("\n"),
      );
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

test("SW-649: an autonomous workspace pre-approves each repo's own frozen install, nothing else", async () => {
  const { withSandboxHome } = await import("./fixtures.mjs");
  const INSTALLS = /^Bash\((npm|pnpm|yarn|uv) /;
  // *main*: files in the repo's checkout under repos_root; *worktree*: files only the agent wrote.
  const installs = (main, { worktree = [], on = true } = {}) => {
    const reposRoot = fs.mkdtempSync(path.join(os.tmpdir(), "repos-root-"));
    fs.mkdirSync(path.join(reposRoot, "app"));
    for (const f of main) fs.writeFileSync(path.join(reposRoot, "app", f), "");
    return withSandboxHome(
      () => {
        const root = workspace();
        fs.mkdirSync(path.join(root, "app", ".git"), { recursive: true });
        for (const f of worktree) fs.writeFileSync(path.join(root, "app", f), "");
        return workspaceAllowRules(root, on).filter((r) => INSTALLS.test(r));
      },
      { config: `paths:\n  repos_root: ${reposRoot}\n` },
    );
  };
  assert.deepEqual(await installs(["yarn.lock"]), ["Bash(yarn install --frozen-lockfile)"]);
  assert.deepEqual(await installs(["yarn.lock", ".yarnrc.yml"]), [
    "Bash(yarn install --immutable)",
  ]);
  assert.deepEqual(await installs(["uv.lock"]), ["Bash(uv sync --frozen)"]);
  assert.deepEqual(await installs(["pnpm-lock.yaml"]), ["Bash(pnpm install --frozen-lockfile)"]);
  assert.deepEqual(await installs(["requirements.txt"]), []);
  assert.deepEqual(await installs(["pnpm-lock.yaml"], { on: false }), [], "autonomous only");
  assert.deepEqual(
    await installs([], { worktree: ["yarn.lock", ".yarnrc.yml"] }),
    [],
    "a lockfile only the worktree holds grants nothing",
  );
});

test("SW-807: no generated rule puts a * before a :* suffix, which Claude Code reads literally", async () => {
  // Claude Code: `:*` is allowed only as the suffix, and with it any other `*` is a literal (warned at start).
  const bad = (r) => /^Bash\(.*\*.*:\*\)$/.test(r) || /:\*(?!\)$)/.test(r);
  const { withSandboxHome } = await import("./fixtures.mjs");
  await withSandboxHome(
    async () => {
      const root = workspace();
      const cli = path.join(root, "werkmeister", "apps", "cli");
      fs.mkdirSync(cli, { recursive: true });
      fs.mkdirSync(path.join(root, "werkmeister", ".git"));
      fs.writeFileSync(path.join(cli, "werkmeister"), "");
      fs.mkdirSync(dotDir(root), { recursive: true });
      fs.writeFileSync(path.join(root, ".env"), "FEATURE=feat\nSERVICES=api\n");
      fs.writeFileSync(
        path.join(dotDir(root), "workspace.yml"),
        "context_strategy: icm\nwork_type: feature\n",
      );
      for (const rules of [
        workspaceAskRules(root),
        workspaceAllowRules(root, true),
        workspaceAllowRules(root, false),
        AUTONOMOUS_DENY,
      ])
        assert.deepEqual(rules.filter(bad), []);
    },
    {
      services:
        "repos:\n  demo:\n    lint: pnpm lint\n" +
        "services:\n  api:\n    type: library\n    repo: demo\n    path: api\n    test: pnpm test\n",
    },
  );
});

test("SW-807: an ICM run pre-approves only its own issue's start and view, exact; feature, gate and status commands ask", () => {
  const root = workspace();
  fs.mkdirSync(dotDir(root), { recursive: true });
  const yml = (t) => fs.writeFileSync(path.join(dotDir(root), "workspace.yml"), t);
  yml("context_strategy: jit\nwork_type: bugfix\n");
  assert.deepEqual(workspaceAllowRules(root, false), BASE);
  yml('context_strategy: "icm "\nwork_type: bugfix\n');
  // SW-717: pr push refuses anything but the workspace's own clean, merge-free branch with a live lease.
  // SW-963: workspace serve refuses a folder outside the workspace and runs one loopback server line.
  const grants = [
    "issue start",
    "issue view",
    "workspace serve:*",
    "pr push:*",
    "pr autosquash:*",
  ].flatMap((g) => [`Bash(werkmeister ${g})`, `Bash(w9r ${g})`]);
  const interactive = workspaceAllowRules(root, false);
  for (const r of [...BASE, ...grants]) assert.ok(interactive.includes(r), r);
  // Review of SW-807: each of these reaches shared infra, another workspace or the real ~/.werkmeister.
  for (const cmd of [
    "feature up",
    "feature stop",
    "feature restart",
    "pr gate",
    "pr status",
    "pr open",
  ])
    assert.ok(!interactive.some((r) => r.includes(cmd)), cmd);
  const autonomous = workspaceAllowRules(root, true);
  for (const r of grants) assert.ok(autonomous.includes(r), r);
});

// Claude Code's matching: `:*` is a word-boundary prefix, any other rule exact (SW-560's probe).
const claudeAllows = (rules, cmd) =>
  rules.some((r) => {
    const m = /^Bash\((.*?)(:\*)?\)$/.exec(r);
    return m && (m[2] ? cmd === m[1] || cmd.startsWith(`${m[1]} `) : cmd === m[1]);
  });

test("SW-843: `feature up --service` is pre-approved only for this workspace's own feature", async () => {
  // *core* is an on-demand service of the workspace's repos, not in SERVICES.
  const allow = autonomousRules("feat", ["api"], ["core"]);
  for (const name of ["werkmeister", "w9r"]) {
    for (const cmd of [
      "feature up --service api",
      "feature up --service core",
      "feature up feat --service core",
      "feature up feat --service api",
    ])
      assert.ok(claudeAllows(allow, `${name} ${cmd}`), `${name} ${cmd}`);
    for (const cmd of [
      "feature up --service api other",
      "feature up --service core other",
      "feature up --service api -w /Users/x/features/other",
      "feature up other --service api",
      "feature up --service lib",
      "feature up feat --service lib",
      "feature up feat --service api -w /Users/x/features/other",
      "feature up feat --service api other",
    ])
      assert.ok(!claudeAllows(allow, `${name} ${cmd}`), `${name} ${cmd}`);
  }
  const { withSandboxHome } = await import("./fixtures.mjs");
  await withSandboxHome(async () => {
    const root = workspace();
    fs.mkdirSync(dotDir(root), { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "FEATURE=feat\nSERVICES=api\n");
    const rules = workspaceAllowRules(root, true);
    assert.ok(!rules.includes("Bash(werkmeister feature up --service:*)"), "no unpinned rule");
    assert.ok(claudeAllows(rules, "werkmeister feature up --service api"));
    assert.ok(!claudeAllows(rules, "werkmeister feature up --service api other"));
  });
});

test("SW-855: `feature test|logs|services <feature>` take no `-w <other>` or extra arguments", () => {
  const allow = autonomousRules("feat", ["api"]);
  for (const name of ["werkmeister", "w9r"]) {
    for (const verb of ["", "feature "]) {
      for (const cmd of ["logs feat", "logs feat api", "services feat"])
        assert.ok(claudeAllows(allow, `${name} ${verb}${cmd}`), `${name} ${verb}${cmd}`);
      for (const cmd of [
        "test feat",
        "test feat -w /Users/x/features/other --scaffold",
        "test feat -- --config=/tmp/evil.config.js",
        "test feat -- /Users/x/features/other/e2e",
        "logs feat -w /Users/x/features/other",
        "logs feat other",
        "services feat -w /Users/x/features/other",
      ])
        assert.ok(!claudeAllows(allow, `${name} ${verb}${cmd}`), `${name} ${verb}${cmd}`);
    }
  }
});

test("SW-845: no pre-approved container test for a service that mounts the docker socket or the werkmeister home", async () => {
  const { withSandboxHome } = await import("./fixtures.mjs");
  await withSandboxHome(async (home) => {
    const svc = (test, ...extra_volumes) => ({ test, extra_volumes });
    const cfg = {
      plain: svc(
        "pnpm test:plain",
        "tools:/opt/werkmeister-tools",
        "/Users/x/repos:/Users/x/repos",
      ),
      sock: svc("pnpm test:sock", "/var/run/docker.sock:/var/run/docker.sock"),
      run: svc("pnpm test:run", "/var/run:/host-run"),
      wmhome: svc("pnpm test:wmhome", `${home}:${home}`),
      parent: svc("pnpm test:parent", `${path.dirname(home)}:/h:ro`),
    };
    const rules = buildAllowRules("feat", Object.keys(cfg), cfg, {});
    assert.deepEqual(
      rules.filter((r) => r.startsWith("Bash(docker exec")),
      ["Bash(docker exec feat-plain sh -c 'pnpm test:plain')"],
    );
    for (const name of ["sock", "run", "wmhome", "parent"])
      assert.ok(!rules.includes(`Bash(pnpm test:${name}:*)`), name);
    // Other spellings of a socket: OrbStack's, and /var/run through a symlinked parent.
    const link = fs.mkdtempSync(path.join(os.tmpdir(), "sock-link-"));
    fs.symlinkSync("/var/run", path.join(link, "run"));
    const aliases = {
      orb: svc("pnpm test:orb", "/Users/x/.orbstack/run/docker.sock:/var/run/docker.sock"),
      linked: svc("pnpm test:linked", `${link}/run:/host-run`),
    };
    assert.deepEqual(
      buildAllowRules("feat", Object.keys(aliases), aliases, {}).filter((r) =>
        r.startsWith("Bash(docker exec"),
      ),
      [],
    );
  });
});

test("SW-845: a socket added by the branch's fragment or a dev_link also drops the container rule", async () => {
  const { withSandboxHome } = await import("./fixtures.mjs");
  const registry =
    "services:\n  api:\n    type: library\n    repo: demo\n    path: api\n    test: pnpm test\n  web:\n    type: library\n    repo: demo\n    path: web\n    test: pnpm test:web\n";
  await withSandboxHome(
    async () => {
      const root = workspace();
      fs.mkdirSync(dotDir(root), { recursive: true });
      fs.writeFileSync(path.join(root, ".env"), "FEATURE=feat\nSERVICES=api,web\n");
      const execRules = () =>
        workspaceAllowRules(root, true).filter((r) => r.startsWith("Bash(docker exec"));
      assert.equal(execRules().length, 2, "both pre-approved before any edit");
      // dev_links in workspace.yml, with a variable generate.ts substitutes.
      fs.writeFileSync(
        path.join(dotDir(root), "workspace.yml"),
        "dev_links:\n  web:\n    - ${WORKSPACE}/../../../../../../../../var/run/docker.sock:/var/run/docker.sock\n",
      );
      assert.deepEqual(execRules(), ["Bash(docker exec feat-api sh -c 'pnpm test')"]);
      // The worktree's own fragment, which compose merges over the registry.
      const wt = path.join(root, "demo");
      fs.mkdirSync(path.join(wt, ".git"), { recursive: true });
      fs.mkdirSync(path.join(wt, ".werkmeister"));
      fs.writeFileSync(
        path.join(wt, ".werkmeister", "services.yaml"),
        "services:\n  api:\n    type: library\n    path: api\n    test: pnpm test\n    extra_volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
      );
      assert.deepEqual(execRules(), []);
    },
    { services: registry },
  );
});

// SW-842, SW-828: the machine opt-in. Only the YAML boolean turns the node --test asks on.
function withConfig(yaml, fn) {
  const saved = process.env.WERKMEISTER_CONFIG_FILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-cfg-"));
  const file = path.join(dir, "config.yaml");
  if (yaml !== null) fs.writeFileSync(file, yaml);
  process.env.WERKMEISTER_CONFIG_FILE = file;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.WERKMEISTER_CONFIG_FILE;
    else process.env.WERKMEISTER_CONFIG_FILE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("only workspace_ask_rules: true adds the node --test asks; absent, false, a string or bad YAML adds none; --exec-runs always (SW-842, SW-828)", () => {
  const root = workspace();
  assert.equal(withConfig("workspace_ask_rules: true\n", () => workspaceAskRules(root)).length, 6);
  for (const yaml of [
    null,
    "workspace_ask_rules: false\n",
    'workspace_ask_rules: "true"\n',
    "{{bad",
  ]) {
    assert.deepEqual(
      withConfig(yaml, () => workspaceAskRules(root)),
      [],
      String(yaml),
    );
  }
  const cli = path.join(root, "werkmeister", "apps", "cli");
  fs.mkdirSync(cli, { recursive: true });
  fs.mkdirSync(path.join(root, "werkmeister", ".git"));
  fs.writeFileSync(path.join(cli, "werkmeister"), "");
  const off = withConfig(null, () => workspaceAskRules(root));
  assert.equal(off.length, 8);
  assert.ok(
    off.every((r) => r.includes("--exec-runs") || r.includes("internal branch-cli")),
    off.join("\n"),
  );
});

test("turning the asks off drops the ones werkmeister wrote and keeps the person's (SW-842)", () => {
  const root = workspace({});
  withConfig("workspace_ask_rules: true\n", () =>
    writeWorkspacePermissions(root, ["a"], [], workspaceAskRules(root)),
  );
  const settings = readSettings(root);
  settings.permissions.ask.push("mine");
  fs.writeFileSync(settingsPath(root), JSON.stringify(settings, null, 2));
  withConfig(null, () => writeWorkspacePermissions(root, ["a"], [], workspaceAskRules(root)));
  assert.deepEqual(readSettings(root).permissions, { allow: ["a"], ask: ["mine"] });
  assert.deepEqual(readRecord(root), { allow: ["a"] });
});

test("off, a rewrite after the ask block was deleted does not restore it (SW-842, SW-835)", () => {
  const root = workspace({});
  withConfig("workspace_ask_rules: true\n", () =>
    writeWorkspacePermissions(root, ["a"], [], workspaceAskRules(root)),
  );
  const settings = readSettings(root);
  delete settings.permissions.ask;
  fs.writeFileSync(settingsPath(root), JSON.stringify(settings, null, 2));
  withConfig(null, () => writeWorkspacePermissions(root, ["a"], [], workspaceAskRules(root)));
  assert.deepEqual(readSettings(root).permissions, { allow: ["a"] });
});

test("SW-815: an autonomous run may file a follow-up related to its own issue, nothing wider", () => {
  const withIssue = (id) => {
    const root = workspace();
    fs.mkdirSync(path.join(root, ".werkmeister"));
    fs.writeFileSync(path.join(root, ".werkmeister", "workspace.yml"), `issue_id: "${id}"\n`);
    return root;
  };
  const rules = workspaceAllowRules(withIssue("SW-855"), true);
  assert.ok(rules.includes("Bash(werkmeister issue create --relates SW-855:*)"));
  assert.ok(
    !rules.some((r) => /issue create(?! --relates SW-855:)/.test(r)),
    "no bare issue create",
  );
  assert.ok(
    !workspaceAllowRules(withIssue("SW-855"), false).some((r) => r.includes("issue create")),
  );
  // Not a Jira key: no rule (a `*` or space in it would widen the prefix).
  assert.ok(
    !workspaceAllowRules(withIssue("SW-855 *"), true).some((r) => r.includes("issue create")),
  );
});

test("SW-854: no pre-approved start or restart for a host-mounted service", () => {
  const allow = autonomousRules("feat", ["api", "dash"], ["core"], ["dash", "core"]);
  for (const cmd of [
    "werkmeister feature up --service api",
    "w9r feature up feat --service api",
    "docker restart feat-api",
    "docker logs feat-dash",
  ])
    assert.ok(claudeAllows(allow, cmd), cmd);
  for (const cmd of [
    "werkmeister feature up --service dash",
    "werkmeister feature up feat --service core",
    "docker restart feat-dash",
    // A whole-feature start runs every selected service, the host-mounted one too.
    "werkmeister feature up",
    "werkmeister feature up feat",
    "w9r restart feat",
  ])
    assert.ok(!claudeAllows(allow, cmd), cmd);
  assert.ok(
    claudeAllows(
      autonomousRules("feat", ["api"], ["core"], ["core"]),
      "werkmeister feature up feat",
    ),
  );
});

test("SW-854: the registry's unattended_start keeps a host-mounted service's start rules; the branch can't grant it", async () => {
  const { withSandboxHome } = await import("./fixtures.mjs");
  const mounted = (extra = "") => `    test: npm test
    extra_volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
${extra}`;
  await withSandboxHome(
    async () => {
      const root = workspace();
      fs.mkdirSync(dotDir(root), { recursive: true });
      fs.writeFileSync(path.join(root, ".env"), "FEATURE=feat\nSERVICES=core,dash\n");
      // A branch fragment saying the same counts for nothing.
      fs.mkdirSync(path.join(root, "repo", ".werkmeister"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "repo", ".werkmeister", "services.yaml"),
        'services:\n  dash:\n    unattended_start: "trust me"\n',
      );
      const rules = workspaceAllowRules(root, true);
      assert.ok(claudeAllows(rules, "werkmeister feature up --service core"));
      assert.ok(claudeAllows(rules, "docker restart feat-core"));
      assert.ok(!claudeAllows(rules, "werkmeister feature up --service dash"));
      assert.ok(!claudeAllows(rules, "docker restart feat-dash"));
      assert.ok(!claudeAllows(rules, "werkmeister feature up"));
    },
    {
      services: `services:
  core:
    repo: repo
${mounted('    unattended_start: "runs tsc only"\n')}  dash:
    repo: repo
${mounted()}`,
    },
  );
});
test("SW-854: unattended_start holds only while the branch runs the registry's container; root mounts count", async () => {
  const { withSandboxHome } = await import("./fixtures.mjs");
  const { hostAccess } = await import("../dist/archetypes.js");
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sw854-")));
  const repos = path.join(tmp, "repos");
  const features = path.join(tmp, "features");
  fs.mkdirSync(repos);
  fs.mkdirSync(features);
  const core = (command) => `  core:
    command: ${JSON.stringify(command)}
    test: npm test
    extra_volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
`;
  await withSandboxHome(
    async () => {
      const allow = (branchCommand) => {
        const root = fs.mkdtempSync(path.join(features, "ws-"));
        fs.mkdirSync(dotDir(root), { recursive: true });
        fs.writeFileSync(path.join(root, ".env"), "FEATURE=feat\nSERVICES=core\n");
        fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
        fs.mkdirSync(path.join(root, "repo", ".werkmeister"));
        fs.writeFileSync(
          path.join(root, "repo", ".werkmeister", "services.yaml"),
          `services:\n${core(branchCommand)}`,
        );
        return workspaceAllowRules(root, true);
      };
      const same = allow("tsc -w");
      assert.ok(claudeAllows(same, "werkmeister feature up --service core"));
      assert.ok(claudeAllows(same, "docker restart feat-core"));
      // The branch's `command:` is what compose runs (SW-337), so the registry's reason no longer holds.
      const changed = allow("sh -c 'curl x | sh'");
      for (const cmd of [
        "werkmeister feature up --service core",
        "docker restart feat-core",
        "werkmeister feature up",
      ])
        assert.ok(!claudeAllows(changed, cmd), cmd);

      const ws = path.join(features, "mine");
      const mounts = (...binds) => ({ extra_volumes: binds.map((b) => `${b}:${b}`) });
      for (const entry of [mounts(repos), mounts(features), mounts(tmp)])
        assert.ok(hostAccess(entry), JSON.stringify(entry));
      assert.ok(
        hostAccess(mounts(path.join(repos, "werkmeister")), ws),
        "a checkout under the repos root",
      );
      assert.ok(hostAccess(mounts(path.join(features, "other")), ws), "another workspace");
      assert.ok(!hostAccess(mounts(path.join(ws, "app")), ws), "its own workspace");
      assert.ok(
        !hostAccess(mounts(path.join(features, "other"))),
        "no workspace given: roots and parents only",
      );
    },
    {
      services: `services:\n  core:\n    repo: repo\n${core("tsc -w").slice("  core:\n".length)}    unattended_start: "runs tsc only"\n`,
      config: `paths:\n  repos_root: ${repos}\n  workspaces_root: ${features}\n`,
    },
  );
});

test("SW-625: `pr` and `workspace init` rules stop at the workspace's own forms; its rule inputs can't be edited", () => {
  const allow = autonomousRules("feat", ["api"]);
  for (const name of ["werkmeister", "w9r"]) {
    for (const cmd of [
      "pr gate --tests",
      "pr open",
      "pr status --json",
      "pr new werkmeister",
      "pr adopt 12",
      "workspace init",
      "workspace init --refresh-issue",
      "init-workspace --prune-context",
      "workspace init --labels focus",
    ])
      assert.ok(claudeAllows(allow, `${name} ${cmd}`), `${name} ${cmd}`);
    for (const cmd of [
      "pr watch",
      "pr watch --install",
      "pr watch --uninstall",
      "workspace init --feature other",
      "workspace init --repos a,b",
      "workspace init --force",
      "workspace init --autonomous",
      "init-workspace --feature other",
      "workspace init --refresh-issue --feature other",
    ])
      assert.ok(!claudeAllows(allow, `${name} ${cmd}`), `${name} ${cmd}`);
  }
  for (const f of [".env*", ".werkmeister/workspace.yml", ".werkmeister/claude-permissions.json"])
    assert.ok(AUTONOMOUS_DENY.includes(`Edit(/${f})`), f);
  // The gate's logs land in .werkmeister/ by redirect, so the folder itself stays writable.
  assert.ok(!AUTONOMOUS_DENY.includes("Edit(/.werkmeister/**)"));
});

// A deny rule's `*` matches any run of characters; `:*` at the end is a word-boundary prefix.
const claudeDenies = (rules, cmd) =>
  rules.some((r) => {
    const m = /^Bash\((.*?)(:\*)?\)$/.exec(r);
    if (!m) return false;
    if (m[2]) return cmd === m[1] || cmd.startsWith(`${m[1]} `);
    const re = m[1].split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${re.join(".*")}$`).test(cmd);
  });

test("SW-828: the core fast route asks under no generated rule; the container --exec-runs form does", () => {
  const root = workspace();
  const cli = path.join(root, "werkmeister", "apps", "cli");
  fs.mkdirSync(cli, { recursive: true });
  fs.mkdirSync(path.join(root, "werkmeister", ".git"));
  fs.writeFileSync(path.join(cli, "werkmeister"), "");
  const bin = path.join(dotDir(root), "bin");
  const ask = workspaceAskRules(root);
  // Claude Code asks when any part of a compound line matches an ask rule.
  const asks = (cmd) => cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).some((p) => claudeDenies(ask, p));
  const core = "docker exec -w /app/packages/werkmeister-core feat-werkmeister-core";
  const fast = `${core} ${bin}/with-temp-home --no-wait node --test test/a.test.mjs`;
  for (const cmd of [
    fast,
    `${core} ${bin}/with-temp-home --no-wait node --test --test-name-pattern=x test/a.test.mjs`,
    `${core} ${bin}/with-temp-home node --test test/a.test.mjs`,
    `${core} ${bin}/with-temp-home --no-wait pnpm run build && ${fast}`,
    `${fast} | grep -c ok`,
  ])
    assert.ok(!asks(cmd), cmd);
  for (const cmd of [
    `docker exec -w /app feat-werkmeister-core ${bin}/with-fixture-workspace --exec-runs feature up`,
    `docker exec -w /app feat-werkmeister-core ${bin}/with-fixture-workspace --no-wait --exec-runs feature up`,
    `${bin}/with-fixture-workspace --exec-runs feature up`,
    `${bin}/with-temp-home ${cli}/werkmeister internal fixture --exec-runs x`,
  ])
    assert.ok(asks(cmd), cmd);
});

test("SW-626: git is an allow-list; `-C` reaches only the workspace's own repos", async () => {
  const { withSandboxHome } = await import("./fixtures.mjs");
  await withSandboxHome(async () => {
    const root = workspace();
    fs.mkdirSync(dotDir(root), { recursive: true });
    fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "FEATURE=feat\n");
    const repo = path.join(root, "repo");
    const allow = workspaceAllowRules(root, true);
    assert.ok(!allow.includes("Bash(git:*)"), "no blanket git rule");
    for (const cmd of [
      "git status",
      "git diff origin/main...HEAD -- src",
      "git log --oneline -5",
      "git add stages/01_reproduce/output/repro.md",
      'git commit -q -m "SW-626 fix"',
      "git fetch origin main",
      "git fetch",
      "git remote -v",
      "git remote get-url origin",
      "git rebase origin/main",
      "git rebase --continue",
      `git -C ${repo} status --short`,
      `git -C ${repo} rebase origin/main`,
      "git -C repo log --oneline HEAD..origin/main",
      "git worktree list",
    ])
      assert.ok(claudeAllows(allow, cmd), cmd);
    for (const cmd of [
      "git rebase -x 'sh evil.sh' origin/main",
      "git rebase origin/main -x 'sh evil.sh'",
      "git bisect run sh evil.sh",
      "git submodule foreach sh evil.sh",
      "git difftool -x evil HEAD",
      "git push origin HEAD",
      "git init sub",
      "git clone /x y",
      "git worktree add ../x",
      "git stash",
      "git -C /Users/x/features/other reset --hard",
      "git -C /Users/x/features/other status",
      `git -C ${repo} -c alias.x=!sh x`,
      `git -C ${repo}/../../other status`,
      "git --work-tree=/x status",
      // Review of SW-626: fetch takes any URL or `--upl=<cmd>`, `remote -v` dispatches add/set-url, grep -O runs a pager.
      "git fetch /Users/x/features/other/repo",
      "git fetch --upl='touch m' .",
      "git remote -v add evil https://x/y.git",
      "git remote -v set-url origin https://x/y.git",
      "git grep -lO'touch m' a",
      "git grep --open='touch m' a",
    ])
      assert.ok(!claudeAllows(allow, cmd), cmd);
  });
  // `--output` writes any path, `--no-index` reads any; git takes no abbreviation of either.
  for (const cmd of [
    "git log -1 --format=tformat:FEATURE=other --output=.env",
    "git -C /ws/repo show HEAD --output=/Users/x/.werkmeister/services.local.yaml",
    "git diff --output=x",
    "git diff --no-index /dev/null /Users/x/.werkmeister/config.yaml",
    "git -C /ws/repo diff --no-index a b",
  ])
    assert.ok(claudeDenies(AUTONOMOUS_DENY, cmd), cmd);
  assert.ok(
    AUTONOMOUS_DENY.includes("Edit(/.git/**)") && AUTONOMOUS_DENY.includes("Edit(/**/.git/**)"),
  );
  for (const cmd of ['git commit -m "fix config"', "git diff HEAD~1", "git log -p"])
    assert.ok(!claudeDenies(AUTONOMOUS_DENY, cmd), cmd);
});

// SW-893: a commit rule that reads no file. git refuses -m beside -F/--file/-c/-C, and --fixup beside -F
// (git 2.53 probe); `--amend --no-edit` and `--squash` take -F, so they are exact or absent.
// SW-912: an interactive workspace gets the same commit rules, so a commit never rests on the classifier.
test("SW-893, SW-912: git commit takes its message on the line, in both modes, own repos only", async () => {
  const { withSandboxHome } = await import("./fixtures.mjs");
  await withSandboxHome(async () => {
    const root = workspace();
    fs.mkdirSync(dotDir(root), { recursive: true });
    fs.mkdirSync(path.join(root, "repo", ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".env"), "FEATURE=feat\n");
    const repo = path.join(root, "repo");
    for (const autonomous of [true, false]) {
      const allow = workspaceAllowRules(root, autonomous);
      for (const cmd of [
        'git commit -q -m "SW-893 fix"',
        'git commit -qm "SW-893 fix"',
        'git commit -m "SW-893 fix"',
        'git commit --amend -m "SW-893 fix"',
        "git commit --amend --no-edit",
        "git commit --fixup abc123",
        `git -C ${repo} commit -qm "SW-912 fix"`,
        'git -C repo commit -m "SW-912 fix"',
      ])
        assert.ok(claudeAllows(allow, cmd), `autonomous=${autonomous}: ${cmd}`);
      for (const cmd of [
        "git commit -F /Users/x/.werkmeister/config.yaml",
        "git commit -aF /Users/x/.werkmeister/config.yaml",
        "git commit --file=/Users/x/.werkmeister/config.yaml",
        "git commit --amend --no-edit -F /Users/x/.werkmeister/config.yaml",
        "git commit --squash HEAD -F /Users/x/.werkmeister/config.yaml",
        'git -C /Users/x/features/other commit -m "x"',
      ])
        assert.ok(!claudeAllows(allow, cmd), `autonomous=${autonomous}: ${cmd}`);
    }
  });
  // It prints the file's lines in its error: `pathspec 'SECRET' did not match`.
  for (const cmd of [
    'git commit -m "x" --pathspec-from-file=/Users/x/.ssh/id_rsa',
    "git add --pathspec-from-file=/Users/x/.ssh/id_rsa",
    "git -C /ws/repo restore --pathspec-fr=/Users/x/.ssh/id_rsa",
  ])
    for (const deny of [AUTONOMOUS_DENY, workspaceDenyRules("/ws", false)])
      assert.ok(claudeDenies(deny, cmd), cmd);
});

// SW-963: sw-961 ran the contract's `python3 … http.server` for its browser check and AUTONOMOUS_DENY's
// `Bash(python3:*)` refused it; with no allow rule an interactive run asks too.
test("SW-963: the ICM contract's static-page command is allowed in either mode and no deny rule catches it", async () => {
  const { templateFor } = await import("../dist/strategies/icm_templates.js");
  const root = workspace();
  fs.mkdirSync(dotDir(root), { recursive: true });
  fs.writeFileSync(
    path.join(dotDir(root), "workspace.yml"),
    "context_strategy: icm\nwork_type: bugfix\n",
  );
  const vars = {
    at: (n) => `../${n}`,
    repos: "`../../app`",
    restart: "`docker restart feat-app`",
    standards: "",
    autonomous: false,
    group: [],
  };
  const text = templateFor("bugfix")
    .flatMap((s) => s.contract(vars).process)
    .join("\n");
  const cmd = /run `([^`]*<dir>[^`]*)` as a background Bash job/.exec(text)?.[1];
  assert.ok(cmd, "the contract names one static-page command");
  const run = cmd.replace("<dir>", "stages");
  for (const autonomous of [false, true]) {
    assert.ok(claudeAllows(workspaceAllowRules(root, autonomous), run), `${run} (${autonomous})`);
    assert.ok(!claudeDenies(workspaceDenyRules(root, autonomous), run), `${run} (${autonomous})`);
  }
});
