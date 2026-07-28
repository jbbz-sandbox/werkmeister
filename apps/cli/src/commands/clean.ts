/**
 * sandbox clean [--all] [--dry-run]
 *
 * Remove orphaned Docker volumes and stale slot entries from stopped
 * features. With --all, also tears down active features first.
 */

import { isCaddyRunning, reloadCaddy } from "../lib/caddy.js";
import { Colors, getVolumeBaseNames, info, success, warn } from "../lib/config.js";
import { composeDown, getContainerStatus, workspaceForFeature } from "../lib/docker.js";
import { generateCaddyfile } from "../lib/generate.js";
import { ProcError, run as procRun } from "../lib/proc.js";
import { getAllSlots, releaseSlot } from "../lib/slots.js";

/**
 * Volume base names declared by the service registry, longest first.
 *
 * Longest-first matters for featureFromVolume(): when one base name ends with
 * another ("cache" and "turbo-cache"), the shorter one would otherwise match
 * first and leave part of the base in the extracted feature name.
 *
 * A registry that cannot be read yields `[]`, which classifies nothing as a
 * sandbox volume — volume cleanup is skipped rather than guessing at names.
 */
function volumeBaseNames(): string[] {
  let bases: string[];
  try {
    bases = getVolumeBaseNames();
  } catch (e) {
    warn(
      `Could not read the service registry (${e instanceof Error ? e.message : String(e)}) -- ` +
        "skipping Docker volume cleanup",
    );
    return [];
  }
  return bases.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * Return all Docker volume names that look like sandbox per-feature volumes.
 *
 * Sandbox volumes follow the pattern ``<feature>-<volume_base_name>``.
 * We identify them by checking against the volume base names the service
 * registry declares.
 */
function listSandboxVolumes(baseNames: string[]): string[] {
  if (!baseNames.length) {
    return [];
  }

  let allVolumes: string[];
  try {
    const result = procRun(["docker", "volume", "ls", "--format", "{{.Name}}"], {
      capture: true,
      timeout: 15,
    });
    if (result.status !== 0) {
      return [];
    }
    allVolumes = result.stdout
      .split(/\r?\n/)
      .map((v) => v.trim())
      .filter(Boolean);
  } catch (e) {
    if (e instanceof ProcError && (e.code === "ENOENT" || e.code === "ETIMEDOUT")) return [];
    throw e;
  }

  const sandboxVolumes: string[] = [];
  for (const vol of allVolumes) {
    for (const base of baseNames) {
      if (vol.endsWith(`-${base}`)) {
        sandboxVolumes.push(vol);
        break;
      }
    }
  }
  return sandboxVolumes.sort();
}

/**
 * Extract the feature name prefix from a per-feature volume name.
 *
 * *baseNames* must be longest-first (see volumeBaseNames()).
 */
function featureFromVolume(volName: string, baseNames: string[]): string | null {
  for (const base of baseNames) {
    const suffix = `-${base}`;
    if (volName.endsWith(suffix)) {
      return volName.slice(0, volName.length - suffix.length);
    }
  }
  return null;
}

/** Remove a single Docker volume. */
function removeVolume(name: string): boolean {
  try {
    const result = procRun(["docker", "volume", "rm", name], { capture: true, timeout: 15 });
    return result.status === 0;
  } catch (e) {
    if (e instanceof ProcError && (e.code === "ENOENT" || e.code === "ETIMEDOUT")) return false;
    throw e;
  }
}

/** Execute the ``sandbox clean`` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  const cleanAll = Boolean(args.all);
  const dryRun = Boolean(args.dry_run);

  console.log(`\n${Colors.BOLD}=== sandbox clean ===${Colors.RESET}\n`);

  if (dryRun) {
    info("Dry run -- nothing will be removed\n");
  }

  // ------------------------------------------------------------------
  // Step 1: Identify active features
  // ------------------------------------------------------------------
  const activeSlots = getAllSlots();
  let activeFeatures = new Set(Object.keys(activeSlots));

  if (activeFeatures.size) {
    console.log(
      `  ${Colors.CYAN}Active features:${Colors.RESET} ${[...activeFeatures].sort().join(", ")}`,
    );
  } else {
    console.log(`  ${Colors.DIM}No active features${Colors.RESET}`);
  }
  console.log();

  // ------------------------------------------------------------------
  // Step 2: If --all, tear down active features first
  // ------------------------------------------------------------------
  if (cleanAll && activeFeatures.size) {
    info("--all: tearing down active features...");
    for (const feature of [...activeFeatures].sort()) {
      if (dryRun) {
        console.log(`  ${Colors.DIM}[dry-run] Would stop: ${feature}${Colors.RESET}`);
      } else {
        info(`Stopping ${feature}...`);
        composeDown(feature, { removeVolumes: true });
        releaseSlot(feature);
      }
    }
    if (!dryRun) {
      generateCaddyfile();
      if (isCaddyRunning()) {
        reloadCaddy();
      }
    }
    console.log();
    activeFeatures = new Set(); // All stopped now
  }

  // ------------------------------------------------------------------
  // Step 3: Find and remove orphaned Docker volumes
  // ------------------------------------------------------------------
  info("Scanning for per-feature Docker volumes...");
  const baseNames = volumeBaseNames();
  const sandboxVolumes = listSandboxVolumes(baseNames);

  if (!sandboxVolumes.length) {
    console.log(`  ${Colors.DIM}No per-feature Docker volumes found${Colors.RESET}`);
  } else {
    const orphanVolumes: string[] = [];
    const activeVolumes: string[] = [];
    for (const vol of sandboxVolumes) {
      const feature = featureFromVolume(vol, baseNames);
      if (feature && activeFeatures.has(feature)) {
        activeVolumes.push(vol);
      } else {
        orphanVolumes.push(vol);
      }
    }

    if (activeVolumes.length) {
      console.log(`\n  ${Colors.CYAN}Active feature volumes (kept):${Colors.RESET}`);
      for (const vol of activeVolumes) {
        console.log(`    ${Colors.DIM}${vol}${Colors.RESET}`);
      }
    }

    if (orphanVolumes.length) {
      console.log(`\n  ${Colors.YELLOW}Orphaned volumes to remove:${Colors.RESET}`);
      let removed = 0;
      for (const vol of orphanVolumes) {
        if (dryRun) {
          console.log(`    ${Colors.DIM}[dry-run] Would remove: ${vol}${Colors.RESET}`);
        } else {
          const ok = removeVolume(vol);
          if (ok) {
            console.log(`    ${Colors.GREEN}Removed:${Colors.RESET} ${vol}`);
            removed += 1;
          } else {
            console.log(`    ${Colors.RED}Failed:${Colors.RESET} ${vol} (may be in use)`);
          }
        }
      }
      if (!dryRun) {
        success(`Removed ${removed}/${orphanVolumes.length} orphaned volume(s)`);
      }
    } else {
      console.log(`\n  ${Colors.DIM}No orphaned volumes found${Colors.RESET}`);
    }
  }

  // ------------------------------------------------------------------
  // Step 4: Clean stale slot entries
  // ------------------------------------------------------------------
  const staleSlots = getAllSlots();
  // Re-read in case --all already cleaned them
  if (!cleanAll) {
    const staleFeatures: string[] = [];
    for (const [feature, slotInfo] of Object.entries(staleSlots)) {
      if (typeof slotInfo !== "object" || slotInfo === null) {
        staleFeatures.push(feature);
        continue;
      }
      // Check if the feature's containers are actually running
      const containers = getContainerStatus(feature);
      const running = containers.filter((c) => c.status === "running");
      if (!running.length && workspaceForFeature(feature) === null) {
        staleFeatures.push(feature);
      }
    }

    if (staleFeatures.length) {
      console.log(
        `\n  ${Colors.YELLOW}Stale slot entries (no running containers or compose file):${Colors.RESET}`,
      );
      for (const feature of staleFeatures) {
        if (dryRun) {
          console.log(`    ${Colors.DIM}[dry-run] Would release slot: ${feature}${Colors.RESET}`);
        } else {
          releaseSlot(feature);
          console.log(`    ${Colors.GREEN}Released:${Colors.RESET} ${feature}`);
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log(`\n${Colors.GREEN}${Colors.BOLD}=== Clean complete ===${Colors.RESET}\n`);
  if (dryRun) {
    console.log(
      `  ${Colors.DIM}This was a dry run. Re-run without --dry-run to apply changes.${Colors.RESET}`,
    );
  }
  console.log();
}
