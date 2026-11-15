/**
 * dockerode, loaded on first use. Its graph is about 300 CommonJS modules (~0.2 s of CPU at
 * start), and most processes that import docker.ts never reach the Engine.
 *
 * A bundler cannot follow this require: the CLI leaves dockerode external, so it resolves at
 * run time, and the VS Code extension's esbuild.mjs swaps this module for a static import.
 */
import { createRequire } from "node:module";

import type Dockerode from "dockerode";

export function loadDockerode(): typeof Dockerode {
  return createRequire(import.meta.url)("dockerode");
}
