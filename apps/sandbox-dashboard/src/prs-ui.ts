/**
 * "Open Pull Requests" dashboard tab. Dependency-free vanilla DOM (same `el()` +
 * CSS-injection approach as workspace-ui.ts). Two sections — my open PRs and the
 * ready-for-approval queue — each an expandable card. Expanding renders the PR
 * body via markdown-it (html:false) and shows an Approve button plus, when the PR
 * carries the approval label, a Reconcile-with-issue flow: the server hands the
 * issue + PR + diff to a background headless `claude -p` session, which is
 * then embedded and watched inline via the shared chat panel (src/chat-panel.ts).
 *
 * Browser surface only (needs the same-origin Express server for its reconcile +
 * live session-stream routes); not mounted by mcp-list.ts or artifact-main.ts.
 */

import { type ChatPanelHandle, initChatPanel } from "werkmeister-ui/chat-panel";
import { renderMarkdown } from "werkmeister-ui/lib/markdown";
import { el, injectCss } from "werkmeister-ui/theme";
import type { HostBridge } from "werkmeister-ui/workspace-ui";

interface OpenPr {
  url: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  body: string;
  labels: string[];
  reviewStatus: "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED" | "PENDING";
  failingChecks: number;
  outOfDate: boolean;
  hasApprovalLabel: boolean;
  issueId: string | null;
  issueUrl: string | null;
  isDraft: boolean;
}
interface OpenPrsResult {
  me: string;
  mine: OpenPr[];
  others: OpenPr[];
}
/** An `Issue` (werkmeister-core/issue_tracker), as the `pr-reconcile` tool returns it. */
interface IssueCard {
  ref: string;
  title?: string;
  status?: string;
  type?: string;
  assignee?: string;
  description?: string;
  url?: string;
}

