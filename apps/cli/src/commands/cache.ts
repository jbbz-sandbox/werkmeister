/**
 * sandbox cache prune [name] [--reset] [--force] [--dry-run]
 *
 * Apply each shared cache's rule from the registry's `caches:` (SW-69):
 * `max_age` deletes older entries, `prune` runs the tool's own command, and
 * `--reset` empties the cache. See `pruneCaches` in werkmeister-core.
 */

import { pruneCaches } from "werkmeister-core/build_caches";
import { Colors, warn } from "../lib/config.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  if (args.action !== "prune") {
    warn(`Unknown action \`${String(args.action)}\` — the only action is \`prune\`.`);
    process.exit(2);
  }
  const results = await pruneCaches({
    name: typeof args.name === "string" ? args.name : undefined,
    reset: Boolean(args.reset),
    force: Boolean(args.force),
    dryRun: Boolean(args.dry_run),
  });
  if (!results.length) console.log("No caches in the registry.");
  for (const r of results) {
    const mark = r.ok ? `${Colors.GREEN}✓${Colors.RESET}` : `${Colors.RED}✗${Colors.RESET}`;
    console.log(`${mark} ${r.name} (${r.action}): ${r.detail}`);
  }
  if (results.some((r) => !r.ok)) process.exit(1);
}
