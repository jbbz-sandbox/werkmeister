# Claudeck Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining `SECURITY_AUDIT.md` findings in `apps/claudeck`, chiefly by stopping repository-derived data (branch names, file paths, commit messages) from reaching a shell.

**Architecture:** `/api/exec` gains an argv mode (`execFile`, no shell) and loses the string mode that guessed whether to use a shell. The one legitimate shell caller — the `/run` slash command, where the user typed a shell command on purpose — moves to an explicitly named `shellCommand` field. Four smaller fixes follow: HTTP query-parameter tokens removed, a login rate limiter, migration errors that propagate, and VAPID key warnings.

**Tech Stack:** Node ≥18 ESM, Express 4, better-sqlite3, vitest + supertest, happy-dom for frontend tests. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-25-claudeck-hardening-design.md`

## Global Constraints

- **No new runtime dependencies.** The spec rejects `express-rate-limit`, `joi` and `zod` by name.
- **Node ≥18, ESM only** (`"type": "module"` in `apps/claudeck/package.json`).
- All commands run from `apps/claudeck/`.
- **Baseline: 2720 tests across 113 files pass** (`npm test`). Every task ends with the full suite green, not just its own file.
- Tests live beside their peers: backend routes in `tests/unit/backend/routes/`, frontend in `tests/unit/frontend/`.
- **`argv[0]` is never shell-interpreted.** Any code path reaching `exec()` must be traceable to the `shellCommand` field.
- Commit after each task. Branch: `fix/claudeck-hardening`.

## Review Focus

Failure modes the spec implies that no task's happy path would catch. Each is assigned to the task that owns the code, and appears in that task's tests.

1. **A path argument beginning with `-`** (`-rf`, `--version`) is read by `git` as an option once quoting no longer hides it — argv makes this *newly* reachable, so every path-taking git command needs `--`. → Task 1 (route passthrough), Task 2 (call sites).
2. **Paths and branch names containing spaces** silently split under the old whitespace heuristic; argv must keep them as one argument. → Task 1.
3. **Multi-line commit messages** — the old `"` escape mangled them; argv must pass the newlines through untouched. → Task 2.
4. **A successful login must not count toward the rate limit**, and the window must actually expire, or the limiter locks the user out of their own machine. → Task 5.
5. **A migration error that is *not* "duplicate column"** (disk full, locked database) must stop startup rather than be swallowed as "already exists". → Task 6.

---

### Task 1: argv mode in `/api/exec`

Additive. The existing `command` field keeps working so nothing breaks mid-plan; Task 3 removes it.

**Files:**
- Modify: `server/routes/exec.js` (whole file, currently 37 lines)
- Test: `tests/unit/backend/routes/exec.test.js`

