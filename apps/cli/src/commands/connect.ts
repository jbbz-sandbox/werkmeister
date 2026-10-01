/**
 * sandbox connect
 *
 * Start all shared infrastructure: the k8s port-forwards (redis, postgres),
 * caddy, jaeger, and redisinsight.
 *
 * The work is `sandbox-core/infra`; what is left here is the banners, the health
 * table and the developer-tools block. The three `tools.local.sandbox.com` URLs
 * stay renderer-side deliberately — moving them opens where tool URLs are
 * configured, which is not this migration's question (note 070).
 */

import { Colors } from "../lib/config.js";
import { interruptSignal } from "../lib/interrupt.js";
import { connectK8s, infraHealth, up as infraUp } from "sandbox-core/infra";
import { DASHBOARD, status as webStatus } from "sandbox-core/web_servers";

/** Handle `sandbox connect --k8s`: start/restart the k8s port-forwards container only. */
function runK8sOnly(): void {
  console.log(`\n${Colors.BOLD}=== k8s Connect ===${Colors.RESET}\n`);

  if (!connectK8s()) {
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
    runK8sOnly();
    return;
  }

  console.log(`\n${Colors.BOLD}=== Sandbox Connect ===${Colors.RESET}\n`);

  const infraOk = await infraUp({ signal: interruptSignal() });

  console.log(`\n${Colors.BOLD}--- Health Summary ---${Colors.RESET}\n`);

  // k8s-forwards' start_period is 60s; give recreated containers time to
  // converge before reporting so the summary isn't a premature snapshot.
  const health = await infraHealth(90);
  for (const [name, healthy] of Object.entries(health).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const status = healthy
      ? `${Colors.GREEN}healthy${Colors.RESET}`
      : `${Colors.RED}down${Colors.RESET}`;
    console.log(`  ${name.padEnd(30)} ${status}`);
  }

  const totalHealthy = Object.values(health).filter((v) => v).length;
  const total = Object.keys(health).length;

  console.log();
  if (totalHealthy === total) {
    console.log(`  ${Colors.GREEN}${Colors.BOLD}All ${total} services healthy${Colors.RESET}`);
  } else {
    const down = total - totalHealthy;
    console.log(`  ${Colors.YELLOW}${totalHealthy}/${total} healthy, ${down} down${Colors.RESET}`);
    if (!infraOk) {
      console.log(`  ${Colors.DIM}Check docker and your kubeconfig.${Colors.RESET}`);
    }
  }

  console.log();
  console.log(`  ${Colors.BOLD}Developer tools:${Colors.RESET}`);
  console.log(`    ${Colors.CYAN}RedisInsight:${Colors.RESET}  https://tools.local.sandbox.com/redisinsight`);
  console.log(`    ${Colors.CYAN}Jaeger:${Colors.RESET}        https://tools.local.sandbox.com/jaeger`);
  console.log(`    ${Colors.CYAN}GraphQL:${Colors.RESET}       https://tools.local.sandbox.com/graphql`);
  const mcp = await webStatus(DASHBOARD);
  console.log(`    ${Colors.CYAN}Sandbox MCP:${Colors.RESET}   ${mcp.url}  (workspaces dashboard; MCP at /mcp)`);
  console.log();
}
