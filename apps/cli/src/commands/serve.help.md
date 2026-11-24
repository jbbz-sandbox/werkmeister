## Description

Runs `python3 -I -u -m http.server 0 -b 127.0.0.1 -d <dir>` in the foreground: loopback only, a port the OS picks (the first line prints it). Refuses a `<dir>` whose real path is outside the workspace, is the workspace folder itself, or is in a dot-folder: those hold its daemon token and `.env` files. It resolves only `<dir>` itself, so a symlink inside it is still followed. The ICM stage contracts name it for a browser check of a static HTML page, since the Chrome tool refuses `file://`; each ICM run pre-approves it. Run it as a background job and stop it by its task ID.

With `--dashboard` (and no `<dir>`) it serves the workspace's werkmeister worktree's built dashboard, `apps/cli/dist/dashboard.js`, which needs no `node_modules`, for a dashboard browser check. It runs on 127.0.0.1 at a free port (the first line prints the URL) under a fresh temp HOME seeded with a workspace in each lifecycle state, two transcripts per workspace and a metrics event log; the HOME is deleted on exit. The dashboard gets no env from the caller. `docker`, `claude`, `codex`, `opencode`, `code`, `kubectl`, `gh`, `werkmeister`, `osascript`, `open` and `telepresence` are stubs that fail and log each call to `side-effects.log` in that HOME, `DOCKER_HOST` and the daemon address are dead, and `WERKMEISTER_FIXTURE=1` keeps it off Caddy, k8s forwards and the hosts file. `git` stays real, kept inside that HOME by `GIT_CEILING_DIRECTORIES`. The stubs steer honest code; they are not an isolation boundary: the served bundle is the worktree's own code, run on the host with the same trust as the pre-approved test commands. Build the worktree first (`pnpm turbo run build --filter=werkmeister` in its container).

## Examples

```bash
werkmeister workspace serve stages
werkmeister workspace serve --dashboard
```
