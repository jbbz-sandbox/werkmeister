/**
 * werkmeister registry [sync] [--check]
 *
 * Regenerate ~/.werkmeister/services.yaml from every <repo>/.werkmeister/services.yaml
 * under paths.repos_root, merged under ~/.werkmeister/services.local.yaml. The
 * same step `werkmeister machine setup` runs, on its own: for the moment you clone a new
 * repo and want it registered without a full setup pass.
 *
 *   werkmeister registry            # regenerate (sync is the default action)
 *   werkmeister registry --check    # report drift; nonzero exit when stale
 *   werkmeister registry --from <worktree> --out <file>   # prove a branch fragment (SW-281)
 */

import { syncRegistry } from "werkmeister-core/registry_sync";
import { Colors, success, warn } from "../lib/config.js";

export async function run(args: Record<string, unknown>): Promise<void> {
  const action = String(args.action ?? "sync");
  if (action !== "sync") {
    warn(`Unknown action \`${action}\` — the only action is \`sync\` (the default).`);
    process.exit(2);
  }
  const check = Boolean(args.check);
  const from = args.from ? String(args.from) : undefined;
  const target = args.out ? String(args.out) : undefined;
  if (from && !target) {
    warn("`--from` needs `--out`: a branch fragment never writes ~/.werkmeister/services.yaml.");
    process.exit(2);
  }
  const steps = syncRegistry({ checkOnly: check, from, target });
  for (const step of steps) {
    const mark = step.ok ? `${Colors.GREEN}✓${Colors.RESET}` : `${Colors.RED}✗${Colors.RESET}`;
    console.log(`${mark} ${step.label}: ${step.detail}`);
  }
  if (steps.some((s) => !s.ok)) {
    warn(
      check
        ? "Registry is stale — run `werkmeister registry sync`."
        : "Registry was not generated.",
    );
    process.exit(1);
  }
  success(check ? "Registry is up to date." : "Registry generated.");
}
