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
  info: (m: string) => said.push(`[info] ${m}`),
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
let kubeContext: string | null = null;
const asked: string[] = [];
vi.mock("werkmeister-core/sdk", async (orig) => ({
  ...(await orig<object>()),
  getKubeContext: async () => ({ context: kubeContext, env: "other" }),
}));
vi.mock("../wizard.js", async (orig) => ({
  ...(await orig<object>()),
  confirm: async (q: string, dflt: boolean) => {
    asked.push(q);
    return dflt;
  },
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

// SW-641: the demo apps need k8s-forwards, so with no kube context setup doesn't offer them.
it("offers the demo apps only with a kube context", async () => {
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("exit");
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});

  for (const ctx of [null, "orbstack"]) {
    kubeContext = ctx;
    asked.length = 0;
    said.length = 0;
    await run({ yes: true });
    expect(asked.some((q) => q.includes("demo apps"))).toBe(ctx !== null);
    expect(said.join("\n").includes("Skipping the demo apps")).toBe(ctx === null);
  }
});
