/**
 * The one set of fakes for fixtures and core tests (SW-427): a fake `gh` and `docker` that read their
 * world from plain files beside them and log each call. `seedFixture` and `withFakeGh` both write them, so a gh verb added
 * here reaches every test. They stay generated text, not files in a folder: the CLI bundles core,
 * so a folder read at runtime would be missing from the published build.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

/** What the fakes answer. Absent fields take the defaults in FAKE_SH. */
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
  /** `gh pr create` exit code (SW-1197); 0 prints `prUrl`. */
  prCreate?: number;
  /** `gh pr create` prints it. */
  prUrl?: string;
  /** `gh pr view` reports this state (default `OPEN`); `MERGED` adds a merge commit (SW-482). Every view has `createdAt` 2026-01-02T03:04:05Z, a merged one `mergedAt` 2026-01-02T04:05:06Z (SW-779). */
  prState?: string;
  /** `gh api repos/…/rules/branches/…` prints these (the base's active rules); default none. */
  rules?: unknown[];
  /** Containers the fake docker shows as running, to the gate's `ps --format {{.Names}}…` only. */
  running?: string[];
  /** `docker inspect` lines (`feature\tworkdir\tstartedAt\tmemory\tnanoCpus\texecs`) the scheduler reads as running features (SW-685). */
  containers?: string[];
  /** Set: `docker exec` runs its last argument (the gate row's command) with `sh -c` here and exits with its code. Absent: exit 0. */
  execCwd?: string;
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
// (-q/-aq by label) finds none, so no teardown of a pre-rename project runs on a fake hit. Only the
// scheduler's exact feature-label `ps -q` and its NanoCpus `inspect` see `containers` (SW-685).
// POSIX sh, not node: a fixture flow makes dozens of gh/docker calls and a node start was ~100 ms
// each. The world is plain files next to the script (writeFakes), so there is no JSON to parse.
const FAKE_SH = `get() { v=$2; [ -f "$dir/$1" ] && IFS= read -r v < "$dir/$1"; printf '%s' "$v"; }
show() { IFS= read -r v < "$dir/$1"; printf '%s\\n' "$v"; }
out() { printf '%s\\n' "$1"; }
fail() { printf '%s\\n' "$1" >&2; exit 1; }
if [ "$tool" = gh ]; then log=calls; else log=docker-calls; fi
# A gate exec logs as \`exec <container> <row command>\`: the inlined with-temp-home script is ~1.5 KB a row (SW-511).
if [ "$tool" = docker ] && [ "$1" = exec ]; then for last; do :; done; line="exec $2 $last"; else line="$*"; fi
case "$line" in *'
'*) line=$(printf '%s' "$line" | tr '\\n' ' ') ;; esac
printf '%s\\n' "$line" >> "$dir/$log"
if [ "$tool" = gh ]; then
  case "$1 $2" in
    "auth status")
      a=$(get auth 0)
      if [ "$a" = 0 ]; then out '  ✓ Logged in to github.com account octo (keyring)' >&2; else out 'You are not logged into any GitHub hosts.' >&2; fi
      exit "$a" ;;
    "api user") out octo ;;
    "api "*)
      # The gate's merge row (SW-457): any other \`gh api\` path still falls through to unhandled.
      case "$2" in */rules/branches/*) show rules.json ;; *) fail "fake gh: unhandled: $*" ;; esac ;;
    "search prs") out '[]' ;;
    "pr list") ;;
    "pr create")
      [ "$(get prCreate 0)" = 0 ] || fail "fake gh: pr create failed (fixture)"
      out "$(get prUrl https://github.com/o/app/pull/1)" ;;
    "pr view")
      state=$(get prState OPEN)
      merge=null
      merged=null
      [ "$state" = MERGED ] && merge='{"oid":"0000000000000000000000000000000000000000"}' && merged='"2026-01-02T04:05:06Z"'
      url=
      [ $# -ge 3 ] && url=$(printf '%s' "$3" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g; s/^/"url":"/; s/$/",/')
      out "{\${url}\\"number\\":1,\\"title\\":\\"fixture\\",\\"state\\":\\"$state\\",\\"headRefName\\":\\"me/demo\\",\\"baseRefName\\":\\"main\\",\\"headRefOid\\":\\"\\",\\"mergeCommit\\":$merge,\\"createdAt\\":\\"2026-01-02T03:04:05Z\\",\\"mergedAt\\":$merged,\\"mergeable\\":\\"MERGEABLE\\",\\"reviewDecision\\":\\"\\",\\"latestReviews\\":[],\\"reviews\\":[],\\"comments\\":[],\\"files\\":[],\\"statusCheckRollup\\":[]}" ;;
    "repo view") exit "$(get repoView 0)" ;;
    "label create") grep -Fxq -- "$3" "$dir/labels" || printf '%s\\n' "$3" >> "$dir/labels" ;;
    "issue edit")
      if [ "$6" = --add-label ] && ! grep -Fxq -- "$7" "$dir/labels"; then fail "'$7' not found"; fi ;;
    "issue view") [ -f "$dir/issue.json" ] || fail "could not resolve"; show issue.json ;;
    "issue list") show issues.json ;;
    "project item-list") show items.json ;;
    "issue close"|"issue comment") ;;
    *) fail "fake gh: unhandled: $*" ;;
  esac
else
  case "$1" in
    ps)
      case "$*" in
        *'{{.Names}}'*) while IFS= read -r c; do printf '%s\\trunning\\n' "$c"; done < "$dir/running" ;;
        "ps -q --filter label=com.werkmeister.feature") i=0; while IFS= read -r c; do printf 'c%s\\n' "$i"; i=$((i + 1)); done < "$dir/containers" ;;
      esac ;;
    inspect)
      if [ "$2" = --format ] && case "$3" in *NanoCpus*) true ;; *) false ;; esac; then cat "$dir/containers"; else out false; fi ;;
    exec)
      if [ -f "$dir/execCwd" ]; then cd -P "$(cat "$dir/execCwd")" 2>/dev/null || exit 1; sh -c "$last"; exit $?; fi ;;
    stop|compose|network) ;;
    *) fail "fake docker: unhandled: $*" ;;
  esac
fi
`;

