/**
 * `werkmeister machine migrate`: move `~/.sandbox` to `~/.werkmeister` (SW-92), then
 * move what names the CLI's pre-SW-186 spellings to the noun groups.
 *
 * Readers only know `~/.werkmeister` and the post-SW-106 names, so every file
 * written under the old home or with an old name needs repair. Each step below
 * repairs one of those, detects before it writes, and is a no-op once done, so a second run
 * (or a run on a machine that was never on `~/.sandbox`) changes nothing and a
 * run that failed half-way can simply be repeated. Reports through Step objects
 * like machine_setup. The one place the CLI still reads the pre-rename names.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { COMPOSE_FILE, LEGACY_COMPOSE_FILE } from "./compose_file.js";
import {
  configPath,
  envVar,
  expandUser,
  servicesLocalYamlPath,
  servicesYamlPath,
  workspacesRoot,
} from "./config.js";
import { docker } from "./docker.js";
import { DOT_DIR, dotDir } from "./dot_dir.js";
import {
  ensureZshenvSources,
  ensureZshrcCompletion,
  envShPath,
  load,
  patchDesktopConfig,
  renderEnvSh,
  secretsPath,
  stripBlock,
  writeEnvSh,
  zshenvPath,
  zshrcPath,
} from "./global_config.js";
import {
  workspaceAllowRules,
  workspaceDenyRules,
  writePrGuardHook,
  writeWorkspaceHooks,
  writeWorkspaceSettings,
} from "./harness/claude/hooks_gen.js";
import {
  installPrWatchSchedule,
  type PrWatchScheduleOptions,
  prWatchScheduleState,
  type Step,
} from "./machine_setup.js";
import { syncRegistry } from "./registry_sync.js";
import { tempHomeWrapper, writeTempHomeWrapper } from "./temp_home.js";

export const LEGACY_DOT_DIR = ".sandbox";

/** A running container, as far as the refusal needs to know. */
export interface RunningContainer {
  name: string;
  /** Host paths it bind-mounts. */
  mounts: string[];
  /** Compose's `com.docker.compose.project.working_dir` label, when it has one. */
  workingDir?: string;
}

export interface MigrateOptions {
  /** Also rename each workspace's `.sandbox/` to `.werkmeister/`. */
  workspaces?: boolean;
  /** Report what would change; write nothing. */
  checkOnly?: boolean;
  /** Running containers; null when Docker is unreachable. Injected by tests. */
  running?: () => Promise<RunningContainer[] | null>;
  /** Passed to the pr-watch schedule code; tests inject the launchctl/crontab runner. */
  prWatch?: PrWatchScheduleOptions;
}