const CSS = `
  .prs, .prs * { box-sizing: border-box; }
  .prs {
    font-family: var(--sd-sans);
    color: var(--sd-ink); padding: 16px 20px 40px;
  }
  .prs .controls { display: flex; align-items: center; gap: 10px; margin: 4px 0 16px; }
  .prs .controls input[type=search] {
    flex: 1; font: inherit; font-size: 13px; padding: 7px 10px;
    border: 1px solid var(--sd-ctl); border-radius: 8px; background: var(--sd-card);
  }
  .prs .refresh {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    padding: 7px 12px; border: 1px solid var(--sd-ctl); border-radius: 8px; background: var(--sd-card); color: var(--sd-ink);
  }
  .prs .refresh:hover { background: var(--sd-hover); }
  .prs .load-status { color: var(--sd-muted); font-size: 13px; padding: 8px 0; }
  .prs .load-status.err { color: var(--sd-err); }
  .prs .sec-h { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    color: var(--sd-muted); margin: 20px 0 8px; }
  .prs .sec-h .count { color: var(--sd-faint); font-weight: 600; margin-left: 6px; }
  .prs .sec-empty { color: var(--sd-faint); font-size: 13px; padding: 4px 0 8px; }
  /* Card + expandable head follow the Workspaces-tab list-item pattern
     (workspace-ui.ts .ws / .ws-head): left status rail, caret, right-aligned
     pill meta. Rail color = review status (draft overrides to neutral). */
  .prs .card { border: 1px solid var(--sd-line); border-left: 3px solid var(--sd-line); border-radius: 10px; background: var(--sd-card); margin-bottom: 10px; box-shadow: 0 1px 2px rgba(0,0,0,0.04); overflow: hidden; }
  .prs .card.rail-approved { border-left-color: var(--sd-ok); }
  .prs .card.rail-changes, .prs .card.rail-failing { border-left-color: var(--sd-err); }
  .prs .card.rail-pending { border-left-color: var(--sd-warn); }
  .prs .card.rail-dismissed, .prs .card.rail-draft { border-left-color: var(--sd-faint); }
  .prs .head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer; user-select: none; }
  .prs .head:hover { background: var(--sd-hover); }
  .prs .caret { color: var(--sd-faint); font-size: 12px; transition: transform 0.15s; width: 10px; flex: none; }
  .prs .card.open .caret { transform: rotate(90deg); }
  .prs .repo { font-weight: 600; font-size: 14px; white-space: nowrap; }
  .prs .num { color: var(--sd-muted); font-size: 13px; }
  .prs .ttl { font-size: 13px; flex: 1; min-width: 160px; }
  .prs .head-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .prs .author { color: var(--sd-muted); font-size: 12px; }
  .prs .draft-badge, .prs .issue-link, .prs .issue-key, .prs .gh-link, .prs .lbl, .prs .pr-flag {
    display: inline-block; font-size: 11px; font-weight: 600; padding: 2px 8px;
    border-radius: 999px; text-decoration: none; white-space: nowrap;
  }
  .prs .draft-badge { background: var(--sd-line-soft); color: var(--sd-muted); }
  /* .issue-key: the same badge with no tracker URL, so no hover underline. */
  .prs .issue-link, .prs .issue-key { background: var(--sd-hover); color: var(--sd-info); }
  .prs .issue-link:hover { text-decoration: underline; }
  .prs .gh-link { background: var(--sd-line-soft); color: var(--sd-muted); }
  .prs .gh-link:hover { text-decoration: underline; }
  .prs .lbl { background: var(--sd-warn-bg); color: var(--sd-warn); }
  .prs .pr-flag.review-approved { background: var(--sd-ok-bg); color: var(--sd-ok); }
  .prs .pr-flag.review-changes { background: var(--sd-err-bg); color: var(--sd-err); }
  .prs .pr-flag.review-dismissed { background: var(--sd-line-soft); color: var(--sd-muted); }
  .prs .pr-flag.review-pending { background: var(--sd-warn-bg); color: var(--sd-warn); }
  .prs .pr-flag.failing { background: var(--sd-err-bg); color: var(--sd-err); }
  .prs .pr-flag.stale { background: var(--sd-warn-bg); color: var(--sd-warn); }
  .prs .panel { border-top: 1px solid var(--sd-line-soft); padding: 12px 14px; }
  .prs .panel[hidden] { display: none; }
  .prs .body { font-size: 13px; line-height: 1.5; overflow-x: auto; }
  .prs .body pre { background: var(--sd-line-soft); padding: 10px; border-radius: 6px; overflow-x: auto; }
  .prs .body code { font-family: var(--sd-mono); font-size: 12px; }
  .prs .body table { border-collapse: collapse; }
  .prs .body td, .prs .body th { border: 1px solid var(--sd-line); padding: 4px 8px; }
  .prs .actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
  .prs .btn {
    font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    padding: 6px 12px; border-radius: 7px; border: 1px solid var(--sd-ctl); background: var(--sd-card); color: var(--sd-ink);
  }
  .prs .btn:hover { background: var(--sd-hover); }
  .prs .btn.primary { background: var(--sd-accent); border-color: var(--sd-accent); color: #fff; }
  .prs .btn.primary:hover { background: var(--sd-accent-hover); }
  .prs .btn[disabled] { opacity: .55; cursor: default; }
  .prs .act-msg { font-size: 12px; color: var(--sd-muted); margin-left: auto; }
  .prs .act-msg.err { color: var(--sd-err); }
  .prs .act-msg.ok { color: var(--sd-ok); }
  .prs .issue-card { margin-top: 12px; border: 1px solid #dbe4f0; border-radius: 8px;
    background: #f4f8fd; padding: 10px 12px; font-size: 12px; }
  .prs .issue-card .k { font-weight: 700; }
  .prs .issue-card .st { font-size: 10px; background: var(--sd-hover); color: var(--sd-info);
    padding: 1px 6px; border-radius: 4px; margin-left: 6px; }
  .prs .issue-card .meta { color: var(--sd-muted); margin-top: 4px; }
  .prs .issue-card .desc { margin-top: 6px; color: var(--sd-ink); max-height: 260px; overflow-y: auto; line-height: 1.45; }
  .prs .issue-card .desc > :first-child { margin-top: 0; }
  .prs .issue-card .desc > :last-child { margin-bottom: 0; }
  .prs .issue-card .desc h1, .prs .issue-card .desc h2, .prs .issue-card .desc h3, .prs .issue-card .desc h4 {
    font-size: 12px; font-weight: 700; color: var(--sd-ink); margin: 10px 0 4px; }
  .prs .issue-card .desc p { margin: 5px 0; }
  .prs .issue-card .desc ul, .prs .issue-card .desc ol { margin: 5px 0; padding-left: 20px; }
  .prs .issue-card .desc li { margin: 2px 0; }
  .prs .issue-card .desc code { background: #e6edf6; padding: 1px 4px; border-radius: 4px;
    font-family: var(--sd-mono); font-size: 11px; }
  .prs .issue-card .desc pre { background: #e6edf6; padding: 8px 10px; border-radius: 6px; overflow-x: auto; margin: 5px 0; }
  .prs .issue-card .desc pre code { background: none; padding: 0; }
  .prs .issue-card .desc a { color: var(--sd-info); }
  /* The embedded reconcile chat styles itself (src/chat-panel.ts). Give it a
     little breathing room from the actions row above. */
  .prs .claude-chat { margin-top: 12px; border-radius: 8px; overflow: hidden; }
`;

