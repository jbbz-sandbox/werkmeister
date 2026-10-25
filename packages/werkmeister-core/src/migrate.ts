/**
 * `werkmeister migrate`: move `~/.sandbox` to `~/.werkmeister` (SW-92).
 *
 * Readers already follow the move through `dotDir()`; what breaks is every file
 * that was written with the old absolute path in it. Each step below repairs one
 * of those, detects before it writes, and is a no-op once done, so a second run
 * (or a run on a machine that was never on `~/.sandbox`) changes nothing and a
 * run that failed half-way can simply be repeated. Reports through Step objects
 * like machine_setup. Goes away with the fallbacks in SW-11.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { COMPOSE_FILE, LEGACY_COMPOSE_FILE } from "./compose_file.js";
import { configPath, envVar, workspacesRoot } from "./config.js";
import { docker } from "./docker.js";
import { ensureZshenvSources, envShPath, load, renderEnvSh, writeEnvSh } from "./global_config.js";
import {
  installPrWatchSchedule,
  type PrWatchScheduleOptions,
  prWatchScheduleState,
  type Step,
} from "./machine_setup.js";
import { syncRegistry } from "./registry_sync.js";

export const LEGACY_DOT_DIR = ".sandbox";
export const DOT_DIR = ".werkmeister";

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

  const wsRoot = workspacesRoot();
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
            "(`werkmeister stop <feature>`, `werkmeister infra down`) and re-run; nothing was changed",
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
    const next = repointed(repointed(text, legacy, target), `~/${LEGACY_DOT_DIR}`, `~/${DOT_DIR}`);
    configChanged = writeIfChanged(config, next, checkOnly);
  }
  steps.push({
    label: "config.yaml",
    ok: true,
    detail: configChanged
      ? would("repointed paths at the new home", "would repoint paths at the new home")
      : "no paths under the old home",
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
    steps.push({
      label: "~/.zshenv",
      ok: true,
      detail: ensureZshenvSources() ? `source block now reads ${target}/env.sh` : "up to date",
    });
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
          "their CLAUDE.md and contexts say .sandbox/ until each one's next `werkmeister init-workspace`"
        : "none left on .sandbox/",
    });
  }

  if (moving && !checkOnly) {
    steps.push({
      label: "shared infra",
      ok: true,
      detail:
        "its files moved as they are (no host paths in them); the next `werkmeister infra up` mounts them from the new home",
    });
  }
  return steps;
}
