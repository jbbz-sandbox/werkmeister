/**
 * "Links" dashboard tab. A short static, grouped list of useful local URLs:
 * the sandbox feature-selector pages (`/__sandbox`, which set the X-Feature
 * cookie) and the local admin UIs served by the shared infra. Dependency-free
 * vanilla DOM, same `el()` + CSS-injection approach as health-ui.ts / prs-ui.ts.
 */
import type { HostBridge } from "./workspace-ui.js";
import { el, injectCss } from "./theme.js";

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
        label: "next-hello · local",
        desc: "Routes to the local Docker feature container",
        url: "https://next-hello.local.sandbox.com/__sandbox",
        kind: "local",
      },
      {
        label: "next-hello · remote",
        desc: "Routes to the in-cluster deployment",
        url: "https://next-hello.remote.sandbox.com/__sandbox",
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
        desc: "Workspaces dashboard + MCP endpoint (/mcp)",
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

export function initSandboxLinksUI(_bridge: HostBridge, root: HTMLElement): { reload: () => void } {
  injectCss("sbl", CSS);

  function card(link: SandboxLink): HTMLAnchorElement {
    const a = el("a", "card") as HTMLAnchorElement;
    a.href = link.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.appendChild(el("span", `tag ${link.kind}`, link.kind));
    const body = el("div", "body");
    body.appendChild(el("div", "label", link.label));
    body.appendChild(el("div", "desc", link.desc));
    body.appendChild(el("div", "url", link.url));
    a.appendChild(body);
    a.appendChild(el("span", "go", "↗"));
    return a;
  }

  function render(): void {
    root.classList.add("sbl");
    root.innerHTML = "";
    for (const group of GROUPS) {
      const section = el("div", "group");
      section.appendChild(el("h2", null, group.title));
      section.appendChild(el("p", "note", group.note));
      const cards = el("div", "cards");
      for (const link of group.links) cards.appendChild(card(link));
      section.appendChild(cards);
      root.appendChild(section);
    }
  }

  render();
  // Static content — reload just re-renders (kept for a uniform tab API).
  return { reload: () => render() };
}