export function initPrsUI(bridge: HostBridge, root: HTMLElement): { reload: () => void } {
  injectCss("prs", CSS);

  root.classList.add("prs");
  root.innerHTML = `
    <div class="controls">
      <input type="search" data-id="filter" placeholder="Filter by title, repo, author, or label…">
      <button class="refresh" data-id="refresh">↻ Refresh</button>
    </div>
    <div class="load-status" data-id="status">Loading pull requests…</div>
    <div data-id="mine"></div>
    <div data-id="others"></div>`;

  const $ = (id: string) => root.querySelector(`[data-id="${id}"]`) as HTMLElement;
  const call = (tool: string, args?: Record<string, unknown>) => bridge.callTool(tool, args);

  let data: OpenPrsResult | null = null;
  let filter = "";

  // Live embedded reconcile chats. A re-render (filter/reload) throws away the
  // card DOM, so tear their SSE sockets + server tailers down first — otherwise
  // each orphaned EventSource leaks until GC. (No panel cache here as on the
  // Workspaces tab; reconcile is an on-demand action, so a reload resetting it
  // is fine.)
  const liveChats = new Set<ChatPanelHandle>();
  function teardownChats(): void {
    for (const c of liveChats) c.onVisibility?.(false);
    liveChats.clear();
  }

  function matches(pr: OpenPr): boolean {
    if (!filter) return true;
    const hay =
      `${pr.repo} ${pr.number} ${pr.title} ${pr.author} ${pr.labels.join(" ")}`.toLowerCase();
    return hay.includes(filter);
  }

  // GitHub review-status label shown on every PR. Keyed classes drive the color
  // (see .review-* CSS); the map is the single source for label text + tone.
  const REVIEW_STATUS: Record<OpenPr["reviewStatus"], { text: string; cls: string }> = {
    APPROVED: { text: "Approved", cls: "review-approved" },
    CHANGES_REQUESTED: { text: "Changes Requested", cls: "review-changes" },
    DISMISSED: { text: "Dismissed", cls: "review-dismissed" },
    PENDING: { text: "Pending", cls: "review-pending" },
  };

  function chips(pr: OpenPr): HTMLElement[] {
    const out: HTMLElement[] = [];
    const rs = REVIEW_STATUS[pr.reviewStatus];
    out.push(el("span", `pr-flag ${rs.cls}`, rs.text));
    if (pr.failingChecks > 0)
      out.push(el("span", "pr-flag failing", `${pr.failingChecks} failing`));
    if (pr.outOfDate) out.push(el("span", "pr-flag stale", "out of date"));
    for (const l of pr.labels) out.push(el("span", "lbl", l));
    return out;
  }

  // Some trackers return descriptions as wiki markup (h2. / * bullets / {{mono}} /
  // {code}), not markdown — so translate the common constructs to markdown, then
  // reuse the same (html:false → XSS-safe) renderer as PR bodies. Bold/italic are
  // left as-is; the goal is styled headings, lists, and code, not full fidelity.
  // ponytail: sniffs for wiki-only markers so markdown (`# heading`) passes through
  // untouched; a tracker strategy returning markdown would retire this.
  function descriptionToMarkdown(src: string): string {
    if (!/^h[1-6]\.\s|\{code|\{noformat\}|\{\{/m.test(src)) return src;
    const s = src
      .replace(/\{code(?::[^}]*)?\}|\{noformat\}/g, "\n```\n")
      .replace(/\{\{([^}]+)\}\}/g, "`$1`");
    return s
      .split(/\r?\n/)
      .map((line) => {
        const h = /^h([1-6])\.\s*(.*)$/.exec(line);
        if (h) return "#".repeat(Number(h[1])) + " " + h[2];
        const bullet = /^(\*+)\s+(.*)$/.exec(line);
        if (bullet) return "  ".repeat(bullet[1].length - 1) + "* " + bullet[2];
        const num = /^(#+)\s+(.*)$/.exec(line);
        if (num) return "  ".repeat(num[1].length - 1) + "1. " + num[2];
        return line;
      })
      .join("\n");
  }

  function renderIssueCard(c: IssueCard): HTMLElement {
    const box = el("div", "issue-card");
    const line = el("div");
    line.appendChild(el("span", "k", c.ref));
    if (c.title) line.appendChild(document.createTextNode(` ${c.title}`));
    if (c.status) line.appendChild(el("span", "st", c.status));
    box.appendChild(line);
    const metaBits = [c.type, c.assignee ? `@${c.assignee}` : ""].filter(Boolean).join(" · ");
    if (metaBits) box.appendChild(el("div", "meta", metaBits));
    if (c.description) {
      const desc = el("div", "desc");
      desc.innerHTML = renderMarkdown(descriptionToMarkdown(c.description));
      box.appendChild(desc);
    }
    return box;
  }

  // A clickable header link. It opens via the host bridge (raw target=_blank
  // doesn't work in the Desktop webview — same reason reconcile's "Request
  // changes" uses openLink) and stops propagation so the row still toggles its
  // panel when clicked anywhere else.
  function headLink(cls: string, label: string, href: string, title: string): HTMLElement {
    const a = el("a", cls, label) as HTMLAnchorElement;
    a.href = href;
    a.title = title;
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      bridge.openLink(href);
    });
    return a;
  }

  // Left status rail, same idea as the Workspaces tab's container-state rail:
  // the list reads as a review board at a glance. Draft/failing trump status.
  function railClass(pr: OpenPr): string {
    if (pr.isDraft) return "rail-draft";
    if (pr.failingChecks > 0) return "rail-failing";
    const rails: Record<OpenPr["reviewStatus"], string> = {
      APPROVED: "rail-approved",
      CHANGES_REQUESTED: "rail-changes",
      DISMISSED: "rail-dismissed",
      PENDING: "rail-pending",
    };
    return rails[pr.reviewStatus];
  }

  function buildCard(pr: OpenPr, isMine: boolean): HTMLElement {
    const card = el("div", `card ${railClass(pr)}`);
    const head = el("div", "head");
    head.appendChild(el("span", "caret", "▶"));
    head.appendChild(el("span", "repo", pr.repo));
    head.appendChild(el("span", "num", `#${pr.number}`));
    head.appendChild(el("span", "ttl", pr.title));
    const meta = el("div", "head-meta");
    if (!isMine && pr.author) meta.appendChild(el("span", "author", pr.author));
    if (pr.isDraft) meta.appendChild(el("span", "draft-badge", "draft"));
    if (pr.issueId) {
      meta.appendChild(
        pr.issueUrl
          ? headLink("issue-link", pr.issueId, pr.issueUrl, `Open issue ${pr.issueId}`)
          : el("span", "issue-key", pr.issueId),
      );
    }
    meta.appendChild(headLink("gh-link", "GitHub", pr.url, "Open this PR on GitHub"));
    meta.append(...chips(pr));
    head.appendChild(meta);

    const panel = el("div", "panel");
    panel.hidden = true;
    const body = el("div", "body");
    body.innerHTML = renderMarkdown(pr.body || "_No description._");
    panel.appendChild(body);

    const actions = el("div", "actions");
    const msg = el("span", "act-msg");

    // The embedded reconcile chat (created on first Reconcile click, "Ready for
    // review" section only). Its SSE socket is gated on the card being expanded.
    let chat: ChatPanelHandle | null = null;

    if (isMine) {
      const askReviewBtn = el("button", "btn", "Ask for review") as HTMLButtonElement;
      actions.appendChild(askReviewBtn);

      askReviewBtn.addEventListener("click", async () => {
        askReviewBtn.disabled = true;
        msg.className = "act-msg";
        msg.textContent = "Requesting review…";
        try {
          await call("ask-pr-review", { url: pr.url, title: pr.title, author: pr.author });
          msg.className = "act-msg ok";
          msg.textContent = "review requested ✓";
        } catch (e) {
          msg.className = "act-msg err";
          msg.textContent = (e as Error).message || "request failed";
          askReviewBtn.disabled = false;
        }
      });
    } else {
      const approveBtn = el("button", "btn primary", "Approve") as HTMLButtonElement;
      actions.appendChild(approveBtn);

      let reconcileBtn: HTMLButtonElement | null = null;
      if (pr.hasApprovalLabel) {
        reconcileBtn = el("button", "btn", "Reconcile with issue") as HTMLButtonElement;
        actions.appendChild(reconcileBtn);
      }

      approveBtn.addEventListener("click", async () => {
        approveBtn.disabled = true;
        msg.className = "act-msg";
        msg.textContent = "Approving…";
        try {
          await call("pr-approve", { url: pr.url });
          msg.className = "act-msg ok";
          msg.textContent = "approved ✓";
        } catch (e) {
          msg.className = "act-msg err";
          msg.textContent = (e as Error).message || "approve failed";
          approveBtn.disabled = false;
        }
      });

      let issueEl: HTMLElement | null = null;
      reconcileBtn?.addEventListener("click", async () => {
        if (reconcileBtn) reconcileBtn.disabled = true;
        msg.className = "act-msg";
        msg.textContent = "Gathering issue + PR context…";
        try {
          const res = (await call("pr-reconcile", {
            url: pr.url,
            issueRef: pr.issueId ?? undefined,
          })) as { sessionKey: string; issue?: IssueCard };
          if (res.issue?.ref && !issueEl) {
            issueEl = renderIssueCard(res.issue);
            panel.insertBefore(issueEl, actions.nextSibling);
          }
          if (!chat) {
            chat = initChatPanel(res.sessionKey, {
              bridge,
              placeholder: "Message the reconcile session…",
              renderMarkdown,
              decisionOptions: {
                title: "Your call:",
                options: [
                  { label: "Approve", description: "Approve this PR on GitHub" },
                  {
                    label: "Request changes",
                    description: "Open the PR on GitHub to leave your review",
                  },
                ],
                onSelect: async (i) => {
                  if (i === 0) {
                    await call("pr-approve", { url: pr.url });
                  } else {
                    bridge.openLink(pr.url);
                  }
                },
              },
            });
            liveChats.add(chat);
            panel.appendChild(chat.el);
          }
          msg.className = "act-msg ok";
          msg.textContent = "Reconcile session started — shown below.";
        } catch (e) {
          msg.className = "act-msg err";
          msg.textContent = (e as Error).message || "couldn't start reconcile";
          if (reconcileBtn) reconcileBtn.disabled = false;
        }
      });
    }

    actions.appendChild(msg);
    panel.appendChild(actions);
    card.appendChild(head);
    card.appendChild(panel);

    head.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      card.classList.toggle("open", !panel.hidden);
      chat?.onVisibility?.(!panel.hidden);
    });

    return card;
  }

  function renderSection(host: HTMLElement, label: string, prs: OpenPr[], isMine: boolean): void {
    host.innerHTML = "";
    const shown = prs.filter(matches);
    const h = el("div", "sec-h", label);
    h.appendChild(el("span", "count", String(shown.length)));
    host.appendChild(h);
    if (!shown.length) {
      host.appendChild(el("div", "sec-empty", "Nothing here."));
      return;
    }
    for (const pr of shown) host.appendChild(buildCard(pr, isMine));
  }

  function render(): void {
    if (!data) return;
    teardownChats(); // the cards below are about to be rebuilt
    $("status").style.display = "none";
    renderSection($("mine"), "My open PRs", data.mine, true);
    renderSection($("others"), "Ready for review", data.others, false);
  }

  async function load(): Promise<void> {
    teardownChats(); // covers the error path (render() covers the success path)
    const status = $("status");
    status.style.display = "";
    status.className = "load-status";
    status.textContent = "Loading pull requests…";
    $("mine").innerHTML = "";
    $("others").innerHTML = "";
    try {
      data = (await call("open-prs")) as OpenPrsResult;
      render();
    } catch (e) {
      status.className = "load-status err";
      status.textContent = `Couldn't load pull requests: ${(e as Error).message}. `;
      const retry = el("button", "refresh", "Retry");
      retry.addEventListener("click", () => void load());
      status.appendChild(retry);
    }
  }

  ($("filter") as HTMLInputElement).addEventListener("input", (ev) => {
    filter = (ev.target as HTMLInputElement).value.trim().toLowerCase();
    if (data) render();
  });
  $("refresh").addEventListener("click", () => void load());

  void load();
  return { reload: () => void load() };
}