**Interfaces:**
- Produces: `POST /api/exec` accepting `{ argv: string[], cwd?: string }`, responding `{ command: string, stdout: string, stderr: string, exitCode: number }`. `command` in the response is a display string (`argv.join(" ")`), not anything that gets executed.
- Consumes: nothing.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe("exec routes", ...)` block in `tests/unit/backend/routes/exec.test.js`:

```js
  // ── POST / — argv mode ───────────────────────────────────────────────────
  describe("POST / — argv mode", () => {
    it("runs argv via execFile and never through a shell", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "ok", ""));

      const res = await request(app)
        .post("/")
        .send({ argv: ["git", "status", "--porcelain=v1"] });

      expect(res.status).toBe(200);
      expect(res.body.stdout).toBe("ok");
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["status", "--porcelain=v1"],
        expect.any(Object),
        expect.any(Function),
      );
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("passes a command-substitution branch name as one literal argument", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      await request(app)
        .post("/")
        .send({ argv: ["git", "checkout", "main$(echo INJECTED)"] });

      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["checkout", "main$(echo INJECTED)"],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("keeps a path containing spaces as a single argument", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      await request(app)
        .post("/")
        .send({ argv: ["git", "add", "--", "my notes/todo list.md"] });

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["add", "--", "my notes/todo list.md"],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("passes a leading-dash path through untouched (callers add --)", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      await request(app)
        .post("/")
        .send({ argv: ["git", "add", "--", "-rf"] });

      expect(mockExecFile).toHaveBeenCalledWith(
        "git",
        ["add", "--", "-rf"],
        expect.any(Object),
        expect.any(Function),
      );
    });

    it("uses execFile on Windows too — argv has no platform heuristic", async () => {
      const { restore } = withPlatform("win32");
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "out", ""));

      const res = await request(app).post("/").send({ argv: ["dir"] });
      restore();

      expect(res.status).toBe(200);
      expect(mockExecFile).toHaveBeenCalled();
      expect(mockExec).not.toHaveBeenCalled();
    });

    it("echoes a display string built from argv", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      const res = await request(app)
        .post("/")
        .send({ argv: ["git", "log", "--format=%h|%s"] });

      expect(res.body.command).toBe("git log --format=%h|%s");
    });

    it("honours cwd and the standard exec options", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      await request(app)
        .post("/")
        .send({ argv: ["ls"], cwd: "/custom/dir" });

      expect(mockExecFile).toHaveBeenCalledWith(
        "ls",
        [],
        expect.objectContaining({
          cwd: "/custom/dir",
          timeout: 30000,
          maxBuffer: 512 * 1024,
        }),
        expect.any(Function),
      );
    });

    it("defaults cwd to homedir", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) => cb(null, "", ""));

      await request(app).post("/").send({ argv: ["ls"] });

      expect(mockExecFile).toHaveBeenCalledWith(
        "ls",
        [],
        expect.objectContaining({ cwd: "/mock/home" }),
        expect.any(Function),
      );
    });

    it("reports the exit code on failure", async () => {
      mockExecFile.mockImplementation((cmd, args, opts, cb) =>
        cb({ code: 128 }, "", "fatal: not a git repository"),
      );

      const res = await request(app).post("/").send({ argv: ["git", "status"] });

      expect(res.status).toBe(200);
      expect(res.body.exitCode).toBe(128);
      expect(res.body.stderr).toBe("fatal: not a git repository");
    });

    it.each([
      ["a string", { argv: "git status" }],
      ["an empty array", { argv: [] }],
      ["non-string elements", { argv: ["git", 7] }],
      ["a nested array", { argv: ["git", ["status"]] }],
    ])("rejects argv that is %s", async (_label, body) => {
      const res = await request(app).post("/").send(body);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("argv must be a non-empty array of strings");
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/unit/backend/routes/exec.test.js`
Expected: the new `argv mode` tests FAIL — the route ignores `argv` and returns 400 `"command is required"`.

- [ ] **Step 3: Write the implementation**

Replace the whole of `server/routes/exec.js` with:

```js
import { Router } from "express";
import { exec, execFile } from "child_process";
import { homedir } from "os";

const router = Router();

const EXEC_OPTS = { timeout: 30000, maxBuffer: 512 * 1024 };

// `display` is echoed back for the UI only — it is never executed.
function reply(res, display) {
  return (err, stdout, stderr) => {
    res.json({
      command: display,
      stdout: stdout || "",
      stderr: stderr || "",
      exitCode: err ? (err.code ?? 1) : 0,
    });
  };
}

router.post("/", (req, res) => {
  const { command, argv, cwd } = req.body;
  const opts = { ...EXEC_OPTS, cwd: cwd || homedir() };

  // argv mode: no shell, ever. Arguments reach the program exactly as given,
  // so repository data (branch names, paths, commit messages) cannot be read
  // as syntax. Callers pass `--` before any path that could start with a dash.
  if (argv !== undefined) {
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((a) => typeof a === "string")
    ) {
      return res.status(400).json({ error: "argv must be a non-empty array of strings" });
    }
    return execFile(argv[0], argv.slice(1), opts, reply(res, argv.join(" ")));
  }

  if (!command) return res.status(400).json({ error: "command is required" });

  // Legacy string mode — removed in Task 3 once every caller uses argv.
  const parts = command.split(/\s+/);
  const isSimple =
    parts.length <= 2 &&
    !command.includes("|") &&
    !command.includes(">") &&
    !command.includes("&");
  if (isSimple && process.platform !== "win32") {
    execFile(parts[0], parts.slice(1), opts, reply(res, command));
  } else {
    exec(command, opts, reply(res, command));
  }
});

export default router;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/unit/backend/routes/exec.test.js`
Expected: PASS, including the pre-existing `command`-mode tests (the refactor to `EXEC_OPTS` and `reply()` preserves their assertions).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: 113 files pass.

- [ ] **Step 6: Commit**

```bash
git add server/routes/exec.js tests/unit/backend/routes/exec.test.js
git commit -m "feat(exec): argv mode that never reaches a shell"
```

---

### Task 2: Move the UI off shell strings

**Files:**
- Modify: `public/js/core/api.js:483-490` (add `execArgv`)
- Modify: `public/js/panels/git-panel.js` (13 call sites)
- Modify: `public/js/ui/status-bar.js:78`
- Modify: `public/js/features/projects.js:449-455`
- Test: `tests/unit/frontend/api.test.js`, `tests/unit/frontend/git-panel.test.js`

**Interfaces:**
- Consumes: `POST /api/exec { argv, cwd }` from Task 1.
- Produces: `execArgv(argv: string[], cwd?: string): Promise<{command, stdout, stderr, exitCode}>`, exported from `public/js/core/api.js`. `execCommand` still exists for `/run`; Task 3 renames it.

- [ ] **Step 1: Write the failing test for `execArgv`**

In `tests/unit/frontend/api.test.js`, replace the `describe("Exec", ...)` block with:

```js
describe("Exec", () => {
  it("execCommand sends POST with command and cwd", async () => {
    await execCommand("ls -la", "/home");
    expect(mockFetch).toHaveBeenCalledWith("/api/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "ls -la", cwd: "/home" }),
    });
  });

  it("execArgv sends POST with an argv array and cwd", async () => {
    await execArgv(["git", "checkout", "my branch"], "/home");
    expect(mockFetch).toHaveBeenCalledWith("/api/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ argv: ["git", "checkout", "my branch"], cwd: "/home" }),
    });
  });
});
```

Add `execArgv` to the import list at the top of `tests/unit/frontend/api.test.js` alongside `execCommand`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/frontend/api.test.js`
Expected: FAIL — `execArgv is not a function`.

- [ ] **Step 3: Add `execArgv` to the API client**

In `public/js/core/api.js`, directly after `execCommand`:

