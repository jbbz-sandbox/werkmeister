/**
 * Build entry for the PreToolUse standards gate.
 *
 * The logic lives in `sandbox-core/gate`; this file exists only so esbuild's
 * second entry point and the `dist/lib/gate.js` path stay where they are — the
 * `sandbox` wrapper execs that path for `hooks gate` to skip the commander
 * import chain, and README/CONVENTIONS document it. Bundling follows the import
 * graph, so the entry stays as light as the module it calls.
 */

import { main } from "sandbox-core/gate";

main();
