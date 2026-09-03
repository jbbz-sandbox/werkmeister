// Workspace plugin — server route.
// GET /?project=<absPath> : if the project is a sandbox feature workspace
// (has .sandbox/workspace.yml), return its inner repo worktrees and each one's
// git state. Best-effort: a repo whose git call fails yields nulls, never a 500.
import { Router } from "express";
import { readdir, readFile, writeFile, access } from "fs/promises";
import { watch } from "node:fs";
import { homedir } from "node:os";
import { join } from "path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "util";
import { parseGitStatus } from "./parse-git.mjs";
import { parsePr } from "./parse-pr.mjs";
import { parseComposePs } from "./parse-compose.mjs";
import { mergeFolders, workspaceNameForPath } from "./merge-folders.mjs";
import {
  getFormSchema,
  fetchJiraFormData,
  getIntercepts,
  openFeatureBrowser,
  refinePrompt,
  createWorkspace,
  listWorkspaces,
  resolveSandboxBin,
  childEnv,
} from "sandbox-core";

const execFileP = promisify(execFile);
const router = Router();

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Feature name from .sandbox/workspace.yml (the `feature:` scalar), or null. */
async function readFeature(project) {
  try {
    const text = await readFile(join(project, ".sandbox", "workspace.yml"), "utf-8");
    return /^feature:\s*(\S+)/m.exec(text)?.[1] || null;
  } catch {
    return null;
  }
}

/** Immediate subdirs of the workspace that are git worktrees (the repo checkouts). */
async function listWorktrees(project) {
  const entries = await readdir(project, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = join(project, e.name);
    if (await exists(join(dir, ".git"))) out.push({ repo: e.name, dir });
  }
  return out;
}

async function gitState(dir) {
  try {
    const { stdout } = await execFileP("git", ["-C", dir, "status", "--porcelain=v1", "-b"], {
      timeout: 5000,
    });
    return parseGitStatus(stdout);
  } catch {
    return { branch: null, upstream: null, dirty: 0, ahead: 0, behind: 0 };
  }
}

/** The worktree's current-branch PR via `gh`, or null (no PR / gh absent / unauth). */
async function prState(dir) {
  try {
    const { stdout } = await execFileP(
      "gh",
      ["pr", "view", "--json", "state,url,title,number"],
      { cwd: dir, timeout: 5000 },
    );
    return parsePr(stdout);
  } catch {
    return null;
  }
}