async function dockerRunning(): Promise<RunningContainer[] | null> {
  try {
    const list = await docker().listContainers({ filters: { status: ["running"] } });
    return list.map((c) => ({
      name: (c.Names[0] ?? c.Id).replace(/^\//, ""),
      mounts: (c.Mounts ?? []).map((m) => m.Source),
      workingDir: c.Labels?.["com.docker.compose.project.working_dir"],
    }));
  } catch {
    return null;
  }
}

const within = (p: string | undefined, dir: string) =>
  p !== undefined && (p === dir || p.startsWith(dir + path.sep));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** *text* with every `<from>` path (not a longer name such as `.sandbox-x`) pointed at *to*. */
function repointed(text: string, from: string, to: string): string {
  return text.replace(new RegExp(`${escapeRe(from)}(?![\\w.-])`, "g"), to);
}

/** Drop the pre-SW-106 `# >>> <name> >>>` block from *file*; true when there was one. */
function retireBlock(file: string, name: string): boolean {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  return writeIfChanged(file, stripBlock(text, `# >>> ${name} >>>`, `# <<< ${name} <<<`), false);
}

/** Write *next* unless it equals what is there; true when it differs. */
function writeIfChanged(file: string, next: string, checkOnly: boolean): boolean {
  if (fs.readFileSync(file, "utf8") === next) return false;
  if (!checkOnly) fs.writeFileSync(file, next);
  return true;
}

/** Every workspace directly under *root*: a child holding `.werkmeister/` or `.sandbox/` `workspace.yml`. */
function workspaceDirs(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .sort()
    .map((name) => path.join(root, name))
    .filter((dir) =>
      [DOT_DIR, LEGACY_DOT_DIR].some((d) => fs.existsSync(path.join(dir, d, "workspace.yml"))),
    );
}

/** {@link workspacesRoot} as the pre-rename home's config.yaml sets it: nothing reads that home but migrate. */
function workspacesRootBeforeMove(legacy: string): string {
  const file = path.join(legacy, "config.yaml");
  const configured = fs.existsSync(file)
    ? parseYaml(fs.readFileSync(file, "utf8"))?.paths?.workspaces_root
    : undefined;
  return configured ? path.resolve(expandUser(String(configured))) : workspacesRoot();
}

export async function migrate(opts: MigrateOptions = {}): Promise<Step[]> {
  const checkOnly = Boolean(opts.checkOnly);
  const home = os.homedir();
  const legacy = path.join(home, LEGACY_DOT_DIR);
  const target = path.join(home, DOT_DIR);
  const would = (did: string, will: string) => (checkOnly ? will : did);

  if (envVar("CONFIG_FILE")) {
    return [
      {
        label: "tool home",
        ok: false,
        detail: `*_CONFIG_FILE is set (${configPath()}), so the home is not ${legacy}: nothing to move — unset it to migrate`,
      },
    ];
  }
  if (fs.existsSync(legacy) && fs.existsSync(target)) {
    return [
      {
        label: "tool home",
        ok: false,
        detail: `both ${legacy} and ${target} exist — merge them by hand, then re-run`,
      },
    ];
  }

  const wsRoot = fs.existsSync(legacy) ? workspacesRootBeforeMove(legacy) : workspacesRoot();
  const legacyWorkspaces = opts.workspaces
    ? workspaceDirs(wsRoot).filter(
        (dir) =>
          fs.existsSync(path.join(dir, LEGACY_DOT_DIR)) && !fs.existsSync(path.join(dir, DOT_DIR)),
      )
    : [];

  // Only a move or a rename can break a running container; repointing files cannot.
  if (fs.existsSync(legacy) || legacyWorkspaces.length) {
    const running = await (opts.running ?? dockerRunning)();
    const blocking = (running ?? []).filter(
      (c) => c.mounts.some((m) => within(m, legacy)) || within(c.workingDir, wsRoot),
    );
    if (blocking.length) {
      return [
        {
          label: "containers",
          ok: false,
          detail:
            `still running: ${blocking.map((c) => c.name).join(", ")} — stop them ` +
            "(`werkmeister feature stop <feature>`, `werkmeister infra down`) and re-run; nothing was changed",
        },
      ];
    }
  }

  const steps: Step[] = [];

  const moving = fs.existsSync(legacy);
  if (moving) {
    if (!checkOnly) fs.renameSync(legacy, target);
    steps.push({
      label: "tool home",
      ok: true,
      detail: would(`moved ${legacy} → ${target}`, `would move ${legacy} → ${target}`),
    });
  } else {
    steps.push({
      label: "tool home",
      ok: true,
      detail: fs.existsSync(target) ? `already at ${target}` : "no tool home yet — nothing to move",
    });
  }
  // In --check nothing moved, so the files below are still read from the old home.
  const homeNow = checkOnly && moving ? legacy : target;

  // config.yaml as text, so comments and key order survive; values may be `~/…` or absolute.
  const config = path.join(homeNow, "config.yaml");
  let configChanged = false;
  if (fs.existsSync(config)) {
    const text = fs.readFileSync(config, "utf8");
    const next = repointed(repointed(text, legacy, target), `~/${LEGACY_DOT_DIR}`, `~/${DOT_DIR}`)
      .replace(/^(\s*)sandbox_root:/m, "$1werkmeister_root:")
      .replace(/^(\s*)sandbox_issues_project:/m, "$1werkmeister_issues_project:");
    configChanged = writeIfChanged(config, next, checkOnly);
  }
  steps.push({
    label: "config.yaml",
    ok: true,
    detail: configChanged
      ? would("repointed paths and renamed keys", "would repoint paths and rename keys")
      : "no paths under the old home, no pre-rename keys",
  });

  if (checkOnly) {
    // env.sh, ~/.zshenv and the registry are rendered from the moved home; say what a run does.
    steps.push({ label: "env.sh, ~/.zshenv, services.yaml", ok: true, detail: "would regenerate" });
  } else if (fs.existsSync(target)) {
    const envSh = envShPath();
    const envChanged =
      !fs.existsSync(envSh) || fs.readFileSync(envSh, "utf8") !== renderEnvSh(load());
    if (envChanged) writeEnvSh(load());
    steps.push({
      label: "env.sh",
      ok: true,
      detail: envChanged ? `regenerated ${envSh}` : "up to date",
    });
    const oldEnvBlock = retireBlock(zshenvPath(), "sandbox config");
    steps.push({
      label: "~/.zshenv",
      ok: true,
      detail:
        ensureZshenvSources() || oldEnvBlock
          ? `source block now reads ${target}/env.sh`
          : "up to date",
    });
    if (retireBlock(zshrcPath(), "sandbox completion")) {
      ensureZshrcCompletion();
      steps.push({ label: "~/.zshrc", ok: true, detail: "completion now for werkmeister and w9r" });
    }
    // Volume specs name the CLI checkout as ${SANDBOX_ROOT} until SW-106; services.yaml is
    // regenerated from fragments right after, services.local.yaml is the person's own.
    const rooted = [servicesYamlPath(), servicesLocalYamlPath()].filter(
      (file) =>
        fs.existsSync(file) &&
        writeIfChanged(
          file,
          fs.readFileSync(file, "utf8").replaceAll("${SANDBOX_ROOT}", "${WERKMEISTER_ROOT}"),
          false,
        ),
    );
    if (rooted.length) {
      steps.push({
        label: "volume specs",
        ok: true,
        detail: `\${SANDBOX_ROOT} → \${WERKMEISTER_ROOT} in ${rooted.join(", ")}`,
      });
    }
    steps.push(...syncRegistry());
  }

  // Its log path is the home; in --check before the move, `current` is judged against the old one.
  const prWatch = prWatchScheduleState(opts.prWatch);
  const prLabel = "pr-watch schedule";
  if (!prWatch.installed) {
    steps.push({ label: prLabel, ok: true, detail: "not installed" });
  } else if (prWatch.current && !(checkOnly && moving)) {
    steps.push({ label: prLabel, ok: true, detail: "up to date" });
  } else if (checkOnly) {
    steps.push({ label: prLabel, ok: true, detail: `would reinstall ${prWatch.where}` });
  } else {
    const r = installPrWatchSchedule(opts.prWatch);
    steps.push({ label: prLabel, ok: r.ok, detail: r.lines[0] ?? "" });
  }

  // Compose bind-mounts carry the home as an absolute path. A path rewrite, not a
  // re-render: re-rendering needs slot allocation, and `up` already re-renders a stale file.
  const composeChanged: string[] = [];
  for (const dir of workspaceDirs(wsRoot)) {
    for (const name of [COMPOSE_FILE, LEGACY_COMPOSE_FILE]) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (writeIfChanged(file, repointed(text, legacy, target), checkOnly))
        composeChanged.push(file);
    }
  }
  steps.push({
    label: "workspace compose files",
    ok: true,
    detail: composeChanged.length
      ? `${would("repointed", "would repoint")} ${composeChanged.length}: ${composeChanged.map((f) => path.relative(wsRoot, f)).join(", ")}`
      : "none mount the old home",
  });

  if (opts.workspaces) {
    if (!checkOnly) {
      for (const dir of legacyWorkspaces) {
        fs.renameSync(path.join(dir, LEGACY_DOT_DIR), path.join(dir, DOT_DIR));
      }
    }
    steps.push({
      label: "workspace dot-dirs",
      ok: true,
      detail: legacyWorkspaces.length
        ? `${would("renamed", "would rename")} .sandbox/ → .werkmeister/ in ${legacyWorkspaces.map((d) => path.basename(d)).join(", ")}; ` +
          "their CLAUDE.md and contexts say .sandbox/ until each one's next `werkmeister workspace init`"
        : "none left on .sandbox/",
    });
  }

  if (moving && !checkOnly) {
    steps.push({
      label: "shared infra",
      ok: true,
      detail:
        "its files moved as they are (no host paths in them); the next `werkmeister infra connect` mounts them from the new home",
    });
  }
  // A home half-moved is not one to rewrite settings in.
  if (steps.every((s) => s.ok)) steps.push(...nounGroupSteps(wsRoot, checkOnly));
  return steps;
}