/** Newline-terminated lines, or nothing for an empty list. */
const lines = (xs: string[]) => xs.map((x) => `${x}\n`).join("");

/** Write the fakes and *world* into *dir* (created if missing); returns where they are. */
export function writeFakes(dir: string, world: FakeWorld = {}): Fakes {
  fs.mkdirSync(dir, { recursive: true });
  const put = (name: string, body: string) => fs.writeFileSync(path.join(dir, name), body);
  put("auth", String(world.auth ?? 0));
  put("repoView", String(world.repoView ?? 0));
  put("labels", lines(world.labels ?? []));
  put("issues.json", JSON.stringify(world.issues ?? []));
  put("items.json", JSON.stringify({ items: world.items ?? [] }));
  put("rules.json", JSON.stringify(world.rules ?? []));
  put("running", lines(world.running ?? []));
  put("containers", lines(world.containers ?? []));
  if (world.issue != null) put("issue.json", JSON.stringify(world.issue));
  if (world.prUrl !== undefined) put("prUrl", world.prUrl);
  if (world.prCreate !== undefined) put("prCreate", String(world.prCreate));
  if (world.prState !== undefined) put("prState", world.prState);
  if (world.execCwd) put("execCwd", world.execCwd);
  for (const tool of ["gh", "docker"])
    fs.writeFileSync(path.join(dir, tool), `#!/bin/sh\ntool=${tool} dir='${dir}'\n${FAKE_SH}`, {
      mode: 0o755,
    });
  return {
    gh: path.join(dir, "gh"),
    docker: path.join(dir, "docker"),
    ghLog: path.join(dir, "calls"),
    dockerLog: path.join(dir, "docker-calls"),
  };
}

export interface FakeDaemon {
  /** Point WERKMEISTER_HOST here. */
  url: string;
  /** Each request, `METHOD /path body`, in order. */
  calls: string[];
  close(): Promise<void>;
}

/**
 * A stand-in for the daemon's HTTP API, as the CLI's daemon client speaks it (SW-426, SW-263):
 * `GET /api/status`, and `POST /api/tool` answered from *tools* (name → structuredContent).
 * Any other tool fails with code FAKE_DAEMON, so a path the fake doesn't cover fails loudly.
 */
