/**
 * "Health" dashboard tab. Dependency-free vanilla DOM (same `el()` +
 * CSS-injection approach as prs-ui.ts / workspace-ui.ts). Three sections —
 * shared infra containers, k8s port-forwards, and kube context — each a
 * simple row list. This is the itemized detail view behind the top bar's
 * aggregate infra/k8s/kube chips in workspace-ui.ts; it doesn't replace them.
 */

import { el, injectCss } from "./theme.js";
import { renderUsage, type WorkspaceUsage } from "./usage-widget.js";
import type { HostBridge } from "./workspace-ui.js";

interface InfraService {
  name: string;
  state: "healthy" | "starting" | "unhealthy" | "running" | "down";
}
interface FeatureStatus {
  name: string;
  state: "up" | "partial" | "stopped" | "down" | "unknown";
  running: number;
  total: number;
  slot: number | null;
  ports: string | null;
  services: InfraService[];
  claude: { state: "running" | "done" | "failed" | "idle"; waiting: boolean };
}
interface WorkspaceStatusResult {
  infra: {
    state: "up" | "partial" | "down" | "unknown";
    running: number;
    total: number;
    services: InfraService[];
  };
  statuses: FeatureStatus[];
}
interface K8sForward {
  name: string;
  port: number;
  healthy: boolean;
  detail: string | null;
}
interface K8sForwardsResult {
  forwards: K8sForward[];
  healthy: number;
  total: number;
}
interface KubeContextResult {
  context: string | null;
  env: "dev" | "stage" | "prod" | "other";
}

const CSS = `
  .health, .health * { box-sizing: border-box; }
  .health {
    font-family: var(--sd-sans);
    color: var(--sd-ink); padding: 16px 20px 40px;
  }
  .health .controls { display: flex; align-items: center; gap: 10px; margin: 4px 0 4px; }
  .health .refresh {
    font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    padding: 7px 12px; border: 1px solid var(--sd-ctl-border); border-radius: 8px; background: var(--sd-card); color: var(--sd-ink);
  }
  .health .refresh:hover { background: var(--sd-hover); }
  .health .refresh[disabled] { opacity: .55; cursor: default; }
  .health .load-status { color: var(--sd-muted); font-size: 13px; padding: 8px 0; min-height: 1em; }
  .health .load-status.err { color: var(--sd-err); }
  .health .sec-h {
    font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
    color: var(--sd-muted); margin: 20px 0 8px;
  }
  .health .row {
    display: flex; align-items: center; gap: 8px; padding: 7px 12px;
    border: 1px solid var(--sd-line); border-radius: 8px; background: var(--sd-card); margin-bottom: 6px; font-size: 13px;
  }
  .health .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sd-ghost); flex: none; }
  .health .dot.ok { background: var(--sd-ok-dot); }
  .health .dot.warn { background: var(--sd-warn-dot); }
  .health .dot.bad { background: var(--sd-err); }
  .health .row .name { font-weight: 600; }
  .health .row .state { color: var(--sd-muted); }
  .health .row .port {
    color: var(--sd-ghost); font-family: var(--sd-mono); font-size: 12px;
  }
  .health .row.sub {
    margin-left: 22px; padding: 5px 12px; font-size: 12px; border-color: var(--sd-line-soft); background: var(--sd-soft);
  }
  .health .row.sub .dot { width: 6px; height: 6px; }
  .health .row.sub .name { font-weight: 500; }
  .health .row .slot { color: var(--sd-muted); font-size: 12px; }
  .health .row .claude { margin-left: auto; font-size: 12px; color: var(--sd-muted); }
  .health .row .claude.working { color: var(--sd-ok); font-weight: 600; }
  .health .row .claude.waiting { color: var(--sd-warn); font-weight: 600; }
  .health .row .claude.failed { color: var(--sd-err); font-weight: 600; }
  .health .row .detail, .health .kube-row .detail { color: var(--sd-err); font-size: 12px; margin-left: auto; }
  .health .kube-row {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border: 1px solid var(--sd-line); border-radius: 8px; background: var(--sd-card);
  }
  .health .kube-ctx { font-family: var(--sd-mono); font-size: 12px; color: var(--sd-muted); }
  .health .btn {
    font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    padding: 6px 12px; border-radius: 7px; border: 1px solid var(--sd-ctl-border); background: var(--sd-card); color: var(--sd-ink);
    margin-left: auto;
  }
  .health .btn:hover { background: var(--sd-hover); }
  .health .btn[disabled] { opacity: .55; cursor: default; }

  .health .usage-panel { padding: 8px 12px; font-size: 12px; }
`;

