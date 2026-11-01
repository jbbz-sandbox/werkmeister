// `werkmeister machine migrate` (SW-92) against a temp HOME holding a legacy ~/.sandbox
// tree: the move, every file that carried the old absolute path, a second run that
// changes nothing, and each refusal leaving the tree untouched. Docker and
// launchctl are stubbed at the options seam; nothing reaches the real home.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const { migrate } = await import("./dist/migrate.js");
const { installPrWatchSchedule } = await import("./dist/machine_setup.js");

const REAL_HOME = os.homedir();
let home;
let legacy;
let target;
let features;
let calls;
let savedEnv;

const prWatch = () => ({
  platform: "darwin",
  wrapper: "/opt/werkmeister/werkmeister",
  pathEnv: "/usr/bin:/bin",
  uid: 501,
  runner: (argv) => {
    calls.push(argv.join(" "));
    return [0, ""];
  },
});
const run = (opts = {}) => migrate({ running: async () => [], prWatch: prWatch(), ...opts });

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Every file under *dir* → its content, for "nothing changed" comparisons. */
function snapshot(dir) {
  const out = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const p = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
  }
  return out;
}

beforeEach(() => {
  savedEnv = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (/^(SANDBOX|WERKMEISTER)_/.test(k)) delete process.env[k];
  }
  home = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-home-"));
  process.env.HOME = home;
  // The real ~/.sandbox is bind-mounted into the dev containers: never run against it.
  assert.equal(os.homedir(), home);
  assert.notEqual(os.homedir(), REAL_HOME);
  legacy = path.join(home, ".sandbox");
  target = path.join(home, ".werkmeister");
  features = path.join(home, "features");
  calls = [];

  write(
    path.join(legacy, "config.yaml"),
    "# mine, kept\n" +
      `paths:\n  repos_root: ${home}/repos\n  workspaces_root: ${features}\n  sandbox_root: /opt/w9r\n` +
      "overrides:\n  model_pricing_yaml: ~/.sandbox/model-pricing.yaml\n  sandbox_issues_project: SW\n" +
      `ingress:\n  certs_dir: ${home}/.sandbox/certs\n`,
  );
  write(path.join(legacy, "env.sh"), "# old\n");
  write(path.join(legacy, "services.local.yaml"), "k8s_context: kind-dev\n");
  write(path.join(legacy, "infra", "proxy", "Caddyfile"), ":80 {\n}\n");
  write(
    path.join(home, ".zshenv"),
    "export EDITOR=vim\n\n# >>> sandbox config >>>\n" +
      '[ -f "$HOME/.sandbox/env.sh" ] && . "$HOME/.sandbox/env.sh"\n# <<< sandbox config <<<\n',
  );
  write(
    path.join(home, "repos", "sandbox", ".werkmeister", "services.yaml"),
    "services:\n  cli:\n    path: apps/cli\n    extra_volumes:\n" +
      "      - '{{werkmeister_home}}:{{werkmeister_home}}'\n      - '{{werkmeister_home}}/locks:/locks'\n",
  );
  write(path.join(features, "ws1", ".sandbox", "workspace.yml"), "feature: ws1\n");
  write(
    path.join(features, "ws1", "compose.yml"),
    `services:\n  cli:\n    volumes:\n      - ${legacy}:${legacy}\n      - ${legacy}/locks:/locks\n      - ${legacy}-other:/x\n`,
  );
  write(path.join(features, "ws2", ".werkmeister", "workspace.yml"), "feature: ws2\n");
  write(path.join(features, "ws2", "compose.yml"), "services: {}\n");

  // Installed by a pre-move CLI, so its log path is still the old home.
  process.env.WERKMEISTER_CONFIG_FILE = path.join(legacy, "config.yaml");
  assert.equal(installPrWatchSchedule(prWatch()).ok, true);
  delete process.env.WERKMEISTER_CONFIG_FILE;
  calls = [];
});

afterEach(() => {
  // In place: a replaced process.env object no longer reaches os.homedir().
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(home, { recursive: true, force: true });
});

const plist = () => path.join(home, "Library", "LaunchAgents", "com.werkmeister.pr-watch.plist");