export async function startFakeDaemon(tools: Record<string, unknown> = {}): Promise<FakeDaemon> {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push(`${req.method} ${req.url}${body ? ` ${body}` : ""}`);
    const reply = (status: number, json: unknown) =>
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
    if (req.url === "/api/status") return reply(200, { pid: process.pid, loaded: "fake" });
    if (req.method === "POST" && req.url === "/api/tool") {
      const { name } = JSON.parse(body || "{}") as { name?: string };
      if (name && name in tools) return reply(200, { structuredContent: tools[name], text: "" });
      return reply(501, { error: `fake daemon: unhandled tool ${name}`, code: "FAKE_DAEMON" });
    }
    reply(404, { error: `fake daemon: unhandled ${req.method} ${req.url}`, code: "FAKE_DAEMON" });
  });
  return listening(server, calls);
}

const JIRA_STATUSES = ["To Do", "In Progress", "In Review", "Done"];

/**
 * A stand-in for the Jira REST paths jira-rest.ts calls (SW-896): every issue starts `To Do`,
 * `POST …/transitions` moves it, `POST …/comment` is taken. Any other path fails 501, so a path
 * the fake doesn't cover fails loudly. Point JIRA_BASE_URL at `url` with any email and token.
 * Every key is a parentless `fixture issue`, except story SW-595 under epic SW-585 (SW-633).
 */
export async function startFakeJira(): Promise<FakeDaemon> {
  const calls: string[] = [];
  const status = new Map<string, string>();
  const statusOf = (key: string) => status.get(key) ?? "To Do";
  // SW-633: SW-595 is a story under epic SW-585, whose description holds the review link.
  const FIXED: Record<string, Record<string, unknown>> = {
    "SW-585": {
      summary: "Werkmeister docs overhaul",
      issuetype: { name: "Epic" },
      description:
        "Findings are cited as Page #N from the review doc.\n\nSpec: [review doc|https://example.invalid/review]",
    },
    "SW-595": {
      summary: "Docs: Troubleshooting leads with the skills",
      issuetype: { name: "Story" },
      parent: { key: "SW-585", fields: { summary: "Werkmeister docs overhaul" } },
    },
  };
  const issue = (key: string) => ({
    key,
    fields: {
      summary: "fixture issue",
      status: { name: statusOf(key) },
      issuetype: { name: "Task" },
      comment: { comments: [] },
      ...FIXED[key],
    },
  });
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url ?? "/", "http://fake");
    calls.push(`${req.method} ${url.pathname}${body ? ` ${body}` : ""}`);
    const reply = (code: number, json?: unknown) =>
      res
        .writeHead(code, { "content-type": "application/json" })
        .end(json === undefined ? "" : JSON.stringify(json));
    const m = /^\/rest\/api\/2\/issue\/([A-Z][A-Z0-9]*-\d+)(\/transitions|\/comment)?$/.exec(
      url.pathname,
    );
    const key = m?.[1] ?? "";
    if (m && req.method === "GET" && !m[2]) return reply(200, issue(key));
    if (m?.[2] === "/transitions" && req.method === "GET")
      return reply(200, {
        transitions: JIRA_STATUSES.map((name, i) => ({ id: String(i + 1), name, to: { name } })),
      });
    if (m?.[2] === "/transitions" && req.method === "POST") {
      const id = Number(JSON.parse(body || "{}").transition?.id);
      const to = JIRA_STATUSES[id - 1];
      if (!to) return reply(400, { errorMessages: [`fake jira: no transition ${id}`] });
      status.set(key, to);
      return reply(204);
    }
    if (m?.[2] === "/comment" && req.method === "POST") return reply(201, {});
    if (req.method === "GET" && url.pathname === "/rest/api/2/search/jql") {
      const keys = /key in \(([^)]*)\)/.exec(url.searchParams.get("jql") ?? "")?.[1] ?? "";
      const found = keys
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
      return reply(200, { issues: found.map(issue) });
    }
    reply(501, { errorMessages: [`fake jira: unhandled ${req.method} ${url.pathname}`] });
  });
  return listening(server, calls);
}

async function listening(server: http.Server, calls: string[]): Promise<FakeDaemon> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