export function initHealthUI(bridge: HostBridge, root: HTMLElement): { reload: () => void } {
  injectCss("health", CSS);

  root.classList.add("health");
  root.innerHTML = `
    <div class="controls">
      <button class="refresh" data-id="refresh">↻ Refresh</button>
    </div>
    <div class="load-status" data-id="status"></div>
    <div class="sec-h">Feature Sandboxes</div>
    <div data-id="features"></div>
    <div class="sec-h">Infra Services</div>
    <div data-id="infra"></div>
    <div class="sec-h">k8s Forwards</div>
    <div data-id="k8s"></div>
    <div class="sec-h">Kube Context</div>
    <div data-id="kube"></div>`;

  const $ = (id: string) => root.querySelector(`[data-id="${id}"]`) as HTMLElement;
  const call = (tool: string, args?: Record<string, unknown>) => bridge.callTool(tool, args);

  // Usage panels survive renderFeatures' innerHTML wipe (the ~5s poll rebuilds
  // every row): keyed by workspace name, at a scope that outlives one poll
  // tick, so the same node — with its open/closed state and rendered content
  // — gets re-appended each time instead of a fresh `display:none` orphan.
  const usagePanels = new Map<string, HTMLElement>();
  function getUsagePanel(name: string): HTMLElement {
    let p = usagePanels.get(name);
    if (!p) {
      p = el("div", "usage-panel");
      p.style.display = "none";
      usagePanels.set(name, p);
    }
    return p;
  }

  function claudeBadge(c: FeatureStatus["claude"]): HTMLElement | null {
    if (c.waiting) return el("span", "claude waiting", "waiting for input");
    if (c.state === "running") return el("span", "claude working", "claude: working");
    if (c.state === "failed") return el("span", "claude failed", "claude: failed");
    return null;
  }

  // Per-container health dot: green = good (healthy or running), red = unhealthy
  // (failing healthcheck), amber = warming up, gray = stopped/off.
  const SVC_DOT = { healthy: "ok", running: "ok", starting: "warn", unhealthy: "bad", down: "" };
  function serviceRow(s: InfraService, nested: boolean): HTMLElement {
    const row = el("div", nested ? "row sub" : "row");
    row.appendChild(el("span", `dot ${SVC_DOT[s.state]}`));
    row.appendChild(el("span", "name", s.name));
    row.appendChild(el("span", "state", s.state));
    return row;
  }

  function renderFeatures(features: FeatureStatus[]): void {
    const host = $("features");
    host.innerHTML = "";
    // A health view cares about live sandboxes; hide workspaces with no containers.
    const active = features
      .filter((f) => f.total > 0)
      .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
    if (!active.length) {
      host.appendChild(
        el("div", "row", "No feature sandboxes up (start one with `sandbox up <feature>`)"),
      );
      return;
    }
    // Drop cached panels for workspaces no longer active, so the cache doesn't
    // grow unbounded as features come and go.
    const activeNames = new Set(active.map((f) => f.name));
    for (const name of usagePanels.keys()) if (!activeNames.has(name)) usagePanels.delete(name);
    // up=green (good), partial=amber (degraded), stopped/down/unknown=gray (off).
    const dotClass = { up: "ok", partial: "warn", stopped: "", down: "", unknown: "" };
    for (const f of active) {
      const row = el("div", "row");
      row.appendChild(el("span", `dot ${dotClass[f.state]}`));
      row.appendChild(el("span", "name", f.name));
      if (f.slot != null) row.appendChild(el("span", "slot", `slot ${f.slot}`));
      if (f.ports) row.appendChild(el("span", "port", `:${f.ports}`));
      const counts = f.total ? ` ${f.running}/${f.total}` : "";
      row.appendChild(el("span", "state", `${f.state}${counts}`));
      const badge = claudeBadge(f.claude);
      if (badge) row.appendChild(badge);
      host.appendChild(row);
      // Per-container breakdown, indented beneath the feature.
      for (const s of f.services) host.appendChild(serviceRow(s, true));

      // Usage: on-demand token/model breakdown for this workspace. The panel
      // node is cached (getUsagePanel) so it survives this function's
      // host.innerHTML wipe on the next poll tick — same node re-appended,
      // still open/closed as the user left it, still holding its content.
      const usagePanel = getUsagePanel(f.name);
      const usageBtn = el("button", "refresh", "Usage") as HTMLButtonElement;
      usageBtn.addEventListener("click", async () => {
        if (usagePanel.style.display !== "none") {
          usagePanel.style.display = "none";
          return;
        }
        usagePanel.style.display = "";
        usagePanel.textContent = "Computing usage…";
        try {
          const u = (await call("workspace-usage", { workspace: f.name })) as WorkspaceUsage;
          renderUsage(usagePanel, u);
        } catch {
          usagePanel.textContent = "Failed to load usage.";
        }
      });
      const btnRow = el("div", "row sub");
      btnRow.appendChild(usageBtn);
      host.appendChild(btnRow);
      host.appendChild(usagePanel);
    }
  }

  function renderInfra(services: InfraService[]): void {
    const host = $("infra");
    host.innerHTML = "";
    if (!services.length) {
      host.appendChild(
        el("div", "row", "No infra containers found (is `sandbox connect` running?)"),
      );
      return;
    }
    for (const s of services) host.appendChild(serviceRow(s, false));
  }

  function renderK8s(forwards: K8sForward[]): void {
    const host = $("k8s");
    host.innerHTML = "";
    if (!forwards.length) {
      host.appendChild(el("div", "row", "No k8s forwards configured"));
      return;
    }
    for (const f of forwards) {
      const row = el("div", "row");
      row.appendChild(el("span", `dot ${f.healthy ? "ok" : "bad"}`));
      row.appendChild(el("span", "name", f.name));
      row.appendChild(el("span", "port", `:${f.port}`));
      if (!f.healthy && f.detail) row.appendChild(el("span", "detail", f.detail));
      host.appendChild(row);
    }
  }

  function renderKube(env: KubeContextResult["env"], context: string | null): void {
    const host = $("kube");
    host.innerHTML = "";
    const row = el("div", "kube-row");
    const known: "dev" | "stage" | "prod" | "other" =
      env === "dev" || env === "stage" || env === "prod" ? env : "other";
    row.appendChild(el("span", `kube-env ${known}`, known === "other" ? "unknown" : env));
    row.appendChild(el("span", "kube-ctx", context || "(no context)"));
    if (env !== "dev") {
      const btn = el("button", "btn", "Switch to dev") as HTMLButtonElement;
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Switching…";
        try {
          const k = (await call("kube-switch", { env: "dev" })) as KubeContextResult;
          renderKube(k.env ?? "dev", k.context ?? null);
        } catch {
          btn.disabled = false;
          btn.textContent = "Switch to dev";
          row.querySelector(".detail")?.remove();
          row.appendChild(el("span", "detail", "Switch failed — try again"));
        }
      });
      row.appendChild(btn);
    }
    host.appendChild(row);
  }

  let loading = false;
  async function load(): Promise<void> {
    if (loading) return; // don't stack a poll tick on an in-flight fetch
    loading = true;
    const status = $("status");
    const refresh = $("refresh") as HTMLButtonElement;
    refresh.disabled = true;
    const [ws, k8s, kube] = await Promise.allSettled([
      call("status", {}) as Promise<WorkspaceStatusResult>,
      call("k8s-forwards-status", {}) as Promise<K8sForwardsResult>,
      call("kube-context", {}) as Promise<KubeContextResult>,
    ]);
    const failed: string[] = [];
    let hadPriorData = false;
    if (ws.status === "fulfilled") {
      renderFeatures(ws.value.statuses);
      renderInfra(ws.value.infra.services);
      hadPriorData = true;
    } else failed.push("features & infra");
    if (k8s.status === "fulfilled") {
      renderK8s(k8s.value.forwards);
      hadPriorData = true;
    } else failed.push("k8s forwards");
    if (kube.status === "fulfilled") {
      renderKube(kube.value.env, kube.value.context);
      hadPriorData = true;
    } else failed.push("kube context");

    status.className = failed.length ? "load-status err" : "load-status";
    if (failed.length) {
      const suffix = hadPriorData ? " — showing last known data" : "";
      status.textContent = `Couldn't refresh ${failed.join(", ")}${suffix}. Click Refresh to retry.`;
    } else {
      status.textContent = "";
    }
    refresh.disabled = false;
    loading = false;
  }

  // Auto-refresh while the tab is actually on-screen. Skip ticks when the Health
  // pane is hidden (another dashboard tab) or the browser tab is backgrounded,
  // so we don't hammer docker/kubectl for a view nobody's looking at.
  const POLL_MS = 5000;
  const visible = () => !root.hidden && document.visibilityState === "visible";
  $("refresh").addEventListener("click", () => void load());
  setInterval(() => {
    if (visible()) void load();
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (visible()) void load();
  });
  void load();

  return { reload: () => void load() };
}