test("migrate moves the home and repoints every file that carried the old path", async () => {
  const steps = await run();
  assert.ok(
    steps.every((s) => s.ok),
    JSON.stringify(steps, null, 2),
  );

  assert.equal(fs.existsSync(legacy), false);
  assert.equal(
    fs.readFileSync(path.join(target, "infra", "proxy", "Caddyfile"), "utf8"),
    ":80 {\n}\n",
  );

  const config = fs.readFileSync(path.join(target, "config.yaml"), "utf8");
  assert.match(config, /^# mine, kept$/m);
  assert.match(config, /model_pricing_yaml: ~\/\.werkmeister\/model-pricing\.yaml/);
  assert.ok(config.includes(`certs_dir: ${target}/certs`));
  assert.match(config, /^ {2}werkmeister_root: \/opt\/w9r$/m);
  assert.match(config, /^ {2}werkmeister_issues_project: SW$/m);
  assert.doesNotMatch(config, /sandbox_(root|issues_project):/);

  const envSh = fs.readFileSync(path.join(target, "env.sh"), "utf8");
  assert.ok(!envSh.includes(".sandbox"), envSh);
  assert.ok(envSh.includes(`WERKMEISTER_CERTS_DIR=${target}/certs`), envSh);

  const zshenv = fs.readFileSync(path.join(home, ".zshenv"), "utf8");
  assert.ok(zshenv.startsWith("export EDITOR=vim\n"));
  assert.ok(zshenv.includes('. "$HOME/.werkmeister/env.sh"'));
  assert.ok(!zshenv.includes(".sandbox/"));
  assert.ok(!zshenv.includes(">>> sandbox config >>>"), "the old block is retired");
  assert.equal(zshenv.split(">>> werkmeister config >>>").length, 2, "one block");

  const registry = fs.readFileSync(path.join(target, "services.yaml"), "utf8");
  assert.ok(registry.includes(`${target}:${target}`));
  assert.ok(registry.includes(`${target}/locks:/locks`));

  const plistText = fs.readFileSync(plist(), "utf8");
  assert.ok(plistText.includes(`${target}/pr-watch.log`));
  assert.ok(!plistText.includes(".sandbox"));
  assert.ok(calls.some((c) => c.startsWith("launchctl bootstrap")));

  const compose = fs.readFileSync(path.join(features, "ws1", "compose.yml"), "utf8");
  assert.ok(compose.includes(`- ${target}:${target}\n`));
  assert.ok(compose.includes(`- ${target}/locks:/locks\n`));
  assert.ok(compose.includes(`- ${legacy}-other:/x`), "a longer name is left alone");

  assert.ok(fs.existsSync(path.join(features, "ws1", ".sandbox")), "no --workspaces: not renamed");
});

test("a second run changes nothing, and --workspaces then renames only legacy workspaces", async () => {
  await run();
  const before = snapshot(home);
  calls = [];
  const again = await run();
  assert.ok(
    again.every((s) => s.ok),
    JSON.stringify(again, null, 2),
  );
  assert.deepEqual(snapshot(home), before);
  assert.deepEqual(calls, [], "launchctl untouched");

  const renamed = await run({ workspaces: true });
  assert.ok(renamed.every((s) => s.ok));
  assert.ok(fs.existsSync(path.join(features, "ws1", ".werkmeister", "workspace.yml")));
  assert.equal(fs.existsSync(path.join(features, "ws1", ".sandbox")), false);
  const afterRename = snapshot(home);
  await run({ workspaces: true });
  assert.deepEqual(snapshot(home), afterRename);
});

test("a machine never on ~/.sandbox is a no-op that creates nothing", async () => {
  fs.rmSync(legacy, { recursive: true });
  fs.rmSync(plist());
  const before = snapshot(home);
  const steps = await run();
  assert.ok(steps.every((s) => s.ok));
  assert.deepEqual(snapshot(home), before);
  assert.equal(fs.existsSync(target), false);
});

test("--check reports the move and writes nothing", async () => {
  const before = snapshot(home);
  const steps = await run({ checkOnly: true, workspaces: true });
  assert.ok(steps.some((s) => s.detail.startsWith("would move")));
  assert.ok(steps.some((s) => /would reinstall/.test(s.detail)));
  assert.ok(steps.some((s) => /would repoint 1/.test(s.detail)));
  assert.ok(steps.some((s) => /would rename .* ws1/.test(s.detail)));
  assert.deepEqual(snapshot(home), before);
  assert.deepEqual(calls, []);
});

for (const [why, container] of [
  [
    "a container mounts the old home",
    () => ({ name: "sandbox-caddy", mounts: [`${legacy}/infra/proxy/Caddyfile`] }),
  ],
  [
    "a workspace container is up",
    () => ({ name: "ws2-web", mounts: [], workingDir: path.join(features, "ws2") }),
  ],
]) {
  test(`refuses, changing nothing, when ${why}`, async () => {
    const before = snapshot(home);
    const running = [container()];
    const steps = await run({ running: async () => running });
    assert.equal(steps.length, 1);
    assert.equal(steps[0].ok, false);
    assert.ok(steps[0].detail.includes(running[0].name));
    assert.deepEqual(snapshot(home), before);
  });
}

test("an unrelated running container does not block it", async () => {
  const steps = await run({ running: async () => [{ name: "postgres", mounts: ["/var/lib/pg"] }] });
  assert.ok(steps.every((s) => s.ok));
  assert.ok(fs.existsSync(target));
});

test("refuses when both homes exist, or when *_CONFIG_FILE points elsewhere", async () => {
  fs.mkdirSync(target);
  let steps = await run();
  assert.equal(steps[0].ok, false);
  assert.match(steps[0].detail, /both .* exist/);
  fs.rmdirSync(target);

  process.env.WERKMEISTER_CONFIG_FILE = path.join(home, "elsewhere", "config.yaml");
  const before = snapshot(home);
  steps = await run();
  assert.equal(steps[0].ok, false);
  assert.match(steps[0].detail, /CONFIG_FILE/);
  assert.deepEqual(snapshot(home), before);
});

test("the pre-rename ~/.zshrc completion block and ${SANDBOX_ROOT} volume specs are replaced", async () => {
  write(
    path.join(home, ".zshrc"),
    "alias ll='ls -l'\n# >>> sandbox completion >>>\ncomplete -C 'sandbox __complete' sandbox\n# <<< sandbox completion <<<\n",
  );
  write(
    path.join(legacy, "services.local.yaml"),
    "services:\n  cli:\n    extra_volumes: ['${SANDBOX_ROOT}:/src']\n",
  );
  const steps = await run();
  assert.ok(
    steps.every((s) => s.ok),
    JSON.stringify(steps, null, 2),
  );
  const zshrc = fs.readFileSync(path.join(home, ".zshrc"), "utf8");
  assert.ok(zshrc.startsWith("alias ll='ls -l'\n"));
  assert.ok(!zshrc.includes("sandbox"), zshrc);
  assert.match(zshrc, /complete -C 'werkmeister __complete' werkmeister w9r/);
  assert.match(
    fs.readFileSync(path.join(target, "services.local.yaml"), "utf8"),
    /'\$\{WERKMEISTER_ROOT\}:\/src'/,
  );
});

/** A machine already on ~/.werkmeister (SW-92 done), so only the SW-186 steps have work. */
function movedHome() {
  fs.rmSync(legacy, { recursive: true });
  write(
    path.join(target, "config.yaml"),
    `paths:\n  repos_root: ${home}/repos\n  workspaces_root: ${features}\n`,
  );
}

// SW-186: what a pre-noun-group CLI left behind — old hook spellings, missing permission
// twins, with-temp-home's `wait-load`, the stale SANDBOX_MCP_TOKEN, Desktop's `mcp` args.
test("SW-186: rewrites pre-rename hooks, rules, wrapper, secrets and Desktop args; a re-run changes nothing", async () => {
  const { writeWorkspaceHooks, writeWorkspaceSettings } = await import(
    "./dist/harness/claude/hooks_gen.js"
  );
  const { tempHomeWrapper, writeTempHomeWrapper } = await import("./dist/temp_home.js");
  movedHome();
  write(path.join(target, "secrets.env"), "OTHER=1\nSANDBOX_MCP_TOKEN=old\n");
  write(path.join(target, "mcp-token"), "fresh\n");
  const desktop = path.join(
    home,
    "Library",
    "Application Support",
    "Claude",
    "claude_desktop_config.json",
  );
  write(
    desktop,
    JSON.stringify({ mcpServers: { w: { command: "/x/werkmeister", args: ["mcp"] } } }),
  );

  const ws = path.join(features, "demo");
  write(path.join(ws, ".werkmeister", "workspace.yml"), "feature: demo\nautonomous: true\n");
  write(path.join(ws, ".env"), "FEATURE=demo\n");
  writeWorkspaceHooks(ws);
  writeWorkspaceSettings(ws);
  writeTempHomeWrapper(ws);
  const settingsFile = path.join(ws, ".claude", "settings.json");
  const fresh = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const old = JSON.parse(
    JSON.stringify(fresh)
      .replaceAll("werkmeister internal session-end", "werkmeister stop --if-idle")
      .replace(/werkmeister internal (gate|pr-guard|agent-state)/g, "werkmeister hooks $1"),
  );
  // The new twins of the old rules: missing from settings and from the record alike.
  const pre186 = (rules) => rules.filter((r) => !r.includes("feature up"));
  old.permissions.allow = pre186(old.permissions.allow);
  const record = path.join(ws, ".werkmeister", "claude-permissions.json");
  const recorded = JSON.parse(fs.readFileSync(record, "utf8"));
  write(record, JSON.stringify({ ...recorded, allow: pre186(recorded.allow) }));
  const mine = { hooks: [{ type: "command", command: "echo mine" }] };
  old.hooks.SessionEnd.unshift(mine);
  write(settingsFile, JSON.stringify(old));
  const wrapper = tempHomeWrapper(ws);
  write(
    wrapper,
    fs
      .readFileSync(wrapper, "utf8")
      .replace("werkmeister internal wait-load", "werkmeister wait-load"),
  );
  assert.match(fs.readFileSync(wrapper, "utf8"), /werkmeister wait-load/);

  const before = snapshot(home);
  const checked = await run({ checkOnly: true });
  assert.ok(
    checked.every((s) => s.ok),
    JSON.stringify(checked, null, 2),
  );
  assert.deepEqual(snapshot(home), before, "--check writes nothing");
  assert.match(JSON.stringify(checked), /would rewrite 1: demo/);

  const steps = await run();
  assert.ok(
    steps.every((s) => s.ok),
    JSON.stringify(steps, null, 2),
  );
  const text = fs.readFileSync(settingsFile, "utf8");
  assert.doesNotMatch(text, /werkmeister (hooks |stop --if-idle)/);
  assert.match(text, /werkmeister internal gate/);
  assert.match(text, /werkmeister internal pr-guard/);
  const after = JSON.parse(text);
  assert.deepEqual(after.hooks.SessionEnd[0], mine, "the person's hook is kept");
  // Re-added rules go last: compare the sets.
  assert.deepEqual(after.permissions.allow.toSorted(), fresh.permissions.allow.toSorted());
  assert.deepEqual(after.permissions.deny, fresh.permissions.deny);
  assert.match(fs.readFileSync(wrapper, "utf8"), /werkmeister internal wait-load/);
  assert.equal(
    fs.readFileSync(path.join(target, "secrets.env"), "utf8"),
    "OTHER=1\nWERKMEISTER_MCP_TOKEN=fresh\n",
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(desktop, "utf8")).mcpServers.w.args, [
    "internal",
    "mcp",
  ]);
  const env = steps.find((s) => s.label === "feature env");
  assert.ok(env?.optional && /workspace init.* demo/.test(env.detail), JSON.stringify(steps));

  const settled = snapshot(home);
  const again = await run();
  assert.deepEqual(snapshot(home), settled, "a second run changes nothing");
  assert.match(JSON.stringify(again), /every workspace uses the noun-group spellings/);
  assert.match(JSON.stringify(again), /no pre-rename keys/);
});

test("SW-186: a stale token with no mcp-token file is not ok and the old line stays", async () => {
  movedHome();
  write(path.join(target, "secrets.env"), "SANDBOX_MCP_TOKEN=s3cr3t\n");
  const step = (await run()).find((s) => s.label === "secrets.env");
  assert.equal(step.ok, false);
  assert.doesNotMatch(step.detail, /s3cr3t/);
  assert.equal(
    fs.readFileSync(path.join(target, "secrets.env"), "utf8"),
    "SANDBOX_MCP_TOKEN=s3cr3t\n",
  );
});
