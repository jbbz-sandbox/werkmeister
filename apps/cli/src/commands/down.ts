/**
 * sandbox down <feature>
 *
 * Stop containers, release the feature's slot, update the reverse proxy
 * configuration, and clean up generated files.
 *
 * The teardown itself is `sandbox-core/lifecycle`; what is left here is argv,
 * the workspace notes (a TTY prompt loop, so it stays CLI-side), and the
 * banners and summary block.
 */

import * as path from "node:path";

import { Colors, error, info, warn } from "../lib/config.js";
import { GraduationError } from "sandbox-core/graduate";
import { down as downFeature, reloadProxy, teardownNotes } from "sandbox-core/lifecycle";
import type { DownResult } from "sandbox-core/lifecycle";
import { type Note } from "sandbox-core/notes";
import { loadDotenv } from "../lib/dotenv.js";
import { interruptSignal } from "../lib/interrupt.js";
import { getAllSlots } from "sandbox-core/slots";
import { graduateOne, input } from "./notes.js";

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
    // The read is `teardownNotes`; what is left here is the printing and the
    // TTY question of whether to offer graduation, which a library may not ask.
    const { workspace, handoff, decisions, graduated } = await teardownNotes(feature);
    if (workspace === null) {
      return;
    }
    for (const done of graduated) {
      info(`Graduated ${path.basename(done.path)} — ${done.frontmatter["graduated_to"]} is committed.`);
    }

    if (handoff !== null) {
      console.log(
        `${Colors.BOLD}Latest handoff${Colors.RESET} — review before this context is gone:\n`,
      );
      printNote(handoff, workspace);
    }

    if (!decisions.length) {
      return;
    }

    if (!process.stdin.isTTY) {
      console.log(
        `${Colors.BOLD}Open decision notes${Colors.RESET} — graduate what ` +
          "should outlive the feature (PR body, the issue, docs/standards); " +
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
 * Print what the library deliberately does not, then tear *feature* down.
 *
 * The statement order is the constraint: both the notes and the intercept
 * cleanup inside `down` resolve the workspace from compose labels on the
 * still-running containers, so they must precede the teardown.
 */
async function teardown(feature: string, removeVolumes: boolean): Promise<DownResult> {
  console.log(`\n${Colors.BOLD}=== sandbox down: ${feature} ===${Colors.RESET}\n`);
  await printNotes(feature);
  return downFeature(feature, { removeVolumes, signal: interruptSignal() });
}

/** Execute the `sandbox down` command. */
export async function run(args: Record<string, unknown>): Promise<void> {
  const dotenv = loadDotenv(process.cwd());
  const removeVolumes = Boolean(args.volumes);
  const allFeatures = Boolean(args.all_features);

  if (allFeatures) {
    const slots = await getAllSlots();
    const names = Object.keys(slots);
    if (!names.length) {
      info("No active features to stop.");
      return;
    }
    console.log(`\n${Colors.BOLD}=== sandbox down --all-features ===${Colors.RESET}\n`);
    info(`Stopping ${names.length} feature(s): ${names.join(", ")}`);
    for (const feature of names) {
      await teardown(feature, removeVolumes);
    }
    await reloadProxy();
    console.log(`\n${Colors.GREEN}${Colors.BOLD}=== All features stopped ===${Colors.RESET}\n`);
    return;
  }

  const feature = (args.feature as string | null) || dotenv["FEATURE"];
  if (!feature) {
    error("Feature name required: pass it as an argument or set FEATURE in a .env file.");
    process.exit(1);
  }

  if (feature === "infra") {
    console.log(`\n${Colors.BOLD}=== sandbox down: ${feature} ===${Colors.RESET}\n`);
    const infra = await import("sandbox-core/infra");
    await infra.down(removeVolumes);
    console.log();
    return;
  }

  const { slot } = await teardown(feature, removeVolumes);
  await reloadProxy();

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
