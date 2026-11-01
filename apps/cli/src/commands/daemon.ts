/**
 * werkmeister daemon <status|install|uninstall|restart>
 *
 * The host daemon (SW-184: the MCP server on port 3002), kept up by launchd on
 * macOS. `install` is the same step `machine setup` runs when the person says yes.
 */

import { buildOf, daemonStatus } from "werkmeister-core/daemon_client";
import { syncDaemonAgent, uninstallDaemonAgent } from "werkmeister-core/machine_setup";
import { appEntryPath, MCP, restart, serves, status } from "werkmeister-core/web_servers";
import { Colors } from "../lib/config.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const action = args.action as "status" | "install" | "uninstall" | "restart";
  if (action === "restart") return restart(MCP);
  const steps =
    action === "uninstall"
      ? [uninstallDaemonAgent()]
      : await syncDaemonAgent(action === "status", action === "install");
  if (action === "status") {
    // launchd's copy keeps no PID file, so `status` alone calls it not running: ask the port.
    const s = await status(MCP);
    const serving = s.healthy || (await serves(MCP.port));
    const d = serving ? await daemonStatus() : null;
    // The entry launchd would start, which can differ from what the daemon watches only if the agent is out of sync.
    const onDisk = buildOf(appEntryPath(MCP));
    const build = d && {
      loaded: d.loaded,
      onDisk,
      stale: d.loaded !== null && onDisk !== null && d.loaded !== onDisk,
    };
    if (args.json) {
      console.log(JSON.stringify({ ...s, serving, build, agent: steps[0]?.detail ?? null }));
      return;
    }
    const state = serving ? "serving" : s.running ? "running, not answering" : "not running";
    const pid = s.pid ?? d?.pid;
    console.log(`${MCP.label}: ${state} on ${s.url}${pid ? ` (pid ${pid})` : ""}`);
    if (build?.stale)
      console.log(
        `${Colors.YELLOW}!${Colors.RESET} build: stale (loaded ${build.loaded}, on disk ${build.onDisk})` +
          (d?.restartPending
            ? "; restarts by itself once no call or queued feature is in flight"
            : ""),
      );
    else if (build?.loaded) console.log(`${Colors.GREEN}✓${Colors.RESET} build: ${build.loaded}`);
  }
  for (const step of steps) {
    const mark = step.ok ? `${Colors.GREEN}✓${Colors.RESET}` : `${Colors.RED}✗${Colors.RESET}`;
    console.log(`${mark} ${step.label}: ${step.detail}`);
  }
  if (action !== "status" && steps.some((s) => !s.ok)) process.exit(1);
}
