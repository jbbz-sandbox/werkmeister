// Workspace — Tab SDK plugin.
// Project-scoped view of the selected sandbox feature workspace. Lists the
// workspace's inner repo worktrees (which the core Git tab ignores) and gives
// each one a full git panel — branch switch, status/stage/unstage/discard,
// file diff, commit, and log — scoped to that worktree's dir via execArgv.
// All server/git output is untrusted → DOM built with textContent, never
// innerHTML interpolation.
import { registerTab } from "/js/ui/tab-sdk.js";
import { execShell, execArgv } from "/js/core/api.js";
import { parsePorcelain } from "./parse-status.mjs";

const ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = String(text);
  return n;
}

// Strip ANSI SGR color codes so streamed CLI output renders cleanly as text.
// ponytail: only SGR (\x1b[…m) — the sandbox CLI emits nothing else; widen if it does.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

registerTab({
  id: "sandbox-workspace",
  title: "Workspace",
  icon: ICON,
  lazy: true,

  init(ctx) {
    const root = el("div", "sandbox-workspace-tab");
    const header = el("div", "sw-header");
    const controls = el("div", "sw-controls");
    const list = el("div", "sw-list");
    root.append(header, controls, list);

    // Every "nothing to show" path routes through here, so it's also where the
    // service poll gets torn down — the controls it paints into are gone.
    const message = (text) => {
      stopPolling();
      header.textContent = "";
      controls.replaceChildren();
      list.replaceChildren(el("div", "sw-empty", text));
    };

    // ── PR pill for a worktree's current-branch PR ───────────────────────────
    // state (OPEN/MERGED/CLOSED) colored; links to pr.url (scheme-checked, new
    // tab). Click doesn't toggle the card. Untrusted title → textContent/title.
    function prPill(pr) {
      const label = pr.state || "PR";
      const cls = "sw-pr " + (pr.state ? pr.state.toLowerCase() : "unknown");
      const href = /^https?:\/\//.test(pr.url || "") ? pr.url : null;
      const node = href ? el("a", cls, label) : el("span", cls, label);
      node.title = (pr.number ? `#${pr.number} ` : "") + (pr.title || "");
      if (href) {
        node.href = href;
        node.target = "_blank";
        node.rel = "noopener noreferrer";
        node.addEventListener("click", (e) => e.stopPropagation());
      }
      return node;
    }

    // ── Workspace-level controls: lifecycle actions + docker services ────────
    // Every button is built once; which ones are visible follows the running
    // state that each service poll reports (see setRunning).
    function buildControls(project) {
      controls.replaceChildren();

      const actions = el("div", "sw-actions");
      const output = el("pre", "sw-action-output hidden");

      const services = el("div", "sw-services");
      services.appendChild(el("div", "sw-services-title", "Services"));
      const svcList = el("div", "sw-svc-list");
      services.appendChild(svcList);

      // Always available — the worktrees exist whether or not containers run.
      const code = el("button", "sw-action sw-action-code", "Open in VS Code");
      code.addEventListener("click", async () => {
        const res = await execShell("code .", project);
        if (res.error || res.exitCode) ctx.toast("Could not launch VS Code", { type: "error" });
      });
      actions.appendChild(code);

      const openBtn = el("button", "sw-action sw-action-open hidden", "Open Feature");
      openBtn.addEventListener("click", () => openFeature(project, openBtn));
      actions.appendChild(openBtn);

      for (const action of ["up", "stop", "restart", "down"]) {
        const btn = el("button", "sw-action sw-action-" + action + " hidden", action);
        btn.addEventListener("click", () => runAction(project, action, actions, output, svcList));
        actions.appendChild(btn);
      }

      controls.append(actions, output, services);
      svcList.replaceChildren(el("div", "sw-svc-empty", "Loading…"));
      startPolling(project, actions, svcList);
    }

    // `sandbox open` blocks for the lifetime of its Chrome window, so the server
    // spawns it detached and answers straight away — nothing to stream here.
    async function openFeature(project, btn) {
      btn.disabled = true;
      try {
        const res = await fetch("/api/plugins/sandbox-workspace/open", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ project }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok) ctx.toast("Opening feature window…", { type: "success" });
        else ctx.toast(`sandbox open failed: ${data.error || res.status}`, { type: "error" });
      } catch {
        ctx.toast("sandbox open failed", { type: "error" });
      } finally {
        btn.disabled = false;
      }
    }

    // `up` when stopped; `open`/`stop`/`restart`/`down` when running.
    function setRunning(actions, running) {
      const show = (cls, on) => actions.querySelector(cls)?.classList.toggle("hidden", !on);
      show(".sw-action-up", !running);
      for (const cls of [".sw-action-open", ".sw-action-stop", ".sw-action-restart", ".sw-action-down"]) {
        show(cls, running);
      }
    }

    // ── Service polling ──────────────────────────────────────────────────────
    // Docker flips a container from `starting` to `healthy` seconds *after*
    // `sandbox up` returns, so the one read at the end of an action always
    // caught the transient colour and never corrected it. Polling is what keeps
    // the dots (and the button set) honest.
    const SERVICE_POLL_MS = 5000;
    let pollTimer = null;
    let pollSeq = 0;

    function stopPolling() {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    function startPolling(project, actions, svcList) {
      stopPolling();
      const tick = () => {
        if (!root.isConnected) return stopPolling(); // tab was unregistered
        // Skip while nobody can see it: another right-panel tab, closed panel,
        // or a backgrounded browser tab. Cheap, and no lifecycle wiring needed.
        if (document.visibilityState !== "visible" || root.offsetParent === null) return;
        refreshServices(project, actions, svcList);
      };
      refreshServices(project, actions, svcList);
      pollTimer = setInterval(tick, SERVICE_POLL_MS);
    }

    async function refreshServices(project, actions, svcList) {
      const seq = ++pollSeq;
      let data = null;
      try {
        const res = await fetch(
          `/api/plugins/sandbox-workspace/docker?project=${encodeURIComponent(project)}`,
        );
        data = await res.json();
      } catch {
        /* handled below */
      }
      if (seq !== pollSeq) return; // a newer poll is in flight — don't paint stale state
      if (!data) {
        // Transient blip: say so, but leave the buttons alone rather than
        // reshuffling them on one failed fetch.
        svcList.replaceChildren(el("div", "sw-svc-empty", "Failed to load services"));
        return;
      }

      const list = data.services || [];
      svcList.replaceChildren();
      if (list.length === 0) {
        svcList.appendChild(
          el("div", "sw-svc-empty", data.available === false ? "Docker unavailable" : "No services"),
        );
      }
      const outEl = controls.querySelector(".sw-action-output");
      for (const s of list) {
        const row = el("div", "sw-svc-row");
        row.title = s.state;
        row.append(
          el("span", "sw-svc-dot " + s.health, "●"),
          el("span", "sw-svc-name", s.service),
          el("span", "sw-svc-ports", (s.ports || []).join(", ")),
          interceptToggle(project, s, actions, outEl, svcList),
        );
        svcList.appendChild(row);
      }
      // `docker compose ps` lists running containers only, so any row means up.
      setRunning(actions, list.length > 0);
    }

    // Streams a `sandbox` command's output live into outEl. Reads the chunked
    // text/plain response as it arrives; the terminating `[exit N]` line carries
    // the outcome. Shared by the lifecycle buttons and the intercept toggles —
    // only the route, body, and label differ.
    async function streamCommand({ url, body, label, disable, outEl }) {
      disable.forEach((b) => (b.disabled = true));
      outEl.classList.remove("hidden");
      outEl.textContent = "";
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          outEl.textContent = data.error || `HTTP ${res.status}`;
          ctx.toast(`${label} failed: ${data.error || res.status}`, { type: "error" });
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          outEl.append(document.createTextNode(stripAnsi(dec.decode(value, { stream: true }))));
          outEl.scrollTop = outEl.scrollHeight;
        }
        const code = Number(/\[exit (\d+)\]/.exec(outEl.textContent)?.[1]);
        if (code === 0) ctx.toast(`${label} done`, { type: "success" });
        else ctx.toast(`${label} exited ${Number.isNaN(code) ? "?" : code}`, { type: "error" });
      } catch {
        ctx.toast(`${label} failed`, { type: "error" });
      } finally {
        disable.forEach((b) => (b.disabled = false));
      }
    }

    // Fires a lifecycle action, then refreshes the service list without waiting
    // a full poll interval.
    async function runAction(project, action, actionsRow, outEl, svcList) {
      if ((action === "down" || action === "stop") && !confirm(`Run "sandbox ${action}" on this workspace?`)) {
        return;
      }
      const active = actionsRow.querySelector(".sw-action-" + action);
      active.textContent = action + "…";
      await streamCommand({
        url: "/api/plugins/sandbox-workspace/action",
        body: { project, action },
        label: `sandbox ${action}`,
        disable: [...actionsRow.querySelectorAll("button")],
        outEl,
      });
      active.textContent = action;
      refreshServices(project, actionsRow, svcList);
    }

    // One service row's intercept control. Four states, and only two of them are
    // clickable — an intercept owned by another feature (or of unknown owner) is
    // shown, explained, and left alone.
    function interceptToggle(project, svc, actions, outEl, svcList) {
      const btn = el("button", "sw-intercept", "intercept");
      if (svc.mine) {
        btn.classList.add("on");
        btn.textContent = "intercepted";
        btn.title = "Click to end this intercept";
      } else if (svc.intercepted) {
        btn.disabled = true;
        btn.title = svc.interceptedBy
          ? `Intercepted by feature '${svc.interceptedBy}' — one intercept per deployment`
          : "Intercepted by another session — owner unknown";
      } else if (!svc.interceptable) {
        btn.disabled = true;
        btn.classList.add("na");
        btn.title = svc.blocker || "Not interceptable";
      } else {
        btn.title = "Route header-scoped cluster traffic to this local container";
      }
      if (!btn.disabled) {
        btn.addEventListener("click", () =>
          toggleIntercept(project, svc, btn, actions, outEl, svcList),
        );
      }
      return btn;
    }

    // Runs the intercept on/off command. `sandbox down` also leaves intercepts,
    // and a terminal-side `--leave` is invisible here, so the poll — not this
    // handler — is what ultimately owns the toggle's state.
    async function toggleIntercept(project, svc, btn, actions, outEl, svcList) {
      const leave = svc.mine;
      if (
        !leave &&
        !confirm(
          `Intercept ${svc.service}?\n\nInstalls a Telepresence traffic-agent on the ` +
            `cluster Deployment and reroutes only requests carrying your feature's ` +
            `x-feature header to this workspace's local container.`,
        )
      ) {
        return;
      }
      const restore = btn.textContent;
      btn.textContent = leave ? "leaving…" : "intercepting…";
      await streamCommand({
        url: "/api/plugins/sandbox-workspace/intercept",
        body: { project, service: svc.service, leave },
        label: `sandbox intercept ${leave ? "--leave " : ""}${svc.service}`,
        disable: [btn],
        outEl,
      });
      btn.textContent = restore;
      refreshServices(project, actions, svcList);
    }

    // ── One worktree card: collapsed summary + expandable git panel ──────────
    function buildCard(wt) {
      const card = el("div", "sw-card");

      const head = el("div", "sw-card-head");
      const caret = el("span", "sw-caret", "▸");
      const name = el("span", "sw-repo-name", wt.repo);
      const branch = el("span", "sw-branch", wt.branch || "detached");
      const status = el("span", "sw-status " + (wt.dirty > 0 ? "dirty" : "clean"), wt.dirty > 0 ? `● ${wt.dirty}` : "✓");
      const track = el("span", "sw-track");
      const tbits = [];
      if (wt.ahead) tbits.push(`↑${wt.ahead}`);
      if (wt.behind) tbits.push(`↓${wt.behind}`);
      track.textContent = tbits.join(" ");
      head.append(caret, name, branch, status, track);
      if (wt.pr) head.append(prPill(wt.pr));

      const body = el("div", "sw-panel hidden");
      let loaded = false;
      head.addEventListener("click", () => {
        const open = body.classList.toggle("hidden");
        caret.textContent = open ? "▸" : "▾";
        if (!open && !loaded) {
          loaded = true;
          loadPanel(wt, body, { setDirty: (n) => {
            status.className = "sw-status " + (n > 0 ? "dirty" : "clean");
            status.textContent = n > 0 ? `● ${n}` : "✓";
          } });
        }
      });

      card.append(head, body);
      return card;
    }

    // ── Full git panel for one worktree dir ──────────────────────────────────
    async function loadPanel(wt, body, { setDirty }) {
      body.replaceChildren();
      const dir = wt.dir;

      // Branch row: <select> of branches + switch on change.
      const branchRow = el("div", "sw-branch-row");
      const select = el("select", "sw-branch-select");
      branchRow.append(el("span", "sw-label", "branch"), select);
      body.appendChild(branchRow);

      const statusEl = el("div", "sw-status-list");
      body.appendChild(statusEl);

      // Commit box.
      const commitBox = el("div", "sw-commit");
      const msg = el("textarea", "sw-commit-msg");
      msg.placeholder = "Commit message…";
      msg.rows = 2;
      const commitBtn = el("button", "sw-commit-btn", "Commit");
      commitBox.append(msg, commitBtn);
      body.appendChild(commitBox);

      const logEl = el("div", "sw-log");
      body.appendChild(logEl);

      async function refreshStatus() {
        const res = await execArgv(["git", "status", "--porcelain=v1"], dir);
        statusEl.replaceChildren();
        if (res.error) {
          statusEl.appendChild(el("div", "sw-empty", "Not a git repository"));
          return;
        }
        const groups = parsePorcelain(res.stdout);
        const dirty = groups.staged.length + groups.changes.length + groups.untracked.length;
        setDirty(groups.changes.length + groups.untracked.length);
        if (dirty === 0) {
          statusEl.appendChild(el("div", "sw-clean", "Working tree clean"));
          return;
        }
        renderGroup(statusEl, "Staged", groups.staged, "unstage", dir, refreshStatus);
        renderGroup(statusEl, "Changes", groups.changes, "stage", dir, refreshStatus);
        renderGroup(statusEl, "Untracked", groups.untracked, "stage", dir, refreshStatus);
      }

      async function refreshBranches() {
        const res = await execArgv(["git", "branch", "--no-color"], dir);
        select.replaceChildren();
        if (res.error) return;
        for (const line of res.stdout.split("\n").filter(Boolean)) {
          const isCurrent = line.startsWith("*");
          const bn = line.replace(/^\*?\s*/, "").trim();
          if (!bn) continue;
          const opt = el("option", null, bn);
          opt.value = bn;
          if (isCurrent) opt.selected = true;
          select.appendChild(opt);
        }
      }
      select.addEventListener("change", async () => {
        const res = await execArgv(["git", "checkout", select.value], dir);
        if (res.error) {
          ctx.toast(`Cannot switch branch: ${res.stderr || "uncommitted changes?"}`, { type: "error" });
          await refreshBranches();
        } else {
          await Promise.all([refreshStatus(), refreshLog()]);
        }
      });

      async function refreshLog() {
        const res = await execArgv(["git", "log", "--oneline", "--no-color", "-10", "--format=%h|%s|%ar"], dir);
        logEl.replaceChildren(el("div", "sw-log-title", "Recent commits"));
        if (res.error || !res.stdout.trim()) return;
        for (const line of res.stdout.split("\n").filter(Boolean)) {
          const [hash, subject, when] = line.split("|");
          const row = el("div", "sw-log-row");
          row.append(el("span", "sw-log-hash", hash), el("span", "sw-log-subject", subject), el("span", "sw-log-when", when));
          logEl.appendChild(row);
        }
      }

      commitBtn.addEventListener("click", async () => {
        const text = msg.value.trim();
        if (!text) {
          ctx.toast("Enter a commit message", { type: "error" });
          return;
        }
        commitBtn.disabled = true;
        const res = await execArgv(["git", "commit", "-m", text], dir);
        commitBtn.disabled = false;
        if (res.error) {
          ctx.toast(`Commit failed: ${res.stderr || "nothing staged?"}`, { type: "error" });
          return;
        }
        msg.value = "";
        ctx.toast("Committed", { type: "success" });
        await Promise.all([refreshStatus(), refreshLog()]);
      });

      await Promise.all([refreshBranches(), refreshStatus(), refreshLog()]);
    }

    // A status group (Staged / Changes / Untracked) with per-file + bulk actions.
    function renderGroup(container, title, files, action, dir, refresh) {
      if (!files.length) return;
      const group = el("div", "sw-group");

      const gh = el("div", "sw-group-head");
      gh.append(el("span", "sw-group-title", `${title} (${files.length})`));
      const bulk = el("button", "sw-bulk", action === "stage" ? "Stage all" : "Unstage all");
      bulk.addEventListener("click", async () => {
        const paths = files.map((f) => f.file);
        const argv = action === "stage"
          ? ["git", "add", "--", ...paths]
          : ["git", "reset", "HEAD", "--", ...paths];
        await execArgv(argv, dir);
        await refresh();
      });
      gh.appendChild(bulk);
      group.appendChild(gh);

      for (const f of files) {
        const row = el("div", "sw-file");
        row.append(el("span", `sw-badge ${f.cls}`, f.badge));

        const nameEl = el("span", "sw-file-name", f.file);
        nameEl.addEventListener("click", () => toggleDiff(row, dir, f, action === "unstage"));
        row.appendChild(nameEl);

        const act = el("button", "sw-file-act", action === "stage" ? "+" : "−");
        act.title = action === "stage" ? "Stage" : "Unstage";
        act.addEventListener("click", async () => {
          const argv = action === "stage"
            ? ["git", "add", "--", f.file]
            : ["git", "reset", "HEAD", "--", f.file];
          await execArgv(argv, dir);
          await refresh();
        });
        row.appendChild(act);

        // Discard: only tracked, changed (not staged, not untracked).
        if (action === "stage" && f.badge !== "?") {
          const disc = el("button", "sw-file-discard", "⨯");
          disc.title = "Discard changes";
          disc.addEventListener("click", async () => {
            if (!confirm(`Discard changes to ${f.file}?`)) return;
            await execArgv(["git", "checkout", "--", f.file], dir);
            await refresh();
          });
          row.appendChild(disc);
        }

        group.appendChild(row);
      }
      container.appendChild(group);
    }

    async function toggleDiff(row, dir, f, isStaged) {
      const existing = row.nextSibling;
      if (existing?.classList?.contains("sw-diff")) {
        existing.remove();
        return;
      }
      const pre = el("pre", "sw-diff");
      if (f.badge === "?") {
        pre.textContent = "(untracked — new file)";
      } else {
        const argv = isStaged
          ? ["git", "diff", "--cached", "--", f.file]
          : ["git", "diff", "--", f.file];
        const res = await execArgv(argv, dir);
        pre.textContent = res.error ? "(failed to load diff)" : res.stdout || "(no diff)";
      }
      row.after(pre);
    }

    async function load() {
      const project = ctx.getProjectPath();
      if (!project) {
        message("Select a project.");
        ctx.clearBadge();
        return;
      }
      message("Loading…");
      try {
        const res = await fetch(`/api/plugins/sandbox-workspace/?project=${encodeURIComponent(project)}`);
        const data = await res.json();
        if (!data.isWorkspace) {
          message("Not a sandbox feature workspace.");
          ctx.clearBadge();
          return;
        }
        buildControls(project);
        renderRepos(data);
      } catch {
        message("Failed to load workspace repos.");
        ctx.clearBadge();
      }
    }

    // Renders the worktree cards, the header summary, and the tab badge. Header
    // carries feature + dirty/PR counts; the badge shows the actionable open-PR
    // count (0 → cleared).
    function renderRepos(data) {
      list.replaceChildren();
      if (!data.repos || data.repos.length === 0) {
        header.textContent = data.feature ? `feature: ${data.feature}` : "";
        list.appendChild(el("div", "sw-empty", "No repo worktrees found in this workspace."));
        ctx.clearBadge();
        return;
      }
      let totalDirty = 0;
      let openPRs = 0;
      for (const wt of data.repos) {
        totalDirty += wt.dirty || 0;
        if (wt.pr?.state === "OPEN") openPRs += 1;
        list.appendChild(buildCard(wt));
      }
      const bits = [];
      if (data.feature) bits.push(`feature: ${data.feature}`);
      if (totalDirty > 0) bits.push(`${totalDirty} dirty`);
      if (openPRs > 0) bits.push(`${openPRs} open PR${openPRs > 1 ? "s" : ""}`);
      header.textContent = bits.join(" · ");
      if (openPRs > 0) ctx.showBadge(openPRs);
      else ctx.clearBadge();
    }

    ctx.on("projectChanged", load);
    load();

    return root;
  },
});