```js
// argv form: no shell on the server. Use this for every command the UI builds
// itself — anything containing a branch name, path or commit message.
export async function execArgv(argv, cwd) {
  const res = await fetch("/api/exec", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ argv, cwd }),
  });
  return res.json();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/frontend/api.test.js`
Expected: PASS.

- [ ] **Step 5: Convert every git-panel call site**

In `public/js/panels/git-panel.js`, change the import on line 5:

```js
import { execArgv } from "../core/api.js";
```

Then replace each call. Left column is the current text, right is the replacement:

| Line | Was | Becomes |
|---|---|---|
| 26 | `execCommand("git branch --no-color", cwd)` | `execArgv(["git", "branch", "--no-color"], cwd)` |
| 50 | `execCommand(\`git checkout "${branch}"\`, cwd)` | `execArgv(["git", "checkout", branch], cwd)` |
| 104 | `execCommand("git status --porcelain=v1", cwd)` | `execArgv(["git", "status", "--porcelain=v1"], cwd)` |
| 214 | `execCommand(\`git checkout -- "${f.file}"\`, cwd)` | `execArgv(["git", "checkout", "--", f.file], cwd)` |
| 235 | `execCommand(\`cat "${file}"\`, cwd)` | `execArgv(["cat", "--", file], cwd)` |
| 240 | `execCommand(\`git diff --cached -- "${file}"\`, cwd)` | `execArgv(["git", "diff", "--cached", "--", file], cwd)` |
| 243 | `execCommand(\`git diff -- "${file}"\`, cwd)` | `execArgv(["git", "diff", "--", file], cwd)` |
| 298 | `execCommand('git log --oneline --no-color -10 --format="%h\|%s\|%ar"', cwd)` | `execArgv(["git", "log", "--oneline", "--no-color", "-10", "--format=%h\|%s\|%ar"], cwd)` |
| 329 | `execCommand(\`git show "${hash}" --stat --patch\`, cwd)` | `execArgv(["git", "show", hash, "--stat", "--patch"], cwd)` |
| 340 | `execCommand("git rev-parse --abbrev-ref HEAD", cwd)` | `execArgv(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd)` |
| 348 | `execCommand("git rev-list --left-right --count HEAD...@{upstream}", cwd)` | `execArgv(["git", "rev-list", "--left-right", "--count", "HEAD...@{upstream}"], cwd)` |

Note on line 298: the surrounding single quotes on `--format` were consumed by the shell. In argv form the value is one argument and the quotes must go, or they end up in the output and `line.split("|")` breaks.

The bulk-stage block at lines 170-176 becomes:

```js
    const cwd = getCwd();
    if (!cwd) return;
    const paths = files.map((f) => f.file);
    const argv = action === "stage"
      ? ["git", "add", "--", ...paths]
      : ["git", "reset", "HEAD", "--", ...paths];
    await execArgv(argv, cwd);
    await loadStatus();
```

The per-file block at lines 197-201 becomes:

```js
      const cwd = getCwd();
      if (!cwd) return;
      const argv = action === "stage"
        ? ["git", "add", "--", f.file]
        : ["git", "reset", "HEAD", "--", f.file];
      await execArgv(argv, cwd);
      await loadStatus();
```

The commit block at lines 265-266 becomes — note the escape is *deleted*, not adjusted:

```js
    const result = await execArgv(["git", "commit", "-m", msg], cwd);
```

Delete the now-unused line `const escaped = msg.replace(/"/g, '\\"');`.

- [ ] **Step 6: Convert the two remaining callers**

`public/js/ui/status-bar.js:78`:

```js
    const data = await api.execArgv(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd);
```

`public/js/features/projects.js:449-455`:

```js
    await fetch("/api/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ argv: ["code", "."], cwd: path }),
    });
```

- [ ] **Step 7: Update the git-panel test mocks**

In `tests/unit/frontend/git-panel.test.js`, rename the spy and both mock factories (lines 8, 20-22, and the second factory at line 85):

```js
const mockExecArgv = vi.fn(() =>
  Promise.resolve({ stdout: "", stderr: "", exitCode: 0, error: false })
);

vi.mock("../../../public/js/core/api.js", () => ({
  execArgv: (...args) => mockExecArgv(...args),
}));
```

Update the assertions at lines 113-139 to expect arrays, and add the Review Focus #3 case:

```js
  it("gitCommitBtn click passes the message as one argv element", async () => {
    document.getElementById("git-commit-msg").value = 'fix: a "quoted" $(echo x)\nsecond line';
    document.getElementById("git-commit-btn").click();
    await Promise.resolve();

    expect(mockExecArgv).toHaveBeenCalledWith(
      ["git", "commit", "-m", 'fix: a "quoted" $(echo x)\nsecond line'],
      "/tmp/project",
    );
  });

  it("gitBranchSelect change checks out the branch as one argv element", async () => {
    const select = document.getElementById("git-branch-select");
    select.innerHTML = '<option value="feature/$(echo x)">feature</option>';
    select.value = "feature/$(echo x)";
    select.dispatchEvent(new Event("change"));
    await Promise.resolve();

    expect(mockExecArgv).toHaveBeenCalledWith(
      ["git", "checkout", "feature/$(echo x)"],
      "/tmp/project",
    );
  });
```

- [ ] **Step 8: Run the frontend tests**

