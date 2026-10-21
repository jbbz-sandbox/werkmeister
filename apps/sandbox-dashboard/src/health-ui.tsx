/**
 * "Health" dashboard tab. Four sections — feature sandboxes, shared infra
 * containers, k8s port-forwards, and kube context — each a simple row list. This is the itemized detail view behind the top bar's
 * aggregate infra/k8s/kube chips in workspace-ui.ts; it doesn't replace them.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Css } from "werkmeister-ui/theme";
import { Usage, type WorkspaceUsage } from "werkmeister-ui/usage-widget";
import type { HostBridge } from "werkmeister-ui/workspace-ui";

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
  claude: {
    state: "running" | "done" | "failed" | "idle";
    agent: "working" | "needs-you" | "done" | "idle";
    question: string | null;
  };
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
    padding: 7px 12px; border: 1px solid var(--sd-ctl); border-radius: 8px; background: var(--sd-card); color: var(--sd-ink);
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
  .health .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--sd-faint); flex: none; }
  .health .dot.ok { background: var(--sd-ok); }
  .health .dot.warn { background: var(--sd-warn); }
  .health .dot.bad { background: var(--sd-err); }
  .health .row .name { font-weight: 600; }
  .health .row .state { color: var(--sd-muted); }
  .health .row .port {
    color: var(--sd-faint); font-family: var(--sd-mono); font-size: 12px;
  }
  .health .row.sub {
    margin-left: 22px; padding: 5px 12px; font-size: 12px; border-color: var(--sd-line-soft); background: var(--sd-hover);
  }
  .health .row.sub .dot { width: 6px; height: 6px; }
  .health .row.sub .name { font-weight: 500; }
  .health .row .slot { color: var(--sd-muted); font-size: 12px; }
  .health .row .claude { margin-left: auto; font-size: 12px; color: var(--sd-muted); }
  .health .row .claude.working { color: var(--sd-ok); font-weight: 600; }
  .health .row .claude.needs-you { color: var(--sd-warn); font-weight: 600; }
  .health .row .claude.done { color: var(--sd-ok); }
  .health .row .claude.failed { color: var(--sd-err); font-weight: 600; }
  .health .row .detail, .health .kube-row .detail { color: var(--sd-err); font-size: 12px; margin-left: auto; }
  .health .kube-row {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    border: 1px solid var(--sd-line); border-radius: 8px; background: var(--sd-card);
  }
  .health .kube-ctx { font-family: var(--sd-mono); font-size: 12px; color: var(--sd-muted); }
  .health .btn {
    font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    padding: 6px 12px; border-radius: 7px; border: 1px solid var(--sd-ctl); background: var(--sd-card); color: var(--sd-ink);
    margin-left: auto;
  }
  .health .btn:hover { background: var(--sd-hover); }
  .health .btn[disabled] { opacity: .55; cursor: default; }

  .health .usage-panel { padding: 8px 12px; font-size: 12px; }
`;

const POLL_MS = 5000;

// Per-container health dot: green = good (healthy or running), red = unhealthy
// (failing healthcheck), amber = warming up, gray = stopped/off.
const SVC_DOT = { healthy: "ok", running: "ok", starting: "warn", unhealthy: "bad", down: "" };
// up=green (good), partial=amber (degraded), stopped/down/unknown=gray (off).
const FEATURE_DOT = { up: "ok", partial: "warn", stopped: "", down: "", unknown: "" };

function ServiceRow({ s, nested }: { s: InfraService; nested: boolean }) {
  return (
    <div className={nested ? "row sub" : "row"}>
      <span className={`dot ${SVC_DOT[s.state]}`} />
      <span className="name">{s.name}</span>
      <span className="state">{s.state}</span>
    </div>
  );
}

function ClaudeBadge({ c }: { c: FeatureStatus["claude"] }) {
  if (c.agent === "needs-you")
    return (
      <span className="claude needs-you" title={c.question ?? undefined}>
        ● Needs you
      </span>
    );
  if (c.agent === "working") return <span className="claude working">◌ Working</span>;
  if (c.state === "failed") return <span className="claude failed">claude: failed</span>;
  if (c.agent === "done") return <span className="claude done">✓ Done</span>;
  return null;
}

/** On-demand token/model breakdown; its open state survives the 5s poll re-render. */
function FeatureUsage({ name, bridge }: { name: string; bridge: HostBridge }) {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<WorkspaceUsage | "loading" | "failed">("loading");
  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    setUsage("loading");
    try {
      setUsage((await bridge.callTool("workspace-usage", { workspace: name })) as WorkspaceUsage);
    } catch {
      setUsage("failed");
    }
  };
  return (
    <>
      <div className="row sub">
        <button type="button" className="refresh" onClick={() => void toggle()}>
          Usage
        </button>
      </div>
      {open && (
        <div className="usage-panel">
          {usage === "loading" ? (
            "Computing usage…"
          ) : usage === "failed" ? (
            "Failed to load usage."
          ) : (
            <Usage usage={usage} />
          )}
        </div>
      )}
    </>
  );
}

