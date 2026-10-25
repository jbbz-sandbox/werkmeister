/**
 * sandbox connect
 *
 * Start shared infrastructure: the k8s port-forwards (redis, postgres) and
 * caddy, plus jaeger and redisinsight when `infra.profiles` turns them on.
 *
 * The work is `werkmeister-core/infra`; what is left here is the banners, the health
 * table and the developer-tools block. The three `tools.<local_domain>` URLs
 * stay renderer-side deliberately — moving them opens where tool URLs are
 * configured, which is not this migration's question (note 070).
 */

import * as readline from "node:readline/promises";
import { loadIngress } from "werkmeister-core/global_config";
import { connectK8s, infraHealth, up as infraUp } from "werkmeister-core/infra";
import { ghBin, issueTracker, type TrackerAuth } from "werkmeister-core/issue_tracker";
import { run as procRun } from "werkmeister-core/proc";
import { DASHBOARD, MCP, status as webStatus } from "werkmeister-core/web_servers";
import { Colors } from "../lib/config.js";
import { interruptSignal } from "../lib/interrupt.js";

export function trackerLine(label: string, auth: TrackerAuth): string {
  return auth.ok
    ? `  ${Colors.GREEN}issue tracker · ${label} · ok${auth.who ? ` (${auth.who})` : ""}${Colors.RESET}`
    : `  ${Colors.YELLOW}issue tracker · ${label} · ${auth.reason} — run: ${auth.fix}${Colors.RESET}`;
}

/** Report tracker sign-in; on a TTY, offer GitHub's own login. Never fails connect. */
export async function checkTracker(): Promise<void> {
  let label = "";
  try {
    const tracker = issueTracker();
    label = tracker.label;
    let auth = await tracker.checkAuth();
    if (!auth.ok && tracker.id === "github" && process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const yes = /^y/i.test(
        await rl.question(`  GitHub: ${auth.reason}. Sign in now? (${auth.fix}) [y/N] `),
      );
      rl.close();
      if (yes) {
        // The terminal goes to gh; credentials are typed into gh's own prompt, never read here.
        procRun([ghBin(), ...auth.fix.split(" ").slice(1)], { stdio: "inherit" });
        auth = await tracker.checkAuth();
      }
    }
    console.log(trackerLine(tracker.label, auth));
  } catch (e) {
    console.log(
      `  ${Colors.YELLOW}issue tracker · ${label ? `${label} · ` : ""}check failed: ${(e as Error).message}${Colors.RESET}`,
    );
  }
}

/** Handle `sandbox connect --k8s`: start/restart the k8s port-forwards container only. */
async function runK8sOnly(): Promise<void> {
  console.log(`\n${Colors.BOLD}=== k8s Connect ===${Colors.RESET}\n`);

  if (!(await connectK8s())) {
    console.log(`\n  ${Colors.RED}Failed to start k8s port-forwards.${Colors.RESET}`);
    console.log(
      `  ${Colors.DIM}Ensure Docker is running and your kubeconfig is valid.${Colors.RESET}`,
    );
    console.log(`  ${Colors.DIM}Run 'sandbox connect' to start all infrastructure.${Colors.RESET}`);
  }

  console.log();
}

/** Execute the `sandbox connect` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.k8s) {
    await runK8sOnly();
    return;
  }

  console.log(`\n${Colors.BOLD}=== Sandbox Connect ===${Colors.RESET}\n`);

  const infraOk = await infraUp({ signal: interruptSignal() });

  console.log(`\n${Colors.BOLD}--- Health Summary ---${Colors.RESET}\n`);

  // k8s-forwards' start_period is 60s; give recreated containers time to
  // converge before reporting so the summary isn't a premature snapshot.
  const health = await infraHealth(90);
  for (const [name, healthy] of Object.entries(health).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )) {
    const status = healthy
      ? `${Colors.GREEN}healthy${Colors.RESET}`
      : `${Colors.RED}down${Colors.RESET}`;
    console.log(`  ${name.padEnd(30)} ${status}`);
  }

  const totalHealthy = Object.values(health).filter((v) => v).length;
  const total = Object.keys(health).length;

  console.log();
  if (!infraOk) {
    // The health list only counts containers that exist, so a failed `up`
    // could still read "All 1 services healthy" and exit 0.
    console.log(
      `  ${Colors.RED}${Colors.BOLD}Shared infrastructure did not start — see the error above.${Colors.RESET}`,
    );
    console.log(`  ${Colors.DIM}Check docker and your kubeconfig.${Colors.RESET}`);
    process.exitCode = 1;
  } else if (totalHealthy === total) {
    console.log(`  ${Colors.GREEN}${Colors.BOLD}All ${total} services healthy${Colors.RESET}`);
  } else {
    const down = total - totalHealthy;
    console.log(`  ${Colors.YELLOW}${totalHealthy}/${total} healthy, ${down} down${Colors.RESET}`);
  }

  await checkTracker();

  console.log();
  console.log(`  ${Colors.BOLD}Developer tools:${Colors.RESET}`);
  // Opt-in (SW-76): link only what came up, whether by config or COMPOSE_PROFILES.
  const off: string[] = [];
  const tools = `https://tools.${loadIngress().local_domain}`;
  if ("redisinsight" in health) {
    console.log(`    ${Colors.CYAN}RedisInsight:${Colors.RESET}  ${tools}/redisinsight`);
  } else off.push("RedisInsight");
  if ("jaeger" in health) {
    console.log(`    ${Colors.CYAN}Jaeger:${Colors.RESET}        ${tools}/jaeger`);
  } else off.push("Jaeger");
  console.log(`    ${Colors.CYAN}GraphQL:${Colors.RESET}       ${tools}/graphql`);
  // The dashboard is checkout-only (web_servers.start skips it on a package
  // install), so only advertise a URL that is actually being served.
  const dashboard = await webStatus(DASHBOARD);
  if (dashboard.running) {
    console.log(
      `    ${Colors.CYAN}Dashboard:${Colors.RESET}     ${dashboard.url}  (workspaces dashboard)`,
    );
  }
  const mcp = await webStatus(MCP);
  const mcpState = mcp.running ? "" : `  ${Colors.DIM}(not running)${Colors.RESET}`;
  console.log(
    `    ${Colors.CYAN}MCP server:${Colors.RESET}    ${mcp.url}mcp  (bearer token in ~/.werkmeister/mcp-token)${mcpState}`,
  );
  if (off.length) {
    console.log(
      `    ${Colors.DIM}${off.join(", ")}: off — add to infra.profiles in ~/.werkmeister/config.yaml${Colors.RESET}`,
    );
  }
  console.log();
}