First update `tests/unit/frontend/status-bar.test.js`, which mocks `execCommand`
at **lines 42 and 92**. Both become:

```js
  execArgv: vi.fn().mockResolvedValue({ stdout: "main" }),
```

`tests/unit/frontend/projects.test.js` does not mock the API client and needs no
change.

Run: `npx vitest run tests/unit/frontend/`
Expected: PASS.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: 113 files pass.

- [ ] **Step 10: Commit**

```bash
git add public/js tests/unit/frontend
git commit -m "fix(git-panel): build commands as argv, never shell strings

Branch names, paths and commit messages came from the repository and
reached a shell inside double quotes, which do not stop \$(...) or
backticks. Also repairs file preview, which the old two-part execFile
path broke by passing the quotes as part of the filename."
```

---

### Task 3: Remove the string mode; name the shell path

**Files:**
- Modify: `server/routes/exec.js`
- Modify: `public/js/core/api.js` (rename `execCommand` → `execShell`)
- Modify: `public/js/features/chat.js:988`
- Modify: `docs/DOCUMENTATION.md:435` and `:833`
- Test: `tests/unit/backend/routes/exec.test.js`, `tests/unit/frontend/api.test.js`

**Interfaces:**
- Produces: `POST /api/exec { shellCommand: string, cwd? }` is the only shell path. `command` is gone. `execShell(command, cwd)` replaces `execCommand` in the API client.

- [ ] **Step 1: Rewrite the route tests**

In `tests/unit/backend/routes/exec.test.js`, **delete** the entire `describe("POST /", ...)` block covering the legacy string mode — every test in it asserts the `isSimple` heuristic that this task removes. Keep `describe("POST / — argv mode", ...)` from Task 1 and add:

```js
  // ── POST / — shellCommand mode ───────────────────────────────────────────
  describe("POST / — shellCommand mode", () => {
    it("runs shellCommand through a shell, pipes and all", async () => {
      mockExec.mockImplementation((cmd, opts, cb) => cb(null, "result", ""));

      const res = await request(app)
        .post("/")
        .send({ shellCommand: "cat file.txt | grep pattern" });

      expect(res.status).toBe(200);
      expect(res.body.stdout).toBe("result");
      expect(mockExec).toHaveBeenCalledWith(
        "cat file.txt | grep pattern",
        expect.objectContaining({ cwd: "/mock/home", timeout: 30000, maxBuffer: 512 * 1024 }),
        expect.any(Function),
      );
    });

    it("uses a shell even for a one-word command — no heuristic remains", async () => {
      const { restore } = withPlatform("linux");
      mockExec.mockImplementation((cmd, opts, cb) => cb(null, "", ""));

      await request(app).post("/").send({ shellCommand: "ls" });
      restore();

      expect(mockExec).toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("rejects the removed `command` field rather than shelling out", async () => {
      const res = await request(app).post("/").send({ command: "ls -la /tmp" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("argv or shellCommand is required");
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it("returns 400 when neither field is present", async () => {
      const res = await request(app).post("/").send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("argv or shellCommand is required");
    });

    it("returns 400 for an empty shellCommand", async () => {
      const res = await request(app).post("/").send({ shellCommand: "" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("argv or shellCommand is required");
    });
  });
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run tests/unit/backend/routes/exec.test.js`
Expected: the `shellCommand` tests FAIL with 400 `"command is required"`.

- [ ] **Step 3: Simplify the route**

Replace the `router.post` body in `server/routes/exec.js` with:

```js
router.post("/", (req, res) => {
  const { shellCommand, argv, cwd } = req.body;
  const opts = { ...EXEC_OPTS, cwd: cwd || homedir() };

  // argv mode: no shell, ever. Arguments reach the program exactly as given,
  // so repository data (branch names, paths, commit messages) cannot be read
  // as syntax. Callers pass `--` before any path that could start with a dash.
  if (argv !== undefined) {
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((a) => typeof a === "string")
    ) {
      return res.status(400).json({ error: "argv must be a non-empty array of strings" });
    }
    return execFile(argv[0], argv.slice(1), opts, reply(res, argv.join(" ")));
  }

  // The only shell in the application. Reachable from one place: the `/run`
  // slash command, where the user typed a shell command and meant it. Named so
  // that `grep shellCommand` finds every caller. Nothing built from data
  // belongs here — use argv.
  if (!shellCommand) {
    return res.status(400).json({ error: "argv or shellCommand is required" });
  }
  exec(shellCommand, opts, reply(res, shellCommand));
});
```

- [ ] **Step 4: Run to verify the route tests pass**

Run: `npx vitest run tests/unit/backend/routes/exec.test.js`
Expected: PASS.

- [ ] **Step 5: Rename the client function**

In `public/js/core/api.js`, replace `execCommand` with:

```js
// Shell form: runs through a shell on the server. ONLY for commands the user
// typed themselves (the /run slash command). Anything the UI assembles from a
// branch name, path or message must use execArgv instead.
export async function execShell(command, cwd) {
  const res = await fetch("/api/exec", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shellCommand: command, cwd }),
  });
  return res.json();
}
```

In `public/js/features/chat.js:988`:

```js
      const data = await api.execShell(args, cwd);
```

- [ ] **Step 6: Update the client test**

