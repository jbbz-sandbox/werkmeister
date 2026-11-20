/**
 * SW-343: a required step skipped on purpose (no TTY / --yes) is ⚠ and the summary
 * must not claim success. runSetup, the reporter and the config writers are stubbed: nothing
 * touches the machine (SW-354: unstubbed, `run` wrote the host's ~/.werkmeister from the gate container).
 */
import { expect, it, vi } from "vitest";

const said: string[] = [];
const saved: Record<string, unknown>[] = [];
vi.mock("werkmeister-core/reporter", async (orig) => ({
  ...(await orig<object>()),
  success: (m: string) => said.push(`[ok] ${m}`),
  warn: (m: string) => said.push(`[warn] ${m}`),
  info: () => {},
}));
vi.mock("werkmeister-core/global_config", async (orig) => ({
  ...(await orig<object>()),
  save: (cfg: Record<string, unknown>) => {
    saved.push(cfg);
    return "";
  },
  writeEnvSh: () => "",
  ensureZshenvSources: () => false,
  ensureZshrcCompletion: () => false,
  patchDesktopConfig: () => false,
}));
vi.mock("werkmeister-core/machine_setup", async (orig) => ({
  ...(await orig<object>()),
  runSetup: async () => [
    { label: "ingress certificate", ok: false, pending: true, detail: "trust skipped" },
  ],
}));

import { run } from "../../commands/setup.js";

it("a pending step warns 'Setup incomplete', never 'Machine is set up', and does not exit 1", async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await run({ yes: true });
  expect(exit).not.toHaveBeenCalled();
  expect(said.join("\n")).toContain("Setup incomplete");
  expect(said.join("\n")).not.toContain("Machine is set up");
});

// SW-842: setup rebuilds config.yaml from a fixed key list; the hand-set ask-rules opt-out must survive it.
it("keeps a hand-set workspace_ask_rules: false", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "setup-cfg-")), "config.yaml");
  fs.writeFileSync(file, "workspace_ask_rules: false\n");
  vi.stubEnv("WERKMEISTER_CONFIG_FILE", file);
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  saved.length = 0;
  try {
    await run({ yes: true });
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
  expect(saved.at(-1)?.workspace_ask_rules).toBe(false);
});

// SW-852: every top-level section setup never asks about survives, not only a fixed list.
it("keeps hand-set budget, models and github_ingest", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "setup-cfg-")), "config.yaml");
  fs.writeFileSync(
    file,
    "budget:\n  host_load: 0.5\nmodels:\n  default: opus\ngithub_ingest:\n  queue_url: https://sqs/q\n",
  );
  vi.stubEnv("WERKMEISTER_CONFIG_FILE", file);
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
  saved.length = 0;
  try {
    await run({ yes: true });
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
  expect(saved.at(-1)?.budget).toEqual({ host_load: 0.5 });
  expect(saved.at(-1)?.models).toEqual({ default: "opus" });
  expect(saved.at(-1)?.github_ingest).toEqual({ queue_url: "https://sqs/q" });
});
