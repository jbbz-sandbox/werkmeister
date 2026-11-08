# Known Issues

What is still open in Werkmeister, and how to work around each one.

---

## A k8s Port-Forward Hangs While It Reads Healthy

**What you see:** every frontend test hangs about 50s in `beforeEach`, with no mention of Redis or Postgres. A forward that stopped answering between health checks (about 45s apart) still accepts connections.

**What to do:** check each forward, then restart the container. It is healthy again in about 12s.

```bash
docker exec w9r-k8s-forwards /usr/local/bin/probe.sh   # per-forward verdicts
docker restart w9r-k8s-forwards
```

---

## Standalone Mode Shares Source Code Between Features

**What you see:** by design, two features in standalone mode (`~/workspace/`) see each other's uncommitted changes. Volumes such as `node_modules` stay per-feature, but the source checkout is shared.

**What to do:** use per-feature workspaces (`werkmeister workspace new`) for concurrent work. Each feature gets its own git worktree.

---

## The Proxy UI Feature Cookie Applies to Every Tab

**What you see:** by design, picking a feature in the proxy UI switches every tab in that browser, because the `X-Feature` cookie is set on `path=/`.

**What to do:** run `werkmeister feature open <feature>`. It opens an isolated Chrome window with its own profile and the cookie already set. Separate browser profiles, or sending the `X-Feature` header (e.g. with ModHeader), also work.

---

## A Hand-Edited Caddyfile Reloads Stale Under Docker Desktop

**What you see:** after you edit `~/.werkmeister/infra/proxy/Caddyfile` by hand, `caddy adapt` reports `unexpected EOF`, `wc -l` differs between host and container, or a reload succeeds and changes nothing. Docker Desktop's VirtioFS can lag behind host writes to a bind-mounted file.

**What to do:** copy the file in and reload from the copy. Werkmeister's own reload already does this.

```bash
docker cp ~/.werkmeister/infra/proxy/Caddyfile w9r-caddy:/tmp/Caddyfile
docker exec w9r-caddy caddy reload --config /tmp/Caddyfile
```

---

## A Second Checkout Runs Against the Installed One's Files

**What you see:** a `werkmeister` built in a second checkout or worktree serves `infra/` and templates from the installed checkout. `paths.werkmeister_root` in `~/.werkmeister/config.yaml` is one value per machine, and only the installed CLI moves it.

**What to do:** for a one-off run, prefix the command with `WERKMEISTER_ROOT=<checkout>/apps/cli`. To switch for good, edit `paths.werkmeister_root` in `~/.werkmeister/config.yaml` and run `werkmeister machine config --write`.

---

## The Agent Asks Which Task to Do (jit Workspaces)

**What you see:** on its first turn the agent treats CLAUDE.md's Current Task (from `--task` and `--description`) and the starting prompt as two different tasks, and stops to ask which one you mean.

**What to do:** tell it the starting prompt is the task. When you create the workspace, make `--task` a short title for the prompt and leave `--description` empty.

---

## A Later Phase Re-Asks a Question You Answered in Chat (jit Workspaces)

**What you see:** a later phase, such as the pre-PR check, asks again for something you already answered in the session, e.g. the ticket key.

**What to do:** have the agent record the answer in a `decision` note with `status: decided` under `.werkmeister/notes/`. Later phases read notes, not chat.

---

## Feature Browser Profiles Are Left in `$TMPDIR`

**What you see:** `chrome-<feature>-*` directories stay in `$TMPDIR` when the process that opened the window (the MCP server, for example) exits before the window closes. They are throwaway profiles with nothing sensitive in them.

**What to do:** delete them (`rm -rf "$TMPDIR"/chrome-*`) with no feature window open, or let the OS clear `$TMPDIR`.