In `tests/unit/frontend/api.test.js`, replace the `execCommand` case (and its import) with:

```js
  it("execShell sends POST with shellCommand and cwd", async () => {
    await execShell("ls -la | head", "/home");
    expect(mockFetch).toHaveBeenCalledWith("/api/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shellCommand: "ls -la | head", cwd: "/home" }),
    });
  });
```

- [ ] **Step 7: Update the docs**

`docs/DOCUMENTATION.md:435` — replace the table row:

```
| POST   | /api/exec            | Run a command: `argv` (no shell) or `shellCommand` (shell, /run only). 30s timeout |
```

`docs/DOCUMENTATION.md:833` — replace the sentence:

```
Git panel in the Git tab — all operations via `POST /api/exec` in `argv` form,
so branch names, paths and commit messages are passed as literal arguments and
never parsed by a shell.
```

- [ ] **Step 8: Verify no caller was missed**

Run: `grep -rn "execCommand\|\"command\":" public/ server/ --include='*.js'`
Expected: no results. Any hit is a caller that will now receive a 400.

- [ ] **Step 9: Run the full suite**

Run: `npm test`
Expected: 113 files pass.

- [ ] **Step 10: Commit**

```bash
git add server/routes/exec.js public/js docs/DOCUMENTATION.md tests
git commit -m "refactor(exec): drop the string mode, name the shell path

The isSimple heuristic guessed shell vs execFile by counting whitespace,
which both enabled injection and broke quoted two-part commands. The only
remaining shell is shellCommand, reachable from /run alone."
```

---

### Task 4: Stop accepting tokens in HTTP query parameters

**Files:**
- Modify: `server/auth.js:46-63` (`extractToken`)
- Test: `tests/unit/backend/auth.test.js`

**Interfaces:**
- Consumes: nothing. Produces: `extractToken(req)` no longer reads `?token=`. `wsToken(req)` is untouched.

- [ ] **Step 1: Write the failing test**

Add to the `describe("extractToken", ...)` block in `tests/unit/backend/auth.test.js` (replacing any existing test that asserts the query parameter *is* read):

```js
  it("ignores a token in the query string", () => {
    const req = mockReq({ url: "/api/sessions?token=secret123" });
    expect(auth.extractToken(req)).toBe(null);
  });

  it("still reads the Authorization header", () => {
    const req = mockReq({ headers: { host: "localhost:9009", authorization: "Bearer secret123" } });
    expect(auth.extractToken(req)).toBe("secret123");
  });

  it("still reads the cookie", () => {
    const req = mockReq({ headers: { host: "localhost:9009", cookie: "claudeck_token=secret123" } });
    expect(auth.extractToken(req)).toBe("secret123");
  });
```

And, to pin that the WebSocket exception survives:

```js
describe("verifyWsClient query token", () => {
  it("still accepts ?token= on the upgrade — browsers cannot set WS headers", () => {
    process.env.CLAUDECK_TOKEN = "correcttoken123";
    process.env.CLAUDECK_AUTH_LOCALHOST = "true";
    const cb = vi.fn();
    auth.verifyWsClient(
      {
        req: {
          headers: { host: "localhost:9009" },
          method: "GET",
          url: "/ws?token=correcttoken123",
          socket: { remoteAddress: "192.168.1.100" },
        },
      },
      cb,
    );
    expect(cb).toHaveBeenCalledWith(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/backend/auth.test.js`
Expected: `"ignores a token in the query string"` FAILS, returning `"secret123"`.

- [ ] **Step 3: Remove the query branch**

In `server/auth.js`, replace `extractToken` with:

```js
export function extractToken(req) {
  // 1. Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  // 2. Cookie
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.claudeck_token) {
    return cookies.claudeck_token;
  }
  // Deliberately no query-parameter fallback: URLs reach access logs, browser
  // history and Referer headers. The WebSocket upgrade is the one exception
  // (see wsToken) because a browser cannot set headers on that handshake.
  return null;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/backend/auth.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`

```bash
git add server/auth.js tests/unit/backend/auth.test.js
git commit -m "fix(auth): stop accepting tokens in HTTP query parameters"
```

---

### Task 5: Rate-limit token submission

**Files:**
- Modify: `server/auth.js` (add limiter, use it in `loginHandler`)
- Test: `tests/unit/backend/auth.test.js`

**Interfaces:**
- Produces: `loginHandler` returns 429 after 10 failed attempts from one address within 15 minutes. Exports `__resetLoginAttempts()` for tests.

- [ ] **Step 1: Write the failing tests**

