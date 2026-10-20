/**
 * sandbox optimize
 *
 * Analyze running containers and compare actual usage against configured limits.
 * Shows which services are over/under-provisioned and generates recommendations.
 *
 * Examples:
 *     sandbox optimize              # Analyze current usage vs configured limits
 *     sandbox optimize --collect 5  # Collect for 5 minutes first, then analyze
 */

import { formatMem, optimizeReport, type ServiceUsage } from "werkmeister-core/stats";
import { Colors } from "../lib/config.js";

/** How each status reads in the table — the colour is the whole point of it. */
const STATUS_LABEL: Record<ServiceUsage["status"], string> = {
  risk: `${Colors.RED}RISK - near limit${Colors.RESET}`,
  moderate: `${Colors.YELLOW}OK - moderate${Colors.RESET}`,
  over_provisioned: `${Colors.CYAN}OVER-PROVISIONED${Colors.RESET}`,
  ok: `${Colors.GREEN}OK${Colors.RESET}`,
  no_limit: `${Colors.DIM}no limit set${Colors.RESET}`,
};

/** Execute the ``sandbox optimize`` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  const duration = (args.collect as number) ?? 0;
  const interval = (args.interval as number) ?? 10;

  console.log(`\n${Colors.BOLD}=== Resource Optimization Analysis ===${Colors.RESET}\n`);

  const report = await optimizeReport(duration, interval);
  if (!report.usage.length) return; // optimizeReport warned

  // Compare actual usage vs configured limits
  console.log(`\n${Colors.BOLD}--- Usage vs Configured Limits ---${Colors.RESET}\n`);

  const header =
    `  ${Colors.BOLD}${"Service".padEnd(30)}  ` +
    `${"Max Mem".padStart(8)}  ${"Limit".padStart(8)}  ${"CPU Lim".padStart(7)}  ` +
    `${"Usage".padStart(7)}  ${"Status".padEnd(20)}${Colors.RESET}`;
  console.log(header);
  console.log(`  ${"─".repeat(91)}`);

  for (const u of report.usage) {
    console.log(
      `  ${u.container.padEnd(30)}  ` +
        `${formatMem(u.maxMemMib).padStart(8)}  ` +
        `${(u.limit ?? "n/a").padStart(8)}  ${(u.cpuLimit ?? "n/a").padStart(7)}  ` +
        `${u.usagePct.toFixed(0).padStart(6)}%  ` +
        `${STATUS_LABEL[u.status]}`,
    );
  }

  console.log();

  // Recommendations section
  const issues = report.usage.filter((u) => u.status === "risk" || u.status === "over_provisioned");
  if (issues.length) {
    console.log(`${Colors.BOLD}--- Recommendations ---${Colors.RESET}\n`);
    for (const u of issues) {
      if (u.status === "risk") {
        console.log(
          `  ${Colors.RED}! ${u.container}${Colors.RESET}: ` +
            `Using ${u.usagePct.toFixed(0)}% of memory limit. ` +
            "Consider increasing to avoid OOM kills.",
        );
      } else {
        console.log(
          `  ${Colors.CYAN}~ ${u.container}${Colors.RESET}: ` +
            `Only using ${u.usagePct.toFixed(0)}% of memory limit. ` +
            "Could reduce limit to free resources.",
        );
      }
    }
    console.log();
  }

  // Generate recommended limits from data
  if (report.recommendations.length) {
    console.log(`${Colors.BOLD}--- Data-Driven Limit Recommendations ---${Colors.RESET}\n`);
    console.log(`  ${Colors.DIM}Based on observed max usage + 50% headroom:${Colors.RESET}\n`);
    for (const r of report.recommendations) {
      console.log(
        `  ${r.name.padEnd(30)}  ` +
          `cpus: ${r.recommended_cpus.padStart(5)}  ` +
          `memory: ${r.recommended_memory.padStart(5)}`,
      );
    }
    console.log();
    console.log(
      `  ${Colors.DIM}To update: edit config/services.yaml (memory_limit, memory_reservation, cpus)${Colors.RESET}`,
    );
    console.log(
      `  ${Colors.DIM}For shared infra: edit compose/shared-infra.yml (deploy.resources)${Colors.RESET}`,
    );
  }

  console.log();
}
