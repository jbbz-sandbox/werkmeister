import { defineConfig } from "vitest/config";

// Cases spawn processes and do heavy fs work, and their wall time scales with host load: next to other
// workspaces' suites a 1 s case takes 10-50 s, so vitest's 5 s/10 s defaults fail whichever case starves (#178, #206).
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