```js
describe("loginHandler rate limiting", () => {
  beforeEach(() => {
    process.env.CLAUDECK_AUTH = "true";
    process.env.CLAUDECK_TOKEN = "correcttoken123";
    auth.__resetLoginAttempts();
  });

  it("returns 429 after 10 failed attempts", () => {
    for (let i = 0; i < 10; i++) {
      const res = mockRes();
      auth.loginHandler(mockReq({ body: { token: "wrong" } }), res);
      expect(res._status).toBe(401);
    }
    const res = mockRes();
    auth.loginHandler(mockReq({ body: { token: "wrong" } }), res);
    expect(res._status).toBe(429);
  });

  it("blocks a correct token once the limit is hit", () => {
    for (let i = 0; i < 11; i++) {
      auth.loginHandler(mockReq({ body: { token: "wrong" } }), mockRes());
    }
    const res = mockRes();
    auth.loginHandler(mockReq({ body: { token: "correcttoken123" } }), res);
    expect(res._status).toBe(429);
  });

  it("does not count successful logins", () => {
    for (let i = 0; i < 20; i++) {
      const res = mockRes();
      auth.loginHandler(mockReq({ body: { token: "correcttoken123" } }), res);
      expect(res._status).toBe(200);
    }
  });

  it("counts each remote address separately", () => {
    for (let i = 0; i < 11; i++) {
      auth.loginHandler(mockReq({ body: { token: "wrong" }, ip: "10.0.0.1" }), mockRes());
    }
    const res = mockRes();
    auth.loginHandler(mockReq({ body: { token: "correcttoken123" }, ip: "10.0.0.2" }), res);
    expect(res._status).toBe(200);
  });

  it("forgets attempts once the window expires", () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 11; i++) {
        auth.loginHandler(mockReq({ body: { token: "wrong" } }), mockRes());
      }
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      const res = mockRes();
      auth.loginHandler(mockReq({ body: { token: "correcttoken123" } }), res);
      expect(res._status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

`mockRes` currently leaves `_status` at 200 when only `json()` is called, which is what the success cases assert.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/backend/auth.test.js`
Expected: FAIL — `__resetLoginAttempts is not a function`.

- [ ] **Step 3: Implement the limiter**

In `server/auth.js`, above `loginHandler`:

```js
// ── Login rate limiting ─────────────────────────────────────
// A 32-byte token is not guessable; this exists so a local process cannot sit
// and grind, and so repeated failures are visible. Only FAILED attempts count,
// so the legitimate user can never lock themselves out by logging in.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const loginAttempts = new Map(); // address → { count, windowStart }

function clientAddress(req) {
  return req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || "unknown";
}

function loginRateLimited(address) {
  const entry = loginAttempts.get(address);
  if (!entry) return false;
  if (Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.delete(address);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(address) {
  const entry = loginAttempts.get(address);
  if (!entry || Date.now() - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(address, { count: 1, windowStart: Date.now() });
    return;
  }
  entry.count += 1;
}

/** Test seam — the limiter is module-level state. */
export function __resetLoginAttempts() {
  loginAttempts.clear();
}
```

Replace `loginHandler`'s opening with:

```js
export function loginHandler(req, res) {
  if (!isAuthEnabled()) return res.json({ ok: true });

  const address = clientAddress(req);
  if (loginRateLimited(address)) {
    return res.status(429).json({ error: "Too many attempts — try again later" });
  }

  const { token } = req.body || {};
  if (!validateToken(token)) {
    recordLoginFailure(address);
    return res.status(401).json({ error: "Invalid token" });
  }
  loginAttempts.delete(address);
```

The rest of the function (the `res.cookie(...)` call and `res.json({ ok: true })`) is unchanged.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/unit/backend/auth.test.js`
Expected: PASS.

- [ ] **Step 5: Run the full suite and commit**

Run: `npm test`

```bash
git add server/auth.js tests/unit/backend/auth.test.js
git commit -m "feat(auth): rate-limit failed login attempts"
```

---

### Task 6: Let real migration failures propagate

**Files:**
- Modify: `db/sqlite.js:62-86`, `:147-148`
- Test: `tests/unit/backend/db.test.js`

**Interfaces:**
- Produces: `addColumn(sql)` — internal to `db/sqlite.js`, exported only for the test.

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/backend/db.test.js`:

```js
describe("addColumn migration helper", () => {
  it("swallows a duplicate-column error", async () => {
    const { addColumn } = await import("../../../db/sqlite.js");
    const db = {
      exec: () => {
        throw new Error("duplicate column name: chat_id");
      },
    };
    expect(() => addColumn(db, "ALTER TABLE messages ADD COLUMN chat_id TEXT")).not.toThrow();
  });

  it("rethrows anything else", async () => {
    const { addColumn } = await import("../../../db/sqlite.js");
    const db = {
      exec: () => {
        throw new Error("database or disk is full");
      },
    };
    expect(() => addColumn(db, "ALTER TABLE messages ADD COLUMN chat_id TEXT")).toThrow(
      /disk is full/,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/backend/db.test.js`
Expected: FAIL — `addColumn` is not exported.

- [ ] **Step 3: Add the helper and apply it**

In `db/sqlite.js`, immediately before the `// Migrations` comment at line 62:

```js
/**
 * Idempotent column add. SQLite reports a re-added column as
 * "duplicate column name: X"; every other error (disk full, locked database,
 * malformed schema) means the migration genuinely did not apply, and booting on
 * a half-migrated schema only moves the failure somewhere less obvious.
 *
 * `db` is a parameter rather than the module-level handle so this is testable.
 */
export function addColumn(db, sql) {
  try {
    db.exec(sql);
  } catch (e) {
    if (!/duplicate column name/i.test(e.message)) throw e;
  }
}
```

Replace all 19 `try { db.exec(\`ALTER TABLE ...\`); } catch { /* exists */ }` lines (62-86) with calls, keeping the existing grouping comments. For example:

```js
// Migrations
addColumn(db, `ALTER TABLE messages ADD COLUMN chat_id TEXT DEFAULT NULL`);
addColumn(db, `ALTER TABLE sessions ADD COLUMN title TEXT DEFAULT NULL`);
addColumn(db, `ALTER TABLE sessions ADD COLUMN pinned INTEGER DEFAULT 0`);
addColumn(db, `ALTER TABLE costs ADD COLUMN input_tokens INTEGER DEFAULT 0`);
addColumn(db, `ALTER TABLE costs ADD COLUMN output_tokens INTEGER DEFAULT 0`);
// New columns for costs table
addColumn(db, `ALTER TABLE costs ADD COLUMN model TEXT DEFAULT NULL`);
addColumn(db, `ALTER TABLE costs ADD COLUMN stop_reason TEXT DEFAULT NULL`);
addColumn(db, `ALTER TABLE costs ADD COLUMN is_error INTEGER DEFAULT 0`);
addColumn(db, `ALTER TABLE costs ADD COLUMN cache_read_tokens INTEGER DEFAULT 0`);
addColumn(db, `ALTER TABLE costs ADD COLUMN cache_creation_tokens INTEGER DEFAULT 0`);
// New columns for messages table (workflow metadata)
addColumn(db, `ALTER TABLE messages ADD COLUMN workflow_id TEXT DEFAULT NULL`);
addColumn(db, `ALTER TABLE messages ADD COLUMN workflow_step_index INTEGER DEFAULT NULL`);
addColumn(db, `ALTER TABLE messages ADD COLUMN workflow_step_label TEXT DEFAULT NULL`);
// AI-generated session summary
addColumn(db, `ALTER TABLE sessions ADD COLUMN summary TEXT DEFAULT NULL`);
// Todo archive
addColumn(db, `ALTER TABLE todos ADD COLUMN archived INTEGER DEFAULT 0`);
// Todo priority (0=none, 1=low, 2=medium, 3=high)
addColumn(db, `ALTER TABLE todos ADD COLUMN priority INTEGER DEFAULT 0`);
// Session branching / conversation forking
addColumn(db, `ALTER TABLE sessions ADD COLUMN parent_session_id TEXT DEFAULT NULL`);
addColumn(db, `ALTER TABLE sessions ADD COLUMN fork_message_id INTEGER DEFAULT NULL`);
```

Line 147 becomes `addColumn(db, \`ALTER TABLE memories ADD COLUMN content_hash TEXT\`);`.

Line 148 loses its wrapper entirely — `CREATE UNIQUE INDEX IF NOT EXISTS` is already idempotent and any error it raises is real:

```js
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_hash ON memories(project_path, content_hash)`);
```

Leave the unrelated catches at lines 228 and 1650 alone — they are not migrations.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/backend/db.test.js`
Expected: PASS.

- [ ] **Step 5: Verify a real database still opens**

Run: `node -e 'import("./db.js").then(() => console.log("schema ok"))'`
Expected: `schema ok` — this runs every migration against your actual database (`~/.claudeck/data.db`; `CLAUDECK_HOME` overrides the directory), which already has all the columns, so it exercises the duplicate-column path 20 times.

- [ ] **Step 6: Run the full suite and commit**

Run: `npm test`

```bash
git add db/sqlite.js tests/unit/backend/db.test.js
git commit -m "fix(db): let real migration failures stop startup"
```

---

### Task 7: Announce VAPID key generation

**Files:**
- Create: `server/vapid.js`
- Modify: `server.js:60-76` (and the `fs` import on line 10)
- Modify: `db/sqlite.js:1275-1295` (add the subscription count)
- Test: `tests/unit/backend/vapid-warning.test.js` (new)

**Interfaces:**
- Consumes: `countPushSubscriptions()` from `db.js`. **It does not exist yet — Step 0 adds it.**
- Produces: `resolveVapidKeys(webpush, log = console)` in `server/vapid.js`, returning `{ publicKey, privateKey }`.

- [ ] **Step 0: Add the subscription count to the database layer**

In `db/sqlite.js`, extend the `pushStmts` object at line 1275 with a `count`
statement and export a wrapper beside the others at line 1295:

```js
const pushStmts = {
  upsert: db.prepare(
    `INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth)
     VALUES (?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET keys_p256dh = excluded.keys_p256dh, keys_auth = excluded.keys_auth`
  ),
  delete: db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`),
  getAll: db.prepare(`SELECT * FROM push_subscriptions`),
  count: db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`),
};
```

```js
// Sync, unlike its async neighbours above: VAPID setup runs before the server
// listens and has no await to give it.
export function countPushSubscriptions() {
  return pushStmts.count.get().n;
}
```

- [ ] **Step 1: Extract the block into a testable function**

The current code is an anonymous block in `server.js`, which cannot be tested. Move it to `server/vapid.js`:

```js
import { appendFileSync } from "fs";
import { join } from "path";
import { userDir } from "./paths.js";
import { countPushSubscriptions } from "../db.js";

/**
 * Resolve the VAPID key pair, generating and persisting one if absent.
 *
 * Losing these keys is silent and total: every existing browser subscription is
 * bound to the old public key and simply stops receiving pushes, with no error
 * on either side. Hence the noise.
 */
export function resolveVapidKeys(webpush, log = console) {
  const existing = {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
  };
  if (existing.publicKey && existing.privateKey) return existing;

  const generated = webpush.generateVAPIDKeys();
  const envPath = join(userDir, ".env");

  let orphaned = 0;
  try {
    orphaned = countPushSubscriptions();
  } catch {
    // Database not ready yet — the count is advisory only.
  }
  if (orphaned > 0) {
    log.warn(
      `WARNING: generating new VAPID keys — ${orphaned} existing push subscription(s) ` +
        `are now orphaned and will never receive another notification. ` +
        `Re-subscribe from each device.`,
    );
  }

  try {
    appendFileSync(
      envPath,
      `\nVAPID_PUBLIC_KEY="${generated.publicKey}"\nVAPID_PRIVATE_KEY="${generated.privateKey}"\n`,
    );
    log.warn(
      `Generated VAPID keys and saved them to ${envPath}. ` +
        `Back this file up: losing it silently breaks push for every subscribed device.`,
    );
  } catch (e) {
    log.error(
      `ERROR: generated VAPID keys but could not write ${envPath}: ${e.message}. ` +
        `Push works for this run only — new keys will be generated on next start ` +
        `and all subscriptions will break. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY manually.`,
    );
  }

  return generated;
}
```

- [ ] **Step 2: Write the tests**

Create `tests/unit/backend/vapid-warning.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockAppendFileSync = vi.fn();
vi.mock("fs", () => ({ appendFileSync: (...a) => mockAppendFileSync(...a) }));
vi.mock("../../../server/paths.js", () => ({ userDir: "/mock/home/.claudeck" }));

const mockCount = vi.fn(() => 0);
vi.mock("../../../db.js", () => ({ countPushSubscriptions: () => mockCount() }));

const { resolveVapidKeys } = await import("../../../server/vapid.js");

const webpush = {
  generateVAPIDKeys: () => ({ publicKey: "PUB", privateKey: "PRIV" }),
};

function mockLog() {
  return { warn: vi.fn(), error: vi.fn(), log: vi.fn() };
}

describe("resolveVapidKeys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    mockCount.mockReturnValue(0);
  });

  it("returns configured keys without generating or warning", () => {
    process.env.VAPID_PUBLIC_KEY = "existing-pub";
    process.env.VAPID_PRIVATE_KEY = "existing-priv";
    const log = mockLog();

    const keys = resolveVapidKeys(webpush, log);

    expect(keys.publicKey).toBe("existing-pub");
    expect(mockAppendFileSync).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("warns and names the file to back up when generating", () => {
    const log = mockLog();

    const keys = resolveVapidKeys(webpush, log);

    expect(keys.publicKey).toBe("PUB");
    expect(mockAppendFileSync).toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("/mock/home/.claudeck/.env"));
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Back this file up"));
  });

  it("warns about orphaned subscriptions", () => {
    mockCount.mockReturnValue(3);
    const log = mockLog();

    resolveVapidKeys(webpush, log);

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("3 existing push subscription"));
  });

  it("explains an append failure instead of crashing", () => {
    mockAppendFileSync.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });
    const log = mockLog();

    const keys = resolveVapidKeys(webpush, log);

    expect(keys.publicKey).toBe("PUB");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("this run only"));
  });

  it("still generates when the subscription count throws", () => {
    mockCount.mockImplementation(() => {
      throw new Error("no such table");
    });
    const log = mockLog();

    expect(() => resolveVapidKeys(webpush, log)).not.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run tests/unit/backend/vapid-warning.test.js`
Expected: FAIL — `server/vapid.js` does not exist. (Write the file from Step 1 only after seeing this.)

- [ ] **Step 4: Wire it into `server.js`**

Replace the block at `server.js:60-77` with:

```js
// ── Web Push (VAPID) setup ──────────────────────────────────
{
  const { publicKey, privateKey } = resolveVapidKeys(webpush);
  webpush.setVapidDetails("mailto:push@claudeck.local", publicKey, privateKey);
  setVapidPublicKey(publicKey);
  initPushSender(webpush);
}
```

Add the import beside the other `server/` imports:

```js
import { resolveVapidKeys } from "./server/vapid.js";
```

`appendFileSync` is now unused in `server.js` (its only other reference was the
block just deleted), so drop it from the `fs` import on line 10:

```js
import { readdirSync, existsSync, statSync } from "fs";
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run tests/unit/backend/vapid-warning.test.js`
Expected: PASS.

- [ ] **Step 6: Verify the real server still boots**

Run: `PORT=9019 node server.js` — confirm it starts and prints no VAPID warning (your keys are already in `~/.claudeck/.env`), then Ctrl-C.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`

```bash
git add server.js server/vapid.js db/sqlite.js tests/unit/backend/vapid-warning.test.js
git commit -m "feat(push): warn loudly when VAPID keys are generated or unsaved"
```

---

## Final verification

- [ ] `npm test` — all files pass, count ≥ 2720 + the new tests.
- [ ] `grep -rn "execCommand" public/ server/ --include='*.js'` — no results.
- [ ] `grep -rn "exec(" server/routes/exec.js` — exactly one call, under `shellCommand`.
- [ ] Manual: start the server, open the Git tab on a repo with a branch named `test$(echo PWNED)`, confirm the branch list renders and checkout does not execute the substitution.
- [ ] Manual: `/run echo hi | cat` in chat still returns `hi`.