// What the CLI wrote with a pre-SW-186 spelling: hook commands and with-temp-home's load wait.
const PRE_SW186_HOOK = /werkmeister (?:hooks (?:gate|pr-guard|agent-state)|stop --if-idle)/;
const PRE_SW186_WAIT = "werkmeister wait-load";

function readJson(file: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** True when *dir*'s hooks, permission rules or with-temp-home predate SW-186's spellings. */
function workspaceStale(dir: string): boolean {
  const settingsFile = path.join(dir, ".claude", "settings.json");
  // Never inited by this CLI: `workspace init` writes it, not migrate.
  if (!fs.existsSync(settingsFile)) return false;
  const settings = readJson(settingsFile);
  const has = (key: "allow" | "deny") => new Set<string>(settings?.["permissions"]?.[key] ?? []);
  const allow = has("allow");
  const deny = has("deny");
  const wrapper = tempHomeWrapper(dir);
  return (
    PRE_SW186_HOOK.test(fs.readFileSync(settingsFile, "utf8")) ||
    workspaceAllowRules(dir).some((r) => !allow.has(r)) ||
    workspaceDenyRules(dir).some((r) => !deny.has(r)) ||
    (fs.existsSync(wrapper) && fs.readFileSync(wrapper, "utf8").includes(PRE_SW186_WAIT))
  );
}

/**
 * SW-161: drop the pre-rename `SANDBOX_MCP_TOKEN` and set `WERKMEISTER_MCP_TOKEN` from
 * the server-owned token file, never the old value (it no longer matches the server).
 */
function secretsStep(checkOnly: boolean): Step {
  const label = "secrets.env";
  const file = secretsPath();
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!/^\s*SANDBOX_MCP_TOKEN=/m.test(text)) {
    return { label, ok: true, detail: "no pre-rename keys" };
  }
  const tokenFile = path.join(dotDir(os.homedir()), "mcp-token");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  if (!token) {
    return {
      label,
      ok: false,
      detail: `SANDBOX_MCP_TOKEN is stale and ${tokenFile} does not exist yet — run \`werkmeister infra connect\`, then re-run`,
    };
  }
  const kept = text
    .split("\n")
    .filter((l) => !/^\s*(?:SANDBOX|WERKMEISTER)_MCP_TOKEN=/.test(l))
    .join("\n")
    .replace(/\n*$/, "\n");
  writeIfChanged(file, `${kept}WERKMEISTER_MCP_TOKEN=${token}\n`, checkOnly);
  return {
    label,
    ok: true,
    detail: `${checkOnly ? "would replace" : "replaced"} SANDBOX_MCP_TOKEN with WERKMEISTER_MCP_TOKEN from ${tokenFile}`,
  };
}