function Features({ features, bridge }: { features: FeatureStatus[]; bridge: HostBridge }) {
  // A health view cares about live sandboxes; hide workspaces with no containers.
  const active = features
    .filter((f) => f.total > 0)
    .sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  if (!active.length)
    return (
      <div className="row">{"No feature sandboxes up (start one with `sandbox up <feature>`)"}</div>
    );
  return active.map((f) => (
    <Fragment key={f.name}>
      <div className="row">
        <span className={`dot ${FEATURE_DOT[f.state]}`} />
        <span className="name">{f.name}</span>
        {f.slot != null && <span className="slot">slot {f.slot}</span>}
        {f.ports && <span className="port">:{f.ports}</span>}
        <span className="state">
          {f.state}
          {f.total ? ` ${f.running}/${f.total}` : ""}
        </span>
        <ClaudeBadge c={f.claude} />
      </div>
      {f.services.map((s) => (
        <ServiceRow key={s.name} s={s} nested />
      ))}
      <FeatureUsage name={f.name} bridge={bridge} />
    </Fragment>
  ));
}

function KubeRow({
  kube,
  bridge,
  onSwitched,
}: {
  kube: KubeContextResult;
  bridge: HostBridge;
  onSwitched(k: KubeContextResult): void;
}) {
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  const known =
    kube.env === "dev" || kube.env === "stage" || kube.env === "prod" ? kube.env : "other";
  const switchToDev = async () => {
    setSwitching(true);
    setFailed(false);
    try {
      const k = (await bridge.callTool("kube-switch", { env: "dev" })) as KubeContextResult;
      onSwitched({ env: k.env ?? "dev", context: k.context ?? null });
    } catch {
      setFailed(true);
    }
    setSwitching(false);
  };
  return (
    <div className="kube-row">
      <span className={`kube-env ${known}`}>{known === "other" ? "unknown" : kube.env}</span>
      <span className="kube-ctx">{kube.context || "(no context)"}</span>
      {kube.env !== "dev" && (
        <button
          type="button"
          className="btn"
          disabled={switching}
          onClick={() => void switchToDev()}
        >
          {switching ? "Switching…" : "Switch to dev"}
        </button>
      )}
      {failed && <span className="detail">Switch failed — try again</span>}
    </div>
  );
}

/** `active`: the Health tab is the one on screen. */
export function HealthTab({ bridge, active }: { bridge: HostBridge; active: boolean }) {
  const [ws, setWs] = useState<WorkspaceStatusResult | null>(null);
  const [k8s, setK8s] = useState<K8sForwardsResult | null>(null);
  const [kube, setKube] = useState<KubeContextResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState({ text: "", err: false });
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return; // don't stack a poll tick on an in-flight fetch
    inFlight.current = true;
    setLoading(true);
    const [w, k, c] = await Promise.allSettled([
      bridge.callTool("status", {}) as Promise<WorkspaceStatusResult>,
      bridge.callTool("k8s-forwards-status", {}) as Promise<K8sForwardsResult>,
      bridge.callTool("kube-context", {}) as Promise<KubeContextResult>,
    ]);
    const failed: string[] = [];
    let hadPriorData = false;
    if (w.status === "fulfilled") {
      setWs(w.value);
      hadPriorData = true;
    } else failed.push("features & infra");
    if (k.status === "fulfilled") {
      setK8s(k.value);
      hadPriorData = true;
    } else failed.push("k8s forwards");
    if (c.status === "fulfilled") {
      setKube(c.value);
      hadPriorData = true;
    } else failed.push("kube context");
    const suffix = hadPriorData ? " — showing last known data" : "";
    setStatus(
      failed.length
        ? {
            text: `Couldn't refresh ${failed.join(", ")}${suffix}. Click Refresh to retry.`,
            err: true,
          }
        : { text: "", err: false },
    );
    setLoading(false);
    inFlight.current = false;
  }, [bridge]);

  // Load each time the tab is shown (including the first time).
  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  // Auto-refresh only while the tab is on screen and the browser tab is in front,
  // so we don't hammer docker/kubectl for a view nobody's looking at.
  const shown = useRef(active);
  shown.current = active;
  useEffect(() => {
    const visible = () => shown.current && document.visibilityState === "visible";
    const timer = setInterval(() => {
      if (visible()) void load();
    }, POLL_MS);
    const onVisibility = () => {
      if (visible()) void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  return (
    <div className="health">
      <Css id="health" css={CSS} />
      <div className="controls">
        <button type="button" className="refresh" disabled={loading} onClick={() => void load()}>
          ↻ Refresh
        </button>
      </div>
      <div className={status.err ? "load-status err" : "load-status"}>{status.text}</div>
      <div className="sec-h">Feature Sandboxes</div>
      <div>{ws && <Features features={ws.statuses} bridge={bridge} />}</div>
      <div className="sec-h">Infra Services</div>
      <div>
        {ws &&
          (ws.infra.services.length ? (
            ws.infra.services.map((s) => <ServiceRow key={s.name} s={s} nested={false} />)
          ) : (
            <div className="row">No infra containers found (is `sandbox connect` running?)</div>
          ))}
      </div>
      <div className="sec-h">k8s Forwards</div>
      <div>
        {k8s &&
          (k8s.forwards.length ? (
            k8s.forwards.map((f) => (
              <div className="row" key={f.name}>
                <span className={`dot ${f.healthy ? "ok" : "bad"}`} />
                <span className="name">{f.name}</span>
                <span className="port">:{f.port}</span>
                {!f.healthy && f.detail && <span className="detail">{f.detail}</span>}
              </div>
            ))
          ) : (
            <div className="row">No k8s forwards configured</div>
          ))}
      </div>
      <div className="sec-h">Kube Context</div>
      <div>{kube && <KubeRow kube={kube} bridge={bridge} onSwitched={setKube} />}</div>
    </div>
  );
}
