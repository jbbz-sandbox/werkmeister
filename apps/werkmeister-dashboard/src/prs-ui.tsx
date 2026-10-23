/**
 * "Open Pull Requests" dashboard tab. Two sections — my open PRs and the
 * ready-for-approval queue — each an expandable card. Expanding renders the PR
 * body via markdown-it (html:false) and shows an Approve button plus, when the PR
 * carries the approval label, a Reconcile-with-issue flow: the server hands the
 * issue + PR + diff to a background headless `claude -p` session, which is
 * then embedded and watched inline via the shared chat panel (werkmeister-ui/chat-panel).
 *
 * Browser surface only (needs the same-origin Express server for its reconcile +
 * live session-stream routes); not mounted by mcp-list.ts or artifact-main.ts.
 */

import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "werkmeister-ui/chat-panel";
import { renderMarkdown } from "werkmeister-ui/lib/markdown";
import { Css } from "werkmeister-ui/theme";
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

function matches(pr: OpenPr, filter: string): boolean {
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

function IssueCardView({ c }: { c: IssueCard }) {
  const meta = [c.type, c.assignee ? `@${c.assignee}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="issue-card">
      <div>
        <span className="k">{c.ref}</span>
        {c.title && ` ${c.title}`}
        {c.status && <span className="st">{c.status}</span>}
      </div>
      {meta && <div className="meta">{meta}</div>}
      {c.description && (
        <div
          className="desc"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(descriptionToMarkdown(c.description)) }}
        />
      )}
    </div>
  );
}

// A clickable header link. It opens via the host bridge (raw target=_blank
// doesn't work in the Desktop webview — same reason reconcile's "Request
// changes" uses openLink) and stops propagation so the row still toggles its
// panel when clicked anywhere else.
function HeadLink(p: {
  className: string;
  label: string;
  href: string;
  title: string;
  bridge: HostBridge;
}) {
  return (
    <a
      className={p.className}
      href={p.href}
      title={p.title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        p.bridge.openLink(p.href);
      }}
    >
      {p.label}
    </a>
  );
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

function PrCard({ pr, isMine, bridge }: { pr: OpenPr; isMine: boolean; bridge: HostBridge }) {
  const call = (tool: string, args?: Record<string, unknown>) => bridge.callTool(tool, args);
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone?: "ok" | "err" } | null>(null);
  // A button stays disabled once its action succeeds; a failure re-enables it.
  const [disabled, setDisabled] = useState<Record<string, boolean>>({});
  const [issue, setIssue] = useState<IssueCard | null>(null);
  const [reconcileKey, setReconcileKey] = useState<string | null>(null);

  const act = async (key: string, pending: string, failed: string, run: () => Promise<string>) => {
    setDisabled((d) => ({ ...d, [key]: true }));
    setMsg({ text: pending });
    try {
      setMsg({ text: await run(), tone: "ok" });
    } catch (e) {
      setMsg({ text: (e as Error).message || failed, tone: "err" });
      setDisabled((d) => ({ ...d, [key]: false }));
    }
  };
  const askReview = () =>
    act("ask", "Requesting review…", "request failed", async () => {
      await call("ask-pr-review", { url: pr.url, title: pr.title, author: pr.author });
      return "review requested ✓";
    });
  const approve = () =>
    act("approve", "Approving…", "approve failed", async () => {
      await call("pr-approve", { url: pr.url });
      return "approved ✓";
    });
  const reconcile = () =>
    act("reconcile", "Gathering issue + PR context…", "couldn't start reconcile", async () => {
      const res = (await call("pr-reconcile", {
        url: pr.url,
        issueRef: pr.issueId ?? undefined,
      })) as { sessionKey: string; issue?: IssueCard };
      if (res.issue?.ref) setIssue((i) => i ?? res.issue ?? null);
      setReconcileKey((k) => k ?? res.sessionKey);
      return "Reconcile session started — shown below.";
    });

  const rs = REVIEW_STATUS[pr.reviewStatus];
  return (
    <div className={`card ${railClass(pr)}${open ? " open" : ""}`}>
      {/* The whole row toggles and it holds links, so it can't be a <button> (as before SW-57). */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: see above */}
      <div className="head" onClick={() => setOpen((o) => !o)}>
        <span className="caret">▶</span>
        <span className="repo">{pr.repo}</span>
        <span className="num">#{pr.number}</span>
        <span className="ttl">{pr.title}</span>
        <div className="head-meta">
          {!isMine && pr.author && <span className="author">{pr.author}</span>}
          {pr.isDraft && <span className="draft-badge">draft</span>}
          {pr.issueId &&
            (pr.issueUrl ? (
              <HeadLink
                className="issue-link"
                label={pr.issueId}
                href={pr.issueUrl}
                title={`Open issue ${pr.issueId}`}
                bridge={bridge}
              />
            ) : (
              <span className="issue-key">{pr.issueId}</span>
            ))}
          <HeadLink
            className="gh-link"
            label="GitHub"
            href={pr.url}
            title="Open this PR on GitHub"
            bridge={bridge}
          />
          <span className={`pr-flag ${rs.cls}`}>{rs.text}</span>
          {pr.failingChecks > 0 && (
            <span className="pr-flag failing">{pr.failingChecks} failing</span>
          )}
          {pr.outOfDate && <span className="pr-flag stale">out of date</span>}
          {pr.labels.map((l) => (
            <span className="lbl" key={l}>
              {l}
            </span>
          ))}
        </div>
      </div>
      <div className="panel" hidden={!open}>
        <div
          className="body"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(pr.body || "_No description._") }}
        />
        <div className="actions">
          {isMine ? (
            <button type="button" className="btn" disabled={disabled.ask} onClick={askReview}>
              Ask for review
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn primary"
                disabled={disabled.approve}
                onClick={approve}
              >
                Approve
              </button>
              {pr.hasApprovalLabel && (
                <button
                  type="button"
                  className="btn"
                  disabled={disabled.reconcile}
                  onClick={reconcile}
                >
                  Reconcile with issue
                </button>
              )}
            </>
          )}
          <span className={msg?.tone ? `act-msg ${msg.tone}` : "act-msg"}>{msg?.text}</span>
        </div>
        {issue && <IssueCardView c={issue} />}
        {/* The socket stays closed while the card is collapsed. */}
        {reconcileKey && (
          <ChatPanel
            name={reconcileKey}
            bridge={bridge}
            placeholder="Message the reconcile session…"
            renderMarkdown={renderMarkdown}
            visible={open}
            decisionOptions={{
              title: "Your call:",
              options: [
                { label: "Approve", description: "Approve this PR on GitHub" },
                {
                  label: "Request changes",
                  description: "Open the PR on GitHub to leave your review",
                },
              ],
              onSelect: async (i) => {
                if (i === 0) await call("pr-approve", { url: pr.url });
                else bridge.openLink(pr.url);
              },
            }}
          />
        )}
      </div>
    </div>
  );
}

function Section(p: {
  label: string;
  prs: OpenPr[];
  isMine: boolean;
  filter: string;
  bridge: HostBridge;
}) {
  const shown = p.prs.filter((pr) => matches(pr, p.filter));
  return (
    <div>
      <div className="sec-h">
        {p.label}
        <span className="count">{shown.length}</span>
      </div>
      {shown.length ? (
        shown.map((pr) => <PrCard key={pr.url} pr={pr} isMine={p.isMine} bridge={p.bridge} />)
      ) : (
        <div className="sec-empty">Nothing here.</div>
      )}
    </div>
  );
}

export function PrsTab({ bridge }: { bridge: HostBridge }) {
  const [data, setData] = useState<OpenPrsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  // Clearing `data` unmounts every card, closing any live reconcile chat.
  const load = useCallback(async () => {
    setData(null);
    setError(null);
    try {
      setData((await bridge.callTool("open-prs")) as OpenPrsResult);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [bridge]);
  useEffect(() => {
    void load();
  }, [load]);

  const f = filter.trim().toLowerCase();
  return (
    <div className="prs">
      <Css id="prs" css={CSS} />
      <div className="controls">
        <input
          type="search"
          placeholder="Filter by title, repo, author, or label…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="refresh" onClick={() => void load()}>
          ↻ Refresh
        </button>
      </div>
      {error !== null ? (
        <div className="load-status err">
          Couldn't load pull requests: {error}.{" "}
          <button type="button" className="refresh" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : (
        !data && <div className="load-status">Loading pull requests…</div>
      )}
      {data && (
        <>
          <Section label="My open PRs" prs={data.mine} isMine filter={f} bridge={bridge} />
          <Section
            label="Ready for review"
            prs={data.others}
            isMine={false}
            filter={f}
            bridge={bridge}
          />
        </>
      )}
    </div>
  );
}