/** SW-186: each workspace's hooks, permission rules and with-temp-home; secrets; Claude Desktop. */
function nounGroupSteps(wsRoot: string, checkOnly: boolean): Step[] {
  const dirs = workspaceDirs(wsRoot).filter((d) => fs.existsSync(path.join(d, DOT_DIR)));
  const stale = dirs.filter(workspaceStale);
  if (!checkOnly) {
    for (const dir of stale) {
      // The gate and PR guard belong to the strategy: re-spell the ones it has, add none.
      const hooks = fs.readFileSync(path.join(dir, ".claude", "settings.json"), "utf8");
      if (/werkmeister hooks gate/.test(hooks)) writeWorkspaceHooks(dir);
      else if (/werkmeister hooks pr-guard/.test(hooks)) writePrGuardHook(dir);
      writeWorkspaceSettings(dir);
      if (fs.existsSync(tempHomeWrapper(dir))) writeTempHomeWrapper(dir);
    }
  }
  const names = (list: string[]) => list.map((d) => path.basename(d)).join(", ");
  // SW-122 removes SANDBOX_FEATURE once every workspace exports the new name; `.env` is init's to render.
  const oldEnv = dirs.filter((d) => {
    const env = path.join(d, ".env");
    return fs.existsSync(env) && !/^WERKMEISTER_FEATURE=/m.test(fs.readFileSync(env, "utf8"));
  });
  const desktop = patchDesktopConfig(undefined, checkOnly);
  return [
    {
      label: "workspace hooks and permission rules",
      ok: true,
      detail: stale.length
        ? `${checkOnly ? "would rewrite" : "rewrote"} ${stale.length}: ${names(stale)}`
        : "every workspace uses the noun-group spellings",
    },
    secretsStep(checkOnly),
    {
      label: "Claude Desktop config",
      ok: true,
      detail: desktop
        ? `${checkOnly ? "would launch" : "now launches"} \`werkmeister internal mcp\``
        : "up to date",
    },
    ...(oldEnv.length
      ? [
          {
            label: "feature env",
            ok: true,
            optional: true,
            detail: `${oldEnv.length} still export only SANDBOX_FEATURE — run \`werkmeister workspace init\` in ${names(oldEnv)}`,
          },
        ]
      : []),
  ];
}
