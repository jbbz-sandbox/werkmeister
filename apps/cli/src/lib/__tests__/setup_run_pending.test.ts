/**
 * SW-343: a required step skipped on purpose (no TTY / --yes) is ⚠ and the summary
 * must not claim success. runSetup, the reporter and the config writers are stubbed: nothing
 * touches the machine (SW-354: unstubbed, `run` wrote the host's ~/.werkmeister from the gate container).
 */
import { expect, it, vi } from "vitest";

const said: string[] = [];
vi.mock("werkmeister-core/reporter", async (orig) => ({
  ...(await orig<object>()),
  success: (m: string) => said.push(`[ok] ${m}`),
  warn: (m: string) => said.push(`[warn] ${m}`),
  info: () => {},
}));
vi.mock("werkmeister-core/global_config", async (orig) => ({
  ...(await orig<object>()),
  save: () => "",
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
