/**
 * Every CLI argv the extension sends. Kept free of `vscode` imports so argv.test.mjs can
 * run each one through the built CLI's `__parse` and catch a spelling the CLI deprecated.
 */

/** Lifecycle actions that map 1:1 onto a `werkmeister feature <action>` subcommand. */
export const LIFECYCLE = ["up", "stop", "restart", "down", "pause", "resume"] as const;

export const ARGV = {
  lifecycle: (action: (typeof LIFECYCLE)[number]) => ["feature", action],
  newWorkspace: ["workspace", "new"],
  openFeature: ["feature", "open"],
  detect: (repo: string) => ["machine", "detect", repo],
  registrySync: ["registry", "sync"],
  connect: ["infra", "connect"],
};

/** One sample of each, for the test. */
export const ALL_ARGV: string[][] = [
  ...LIFECYCLE.map(ARGV.lifecycle),
  ARGV.newWorkspace,
  ARGV.openFeature,
  ARGV.detect("some-repo"),
  ARGV.registrySync,
  ARGV.connect,
];
