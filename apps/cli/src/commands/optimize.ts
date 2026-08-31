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

import { Colors, info, loadServices, warn } from "../lib/config.js";
import { collectStats, formatMem, recommendLimits } from "sandbox-core/stats";

/** Execute the ``sandbox optimize`` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  const duration = (args.collect as number) ?? 0;
  const interval = (args.interval as number) ?? 10;

  console.log(`\n${Colors.BOLD}=== Resource Optimization Analysis ===${Colors.RESET}\n`);

  // Load configured limits from services.yaml
  const services = loadServices();
  const configuredLimits: Record<string, Record<string, any>> = {};
  for (const [svcName, svcCfg] of Object.entries(services)) {
    const memLimit = (svcCfg as Record<string, any>)?.["memory_limit"];
    const memReservation = (svcCfg as Record<string, any>)?.["memory_reservation"];
    if (memLimit) {
      configuredLimits[svcName] = {
        memory_limit: memLimit,
        memory_reservation: memReservation,
        memory_limit_mib: parseConfigMem(memLimit),
        memory_reservation_mib: memReservation ? parseConfigMem(memReservation) : 0,
      };
    }
  }

  let stats;
  if (duration > 0) {
    info(`Collecting stats for ${duration} minute(s)...`);
    stats = await collectStats(duration * 60, interval);
  } else {
    info("Taking a snapshot of current resource usage...");
    // Take a few quick samples for better accuracy
    stats = await collectStats(15, 5);
  }

  if (!Object.keys(stats).length) {
    warn("No running containers found. Start your sandbox first.");
    return;
  }

  // Compare actual usage vs configured limits
  console.log(`\n${Colors.BOLD}--- Usage vs Configured Limits ---${Colors.RESET}\n`);

  const header =
    `  ${Colors.BOLD}${"Service".padEnd(30)}  ` +
    `${"Max Mem".padStart(8)}  ${"Limit".padStart(8)}  ` +
    `${"Usage".padStart(7)}  ${"Status".padEnd(20)}${Colors.RESET}`;
  console.log(header);
  console.log(`  ${"─".repeat(82)}`);

  const issuesFound: Array<[string, string, number]> = [];

  for (const containerName of Object.keys(stats).sort()) {
    const s = stats[containerName];

    // Try to match container name to service config
    const svcName = matchService(containerName, configuredLimits);
    let limitMib: number;
    let limitStr: string;
    if (svcName && svcName in configuredLimits) {
      const cfg = configuredLimits[svcName];
      limitMib = cfg["memory_limit_mib"];
      limitStr = cfg["memory_limit"];
    } else {
      // Check shared-infra services by container name
      limitMib = 0;
      limitStr = "n/a";
    }

    const maxMem = s.maxMem;
    const usagePct = limitMib > 0 ? (maxMem / limitMib) * 100 : 0;

    let status: string;
    if (limitMib > 0) {
      if (usagePct > 85) {
        status = `${Colors.RED}RISK - near limit${Colors.RESET}`;
        issuesFound.push([containerName, "near_limit", usagePct]);
      } else if (usagePct > 60) {
        status = `${Colors.YELLOW}OK - moderate${Colors.RESET}`;
      } else if (usagePct < 20 && limitMib > 256) {
        status = `${Colors.CYAN}OVER-PROVISIONED${Colors.RESET}`;
        issuesFound.push([containerName, "over_provisioned", usagePct]);
      } else {
        status = `${Colors.GREEN}OK${Colors.RESET}`;
      }
    } else {
      status = `${Colors.DIM}no limit set${Colors.RESET}`;
    }

    console.log(
      `  ${containerName.padEnd(30)}  ` +
        `${formatMem(maxMem).padStart(8)}  ` +
        `${limitStr.padStart(8)}  ` +
        `${usagePct.toFixed(0).padStart(6)}%  ` +
        `${status}`,
    );
  }

  console.log();

  // Recommendations section
  if (issuesFound.length) {
    console.log(`${Colors.BOLD}--- Recommendations ---${Colors.RESET}\n`);
    for (const [name, issue, pct] of issuesFound) {
      if (issue === "near_limit") {
        console.log(
          `  ${Colors.RED}! ${name}${Colors.RESET}: ` +
            `Using ${pct.toFixed(0)}% of memory limit. ` +
            "Consider increasing to avoid OOM kills.",
        );
      } else if (issue === "over_provisioned") {
        console.log(
          `  ${Colors.CYAN}~ ${name}${Colors.RESET}: ` +
            `Only using ${pct.toFixed(0)}% of memory limit. ` +
            "Could reduce limit to free resources.",
        );
      }
    }
    console.log();
  }

  // Generate recommended limits from data
  const recommendations = recommendLimits(stats);
  if (recommendations.length) {
    console.log(`${Colors.BOLD}--- Data-Driven Limit Recommendations ---${Colors.RESET}\n`);
    console.log(`  ${Colors.DIM}Based on observed max usage + 50% headroom:${Colors.RESET}\n`);
    for (const r of recommendations) {
      console.log(
        `  ${r.name.padEnd(30)}  ` +
          `cpus: ${r.recommended_cpus.padStart(5)}  ` +
          `memory: ${r.recommended_memory.padStart(5)}`,
      );
    }
    console.log();
    console.log(
      `  ${Colors.DIM}To update: edit config/services.yaml (memory_limit, memory_reservation)${Colors.RESET}`,
    );
    console.log(
      `  ${Colors.DIM}For shared infra: edit compose/shared-infra.yml (deploy.resources)${Colors.RESET}`,
    );
  }

  console.log();
}

/** Parse a memory string from services.yaml (e.g., '2G', '512M', '2560M') to MiB. */
function parseConfigMem(memStr: string): number {
  if (!memStr) return 0.0;
  memStr = memStr.trim();
  let v: number;
  if (memStr.endsWith("G")) v = Number(memStr.slice(0, -1)) * 1024;
  else if (memStr.endsWith("M")) v = Number(memStr.slice(0, -1));
  else if (memStr.endsWith("K")) v = Number(memStr.slice(0, -1)) / 1024;
  else v = Number(memStr);
  return Number.isFinite(v) ? v : 0.0;
}

/**
 * Try to match a Docker container name to a service in config.
 *
 * Container names may be prefixed with feature/project names, e.g.:
 * - 'sandbox-redis' → 'redis'
 * - 'feat-myfeature-frontend-1' → 'frontend'
 * - 'sandbox-k8s-forwards' → 'k8s-forwards'
 */
function matchService(containerName: string, configured: Record<string, any>): string | null {
  // Direct match
  if (containerName in configured) {
    return containerName;
  }

  // Strip common prefixes
  let stripped = containerName;
  for (const prefix of ["sandbox-", "feat-"]) {
    if (stripped.startsWith(prefix)) {
      stripped = stripped.slice(prefix.length);
    }
  }

  // Try stripping feature name (feat-<feature>-<service>-<N>)
  // and trailing container number
  const lastDash = stripped.lastIndexOf("-");
  const parts = lastDash === -1 ? [stripped] : [stripped.slice(0, lastDash), stripped.slice(lastDash + 1)];
  if (/^\d+$/.test(parts[parts.length - 1])) {
    stripped = parts[0];
  }

  // Check against configured services
  if (stripped in configured) {
    return stripped;
  }

  // Try matching by suffix
  for (const svcName of Object.keys(configured)) {
    if (stripped.endsWith(svcName)) {
      return svcName;
    }
    if (containerName.endsWith(svcName)) {
      return svcName;
    }
  }

  return null;
}
