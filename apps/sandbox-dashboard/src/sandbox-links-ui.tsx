/**
 * "Links" dashboard tab. A short static, grouped list of useful local URLs:
 * the sandbox feature-selector pages (`/__sandbox`, which set the X-Feature
 * cookie) and the local admin UIs served by the shared infra.
 */

import { Css } from "werkmeister-ui/theme";

type LinkKind = "local" | "remote" | "admin";
interface SandboxLink {
  label: string;
  desc: string;
  url: string;
  kind: LinkKind;
}
interface LinkGroup {
  title: string;
  note: string;
  links: SandboxLink[];
}

// Hardcoded for this sandbox. `/__sandbox` is served by Caddy on every host
// router; admin ports come from infra/compose/shared-infra.yml. Add rows here as
// more feature hostnames or infra tools come online.
const GROUPS: LinkGroup[] = [
  {
    title: "Feature selector",
    note: "Open one to set the X-Feature cookie and route a hostname to a feature's containers.",
    links: [
      {
        label: "frontend · local",
        desc: "Routes to the local Docker feature container",
        url: "https://frontend.local.sandbox.com/__sandbox",
        kind: "local",
      },
      {
        label: "frontend · remote",
        desc: "Routes to the in-cluster deployment",
        url: "https://frontend.remote.sandbox.com/__sandbox",
        kind: "remote",
      },
    ],
  },
  {
    title: "Local admin",
    note: "Shared-infra tools published on the host (OrbStack).",
    links: [
      {
        label: "Jaeger",
        desc: "Distributed tracing UI",
        url: "https://jaeger.sandbox-infra.orb.local/jaeger/",
        kind: "admin",
      },
      {
        label: "RedisInsight",
        desc: "Redis GUI / key browser",
        url: "https://redisinsight.sandbox-infra.orb.local/redisinsight/",
        kind: "admin",
      },
      {
        label: "Sandbox dashboard",
        desc: "Workspaces dashboard",
        url: "http://localhost:3001/",
        kind: "admin",
      },
    ],
  },
];

const CSS = `
  .sbl, .sbl * { box-sizing: border-box; }
  .sbl { font-family: var(--sd-sans); color: var(--sd-ink); padding: 16px 20px 40px; }
  .sbl .group { margin-bottom: 22px; }
  .sbl .group h2 { font-size: 13px; font-weight: 700; margin: 0 0 2px; }
  .sbl .group .note { color: var(--sd-muted); font-size: 12px; margin: 0 0 10px; }
  .sbl .cards { display: flex; flex-direction: column; gap: 10px; max-width: 640px; }
  .sbl a.card {
    display: flex; align-items: center; gap: 14px; text-decoration: none;
    padding: 14px 16px; border: 1px solid var(--sd-line); border-radius: 10px;
    background: var(--sd-card); color: var(--sd-ink);
  }
  .sbl a.card:hover { background: var(--sd-hover); }
  .sbl .tag {
    flex: none; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    padding: 4px 10px; border-radius: 999px; background: var(--sd-hover); color: var(--sd-muted);
  }
  .sbl .tag.local { background: var(--sd-ok-bg); color: var(--sd-ok); }
  .sbl .tag.remote { background: var(--sd-warn-bg); color: var(--sd-warn); }
  .sbl .body { min-width: 0; }
  .sbl .label { font-weight: 600; font-size: 14px; }
  .sbl .desc { color: var(--sd-muted); font-size: 12px; margin-top: 2px; }
  .sbl .url { color: var(--sd-muted); font-family: var(--sd-mono); font-size: 11px; margin-top: 4px; word-break: break-all; }
  .sbl .go { margin-left: auto; flex: none; color: var(--sd-muted); font-size: 13px; }
`;

export function LinksTab() {
  return (
    <div className="sbl">
      <Css id="sbl" css={CSS} />
      {GROUPS.map((group) => (
        <div className="group" key={group.title}>
          <h2>{group.title}</h2>
          <p className="note">{group.note}</p>
          <div className="cards">
            {group.links.map((link) => (
              <a
                className="card"
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className={`tag ${link.kind}`}>{link.kind}</span>
                <div className="body">
                  <div className="label">{link.label}</div>
                  <div className="desc">{link.desc}</div>
                  <div className="url">{link.url}</div>
                </div>
                <span className="go">↗</span>
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
