/**
 * Is the installed werkmeister current (SW-290)? Current = the latest release, or a
 * link whose checkout is on `main` and contains `origin/main`.
 *
 * shortcut: no dist-vs-src freshness check, so a pulled but unbuilt link reads current;
 * add one if a stale build bites again.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { run as procRun } from "werkmeister-core/proc";

type Run = (
  cmd: string[],
  opts: { capture: true; timeout: number },
) => { status: number; stdout: string };

export interface CliCurrency {
  /** `null` when the check could not run (offline, no git). */
  current: boolean | null;
  text: string;
}

export interface CurrencyDeps {
  run?: Run;
  cliDir?: string;
  version?: string;
}

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Dotted numeric compare: negative when a < b. */
const cmp = (a: string, b: string): number => {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

export function checkCliCurrent(deps: CurrencyDeps = {}): CliCurrency {
  const sh: Run = deps.run ?? ((cmd, o) => procRun(cmd, o));
  const safe = (cmd: string[], timeout: number) => {
    try {
      return sh(cmd, { capture: true, timeout });
    } catch {
      return null;
    }
  };
  const dir = deps.cliDir ?? fs.realpathSync(cliRoot);
  const top = safe(["git", "-C", dir, "rev-parse", "--show-toplevel"], 10);

  if (top?.status === 0) {
    const repo = top.stdout.trim();
    const git = (...a: string[]) => safe(["git", "-C", repo, ...a], 60);
    const fix = `git -C ${repo} checkout main && git -C ${repo} pull, then from ${repo}: corepack pnpm install --frozen-lockfile && corepack pnpm turbo run build`;
    if (git("fetch", "origin", "main", "--quiet")?.status !== 0)
      return {
        current: null,
        text: `could not fetch origin main in ${repo}, currency not checked`,
      };
    const branch = git("rev-parse", "--abbrev-ref", "HEAD")?.stdout.trim();
    if (branch !== "main")
      return {
        current: false,
        text: `stale: linked checkout ${repo} is on '${branch}', not main. Fix: ${fix}`,
      };
    const behind = git("rev-list", "--count", "HEAD..origin/main")?.stdout.trim();
    return git("merge-base", "--is-ancestor", "origin/main", "HEAD")?.status === 0
      ? { current: true, text: `current: linked checkout ${repo} contains origin/main` }
      : {
          current: false,
          text: `stale: linked checkout ${repo} is ${behind || "some"} commits behind origin/main. Fix: ${fix}`,
        };
  }

  const have =
    deps.version ??
    (JSON.parse(fs.readFileSync(path.join(cliRoot, "package.json"), "utf8")).version as string);
  const latest = safe(["npm", "view", "werkmeister", "version"], 30);
  if (latest?.status !== 0 || !latest.stdout.trim())
    return {
      current: null,
      text: `could not look up the latest release (installed ${have}), currency not checked`,
    };
  const want = latest.stdout.trim();
  return cmp(have, want) >= 0
    ? { current: true, text: `current: ${have} is the latest release` }
    : {
        current: false,
        text: `stale: installed ${have}, latest release ${want}. Fix: npm i -g werkmeister@latest`,
      };
}
