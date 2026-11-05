/**
 * The one set of fakes for fixtures and core tests (SW-427): a fake `gh` and `docker` that read one
 * `world.json` and log each call. `seedFixture` and `withFakeGh` both write them, so a gh verb added
 * here reaches every test. They stay generated text, not files in a folder: the CLI bundles core,
 * so a folder read at runtime would be missing from the published build.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** What the fakes answer. Absent fields take the defaults in FAKE_JS. */
export interface FakeWorld {
  /** `gh issue view` prints it as JSON; null or absent exits 1 ("could not resolve"). */
  issue?: unknown;
  /** `gh auth status` exit code. */
  auth?: number;
  /** `gh repo view` exit code. */
  repoView?: number;
  /** Labels the repo has: `issue edit --add-label` fails for any other; `label create` adds one. */
  labels?: string[];
  /** `gh project item-list` prints `{ items }`. */
  items?: unknown[];
  /** `gh issue list` prints these, for every repo. */
  issues?: unknown[];
  /** `gh pr create` prints it. */
  prUrl?: string;
  /** Containers the fake docker shows as running, to the gate's `ps --format {{.Names}}…` only. */
  running?: string[];
}

export interface Fakes {
  gh: string;
  docker: string;
  /** One line per gh call (`calls`, the name withFakeGh tests read). */
  ghLog: string;
  dockerLog: string;
}

// Unknown verbs exit 1, so a code path a fake doesn't cover fails loudly (SW-148).
// `pr list` prints nothing: pr open's --jq leaves no URL when no PR is open.
// Only the gate's `ps --format {{.Names}}\t{{.State}}` sees running containers; every other `ps`
// (-q/-aq by label) finds none, so no teardown of a pre-rename project runs on a fake hit.
const FAKE_JS = `import * as fs from "node:fs";
const [, , tool, dir, ...args] = process.argv;
const worldFile = dir + "/world.json";
const world = JSON.parse(fs.readFileSync(worldFile, "utf8"));
fs.appendFileSync(dir + "/" + (tool === "gh" ? "calls" : "docker-calls"), args.join(" ").replace(/\\n/g, " ") + "\\n");
const out = (s) => process.stdout.write(s);
const fail = (msg) => { process.stderr.write(msg + "\\n"); process.exit(1); };
const verb = args.slice(0, 2).join(" ");
const labels = world.labels ?? [];
if (tool === "gh") {
  switch (verb) {
    case "auth status":
      process.stderr.write((world.auth ?? 0) === 0 ? "  ✓ Logged in to github.com account octo (keyring)\\n" : "You are not logged into any GitHub hosts.\\n");
      process.exit(world.auth ?? 0);
    case "api user": out("octo\\n"); break;
    case "search prs": out("[]\\n"); break;
    case "pr list": break;
    case "pr create": out((world.prUrl ?? "https://github.com/o/app/pull/1") + "\\n"); break;
    case "repo view": process.exit(world.repoView ?? 0);
    case "label create":
      if (!labels.includes(args[2])) fs.writeFileSync(worldFile, JSON.stringify({ ...world, labels: [...labels, args[2]] }));
      break;
    case "issue edit":
      if (args[5] === "--add-label" && !labels.includes(args[6])) fail("'" + args[6] + "' not found");
      break;
    case "issue view":
      if (world.issue == null) fail("could not resolve");
      out(JSON.stringify(world.issue) + "\\n");
      break;
    case "issue list": out(JSON.stringify(world.issues ?? []) + "\\n"); break;
    case "project item-list": out(JSON.stringify({ items: world.items ?? [] }) + "\\n"); break;
    case "issue close": case "issue comment": break;
    default: fail("fake gh: unhandled: " + args.join(" "));
  }
} else {
  switch (args[0]) {
    case "ps":
      if (args.some((a) => a.includes("{{.Names}}"))) out((world.running ?? []).map((c) => c + "\\trunning\\n").join(""));
      break;
    case "inspect": out("false\\n"); break;
    case "exec": case "stop": case "compose": case "network": break;
    default: fail("fake docker: unhandled: " + args.join(" "));
  }
}
`;

const shim = (dir: string, tool: string) =>
  `#!/bin/sh\nexec '${process.execPath}' '${path.join(dir, "fake.mjs")}' ${tool} '${dir}' "$@"\n`;

/** Write the fakes and *world* into *dir* (created if missing); returns where they are. */
export function writeFakes(dir: string, world: FakeWorld = {}): Fakes {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify(world));
  fs.writeFileSync(path.join(dir, "fake.mjs"), FAKE_JS);
  for (const tool of ["gh", "docker"])
    fs.writeFileSync(path.join(dir, tool), shim(dir, tool), { mode: 0o755 });
  return {
    gh: path.join(dir, "gh"),
    docker: path.join(dir, "docker"),
    ghLog: path.join(dir, "calls"),
    dockerLog: path.join(dir, "docker-calls"),
  };
}