router.get("/", async (req, res) => {
  try {
    const project = req.query.project;
    if (!project || typeof project !== "string") {
      return res.json({ isWorkspace: false });
    }
    if (!(await exists(join(project, ".sandbox", "workspace.yml")))) {
      return res.json({ isWorkspace: false });
    }

    const [feature, worktrees] = await Promise.all([readFeature(project), listWorktrees(project)]);
    const repos = await Promise.all(
      worktrees.map(async ({ repo, dir }) => {
        const [git, pr] = await Promise.all([gitState(dir), prState(dir)]);
        return { repo, dir, ...git, pr };
      }),
    );

    res.json({ isWorkspace: true, feature, workspacePath: project, repos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Docker service status + intercept state (workspace-level) ──────────────
// `docker compose ps` in the workspace root, joined with this feature's
// Telepresence intercept state. Best-effort: daemon down / no compose file →
// { services: [], available: false }, never a 500.

/**
 * This workspace feature's intercept rows keyed by service, or null when the
 * state couldn't be read at all (no feature, or the read failed).
 *
 * All telepresence/services.yaml knowledge stays in sandbox-core. This used to
 * spawn `sandbox status --intercepts --json` and parse the result back into the
 * object core had just serialised; `getIntercepts()` is that object, already
 * grouped feature → service (note 087 — the CLI is not a data source for code
 * that can import the library).
 */
async function interceptsByService(project) {
  const feature = await readFeature(project);
  if (!feature) return null;
  try {
    const { byFeature } = await getIntercepts();
    // Telepresence down / not installed yields no rows rather than an error, and
    // an empty map is the same "no intercept for this service" every row already
    // renders — distinct from the null above, which means the lookup itself failed.
    return { feature, byService: byFeature.get(feature) ?? new Map() };
  } catch {
    return null;
  }
}

/**
 * Intercept fields for one compose row. A missing row is disabled-and-explained
 * rather than hidden, so "why is there no toggle here?" is answerable on hover.
 *
 * `mine` is resolved here, not in the browser: only one intercept can exist per
 * Deployment, so an intercept owned by another feature must never render as the
 * user's own. Unknown ownership counts as not-mine — wrong-but-safe.
 */
function interceptFields(row, feature, lookupFailed) {
  if (!row) {
    return {
      interceptable: false,
      blocker: lookupFailed
        ? "intercept state unavailable"
        : "not an interceptable service of this workspace",
      intercepted: false,
      interceptedBy: null,
      mine: false,
    };
  }
  return {
    interceptable: row.interceptable,
    blocker: row.blocker,
    intercepted: row.intercepted,
    interceptedBy: row.intercepted_by ?? null,
    mine: Boolean(row.intercepted) && row.intercepted_by === feature,
  };
}

router.get("/docker", async (req, res) => {
  const project = req.query.project;
  if (!project || typeof project !== "string") return res.json({ services: [] });

  // Independent reads — a failed intercept lookup must not cost the service list.
  const [ps, intercepts] = await Promise.all([
    execFileP("docker", ["compose", "ps", "--format", "json"], {
      cwd: project,
      timeout: 8000,
      env: childEnv(), // `docker` is a PATH lookup — a GUI-launched server has none
    }).catch(() => null),
    interceptsByService(project),
  ]);
  if (!ps) return res.json({ services: [], available: false });

  const services = parseComposePs(ps.stdout).map((s) => ({
    ...s,
    ...interceptFields(
      intercepts?.byService.get(s.service),
      intercepts?.feature ?? null,
      intercepts === null,
    ),
  }));
  res.json({ services });
});

// ── Lifecycle actions (up / stop / restart / down) ─────────────────────────
const WORKSPACE_ACTIONS = new Set(["up", "stop", "restart", "down"]);

/**
 * The `sandbox` wrapper, or null when it can't be found.
 *
 * Resolution belongs to sandbox-core (SANDBOX_BIN → SANDBOX_ROOT → walk-up →
 * ~/.local/bin symlink) — this plugin used to carry its own two-step copy that
 * knew nothing about SANDBOX_ROOT, so it drove the globally-linked checkout
 * instead of the running one. sandbox-core throws a WorkspaceError; every call
 * site here already branches on a falsy bin, so translate rather than spread
 * try/catch through them.
 */
async function sandboxBin() {
  try {
    return await resolveSandboxBin();
  } catch {
    return null;
  }
}

const NOT_FOUND = "sandbox CLI not found (set SANDBOX_ROOT, or SANDBOX_BIN for the wrapper itself)";

/**
 * Stream `sandbox <args>` to the client as chunked text/plain, as the child
 * emits it (self-contained live streaming; no dependency on claudeck's core
 * WebSocket). The terminating `[exit N]` line carries the outcome — callers must
 * have validated everything before this point, since no JSON error can follow
 * the first written byte.
 */
function streamSandbox(res, bin, args, cwd) {
  res.set({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no", // don't let a proxy buffer the stream
  });

  const child = spawn(bin, args, { cwd, env: childEnv() });
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 10 * 60 * 1000);

  child.stdout.on("data", (d) => res.write(d));
  child.stderr.on("data", (d) => res.write(d));
  child.on("error", (err) => res.write(`\n[error] ${err.message}\n`));
  child.on("close", (code) => {
    clearTimeout(killTimer);
    res.end(`\n[exit ${code ?? "?"}]\n`);
  });

  // Browser navigated away / aborted the fetch → kill the child.
  res.on("close", () => {
    clearTimeout(killTimer);
    if (child.exitCode === null) child.kill("SIGKILL");
  });
}

// POST { project, action } → streams `sandbox <action>`. action is
// allowlist-validated (it selects the command); cwd = workspace dir so the CLI
// resolves feature/slot from that workspace's .env.
router.post("/action", async (req, res) => {
  const { project, action } = req.body || {};
  if (!project || typeof project !== "string") return res.status(400).json({ error: "missing project" });
  if (!WORKSPACE_ACTIONS.has(action)) return res.status(400).json({ error: "invalid action" });

  const bin = await sandboxBin();
  if (!bin) return res.status(500).json({ error: NOT_FOUND });

  streamSandbox(res, bin, [action], project);
});

// POST { project, service, leave } → streams `sandbox intercept -s <service>`
// (plus `--leave`). Deliberately not folded into /action: that route's allowlist
// is tight because `action` selects the command, and threading `-s <service>`
// through it would loosen that for no gain. `service` reaches the child as an
// argv element, never a shell string, and the CLI rejects services that aren't
// local to the workspace or aren't interceptable.
router.post("/intercept", async (req, res) => {
  const { project, service, leave } = req.body || {};
  if (!project || typeof project !== "string") return res.status(400).json({ error: "missing project" });
  if (!service || typeof service !== "string") return res.status(400).json({ error: "missing service" });

  const bin = await sandboxBin();
  if (!bin) return res.status(500).json({ error: NOT_FOUND });

  const args = ["intercept", "-s", service];
  if (leave) args.push("--leave");
  streamSandbox(res, bin, args, project);
});

/** The workspace name for a project path, or null when it isn't a workspace. */
async function workspaceNameFor(project) {
  try {
    const { workspaces } = await listWorkspaces();
    return workspaceNameForPath(workspaces, project);
  } catch {
    return null;
  }
}

// POST { project } → launch the feature's tagged browser window (X-Feature
// cookie + title/badge tag). In-process via sandbox-core, which returns as soon
// as the window is up and supervises it in the background for the window's
// life; it used to spawn `sandbox open` detached, whose failures were invisible
// behind `stdio: "ignore"`.
router.post("/open", async (req, res) => {
  const { project } = req.body || {};
  if (!project || typeof project !== "string") return res.status(400).json({ error: "missing project" });

  const name = await workspaceNameFor(project);
  if (!name) {
    return res.status(400).json({ error: `Not a sandbox workspace: ${project}` });
  }

  try {
    await openFeatureBrowser(name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create Workspace: schema, Jira pre-fill, prompt refine, streamed create ──
// All core-backed. Best-effort: sandbox-core failures degrade to an error payload
// (GET/POST JSON routes) or an [error]/[exit 1] stream tail (create).

router.get("/form-schema", async (_req, res) => {
  try {
    res.json(await getFormSchema());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/jira-form-data", async (req, res) => {
  const ref = typeof req.body?.ref === "string" ? req.body.ref.trim() : "";
  if (!ref) return res.json({});
  try {
    res.json(await fetchJiraFormData(ref));
  } catch {
    res.json({}); // best-effort pre-fill; leave fields as-is on failure
  }
});

router.post("/refine-prompt", async (req, res) => {
  const { text, instruction, formData } = req.body || {};
  try {
    const refined = await refinePrompt(text ?? "", instruction ?? "", formData ?? {});
    res.json({ refined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/create", async (req, res) => {
  const formData = req.body?.formData;
  if (!formData || typeof formData !== "object") {
    return res.status(400).json({ error: "missing formData" });
  }
  res.set({
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  try {
    // No res.on("close") kill here (unlike /action): a create is allowed to
    // finish so an aborted fetch never leaves a half-created workspace.
    const result = await createWorkspace(formData, {
      open: false,
      onData: (chunk) => res.write(chunk),
    });
    if (result.workspacePath) res.write(`\n[workspace] ${result.workspacePath}\n`);
    res.end("[exit 0]\n");
  } catch (err) {
    res.write(`\n[error] ${err.message}\n`);
    res.end("[exit 1]\n");
  }
});

// ── Keep claudeck's project list in step with the workspaces on disk ────────
// folders.json is what the chat project picker reads (/api/projects). Mirror
// the workspaces root into it at startup and whenever that directory changes,
// so a workspace created or deleted by any surface (CLI, VS Code, this plugin,
// plain `rm -rf`) shows up on the next page load instead of going stale.
const foldersFile = join(
  process.env.CLAUDECK_HOME || join(homedir(), ".claudeck"),
  "config",
  "folders.json",
);

async function syncFolders() {
  try {
    const { root, workspaces } = await listWorkspaces();
    const existing = JSON.parse(await readFile(foldersFile, "utf-8").catch(() => "[]"));
    const next = mergeFolders(existing, workspaces, root);
    await writeFile(foldersFile, JSON.stringify(next, null, 2) + "\n");
    return root;
  } catch (err) {
    console.error(`[sandbox-workspace] folders.json sync failed: ${err.message}`);
    return null;
  }
}

const syncedRoot = await syncFolders();
if (syncedRoot) {
  let pending = null;
  try {
    // ponytail: coarse watch on the root — every event re-syncs the whole list;
    // fine-grained diffing only if the workspace count ever gets large.
    watch(syncedRoot, () => {
      clearTimeout(pending);
      pending = setTimeout(syncFolders, 250).unref();
    }).unref();
  } catch (err) {
    console.error(`[sandbox-workspace] cannot watch ${syncedRoot}: ${err.message}`);
  }
}

export default router;
