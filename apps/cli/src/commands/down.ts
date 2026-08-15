/**
 * sandbox down <feature>
 *
 * Stop containers, release the feature's slot, update the reverse proxy
 * configuration, and clean up generated files.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { isCaddyRunning, reloadCaddy } from "../lib/caddy.js";
import { Colors, error, info, warn } from "../lib/config.js";
import { composeDown, workspaceForFeature } from "../lib/docker.js";
import { generateCaddyfile } from "../lib/generate.js";
import { GraduationError, reconcileGraduating } from "../lib/graduate.js";
import { latestHandoff, openDecisions, type Note } from "../lib/notes.js";
import { getAllSlots, getSlot, releaseSlot } from "../lib/slots.js";
import { graduateOne, input } from "./notes.js";

/** Walk up from *start* looking for a .env file; return its key=value pairs. */
function loadDotenv(start: string): Record<string, string> {
  let directory = start;
  for (;;) {
    const envFile = path.join(directory, ".env");
    if (fs.existsSync(envFile) && fs.statSync(envFile).isFile()) {
      const result: Record<string, string> = {};
      for (const rawLine of fs.readFileSync(envFile, "utf8").split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) {
          continue;
        }
        const eq = line.indexOf("=");
        result[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      return result;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  return {};
}

/** Regenerate the Caddyfile, then reload running services. */
function reloadProxy(): void {
  info("Updating reverse proxy configuration...");
  generateCaddyfile();
  if (isCaddyRunning()) {
    reloadCaddy();
  } else {
    info("Caddy is not running -- skipping reload");
  }
}

function printNote(note: Note, workspace: string): void {
  const rel = path.relative(workspace, note.path);
  console.log(`  ${Colors.YELLOW}── ${rel} ──${Colors.RESET}`);
  for (const line of note.body.trim().split("\n")) {
    console.log(`  ${line}`);
  }
  console.log();
}

/**
 * Print the latest handoff note; offer to graduate open decision notes.
 *
 * At a real terminal, offer to graduate each open decision note on the spot;
 * otherwise fall back to print-only — never block on stdin. Printing/graduation
 * failures never block teardown. Must run before containers are removed: the
 * workspace lookup reads compose labels off the feature's containers.
 */
async function printNotes(feature: string): Promise<void> {
  try {
    const workspace = workspaceForFeature(feature);
    if (workspace === null) {
      return;
    }
    // Close out any graduation whose scaffold has since been committed, so it
    // stops being offered again. Free when nothing is pending.
    for (const done of reconcileGraduating(workspace)) {
      info(`Graduated ${path.basename(done.path)} — ${done.frontmatter["graduated_to"]} is committed.`);
    }

    const handoff = latestHandoff(workspace);
    if (handoff !== null) {
      console.log(
        `${Colors.BOLD}Latest handoff${Colors.RESET} — review before this context is gone:\n`,
      );
      printNote(handoff, workspace);
    }

    const decisions = openDecisions(workspace);
    if (!decisions.length) {
      return;
    }

    if (!process.stdin.isTTY) {
      console.log(
        `${Colors.BOLD}Open decision notes${Colors.RESET} — graduate what ` +
          "should outlive the feature (PR body, Jira, docs/standards); " +
          "run `sandbox notes graduate` to do it:\n",
      );
      for (const note of decisions) {
        printNote(note, workspace);
      }
      return;
    }

    for (const note of decisions) {
      printNote(note, workspace);
      const choice = (await input(`  Graduate ${path.basename(note.path)}? [g/s] > `))
        .trim()
        .toLowerCase();
      if (choice !== "g") {
        continue;
      }
      try {
        const result = await graduateOne(workspace, note, {
          domain: null,
          kind: null,
          slug: null,
        });
        info(
          `Scaffolded ${result["scaffold_path"]} — run sb-author to fill it ` +
            "in, then `sandbox skills check`. Commit it in the standards repo; " +
            "the note stays open until that file is tracked.",
        );
      } catch (exc) {
        if (exc instanceof GraduationError) {
          warn(`Could not graduate ${path.basename(note.path)}: ${exc.message}`);
          continue;
        }
        throw exc;
      }
    }
  } catch (exc) {
    // never block teardown on printing
    warn(`Could not print workspace notes: ${exc instanceof Error ? exc.message : String(exc)}`);
  }
}

/**
 * Stop containers and release the slot for *feature*.
 *
 * Returns the released slot number, or null if the feature had no slot.
 */
async function downOne(feature: string, removeVolumes: boolean): Promise<number | null> {
  console.log(`\n${Colors.BOLD}=== sandbox down: ${feature} ===${Colors.RESET}\n`);

  await printNotes(feature);

  // k8s intercept cleanup: best-effort, never blocks teardown. Must run before
  // composeDown — leaveFeatureIntercepts resolves the workspace from compose
  // labels on the still-running containers.
  try {
    const { leaveFeatureIntercepts } = await import("../lib/telepresence.js");
    const left = leaveFeatureIntercepts(feature);
    if (left.length) {
      info(`Left k8s intercept(s): ${left.join(", ")}`);
    }
  } catch (exc) {
    // teardown must never block on telepresence
    warn(`Could not clean up k8s intercepts: ${exc instanceof Error ? exc.message : String(exc)}`);
  }

  const slot = getSlot(feature);
  if (slot === null) {
    warn(`Feature '${feature}' does not have an allocated slot`);
    warn("It may already be stopped. Cleaning up anyway...");
  }

  info("Stopping containers...");
  if (removeVolumes) {
    info("--volumes: per-feature Docker volumes will be removed");
  }
  composeDown(feature, { removeVolumes });

  info("Releasing feature slot...");
  releaseSlot(feature);

  return slot;
}

/** Execute the `sandbox down` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  const dotenv = loadDotenv(process.cwd());
  const removeVolumes = Boolean(args.volumes);
  const allFeatures = Boolean(args.all_features);

  if (allFeatures) {
    const slots = getAllSlots();
    const names = Object.keys(slots);
    if (!names.length) {
      info("No active features to stop.");
      return;
    }
    console.log(`\n${Colors.BOLD}=== sandbox down --all-features ===${Colors.RESET}\n`);
    info(`Stopping ${names.length} feature(s): ${names.join(", ")}`);
    for (const feature of names) {
      await downOne(feature, removeVolumes);
    }
    reloadProxy();
    console.log(`\n${Colors.GREEN}${Colors.BOLD}=== All features stopped ===${Colors.RESET}\n`);
    return;
  }

  const feature = (args.feature as string | null) || dotenv["FEATURE"];
  if (!feature) {
    error("Feature name required: pass it as an argument or set FEATURE in a .env file.");
    process.exit(1);
  }

  if (feature === "infra") {
    const infra = await import("../lib/infra.js");
    await infra.down(removeVolumes);
    return;
  }

  const slot = await downOne(feature, removeVolumes);
  reloadProxy();

  console.log(`\n${Colors.GREEN}${Colors.BOLD}=== Feature '${feature}' stopped ===${Colors.RESET}\n`);
  if (slot) {
    console.log(`  ${Colors.DIM}Slot ${slot} released${Colors.RESET}`);
  }
  console.log(`  ${Colors.DIM}Containers removed, proxy updated${Colors.RESET}`);
  if (removeVolumes) {
    console.log(`  ${Colors.DIM}Per-feature Docker volumes removed${Colors.RESET}`);
  } else {
    console.log(`  ${Colors.DIM}Docker volumes preserved (use --volumes to remove)${Colors.RESET}`);
  }
  console.log();
}
