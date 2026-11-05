import { describe, expect, it } from "vitest";

import { checkCliCurrent } from "../cli_currency.js";

type Answer = { status: number; stdout?: string; stderr?: string } | "throw";
/** A fake `run` answering by the git/npm subcommand it is asked. */
const fake = (answers: Record<string, Answer>) => (cmd: string[]) => {
  const key = cmd[0] === "git" ? cmd[3] : cmd[0];
  const a = answers[key] ?? { status: 1 };
  if (a === "throw") throw new Error("boom");
  return { status: a.status, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
};
const linked = { "rev-parse": { status: 0, stdout: "main\n" }, fetch: { status: 0 } };

describe("checkCliCurrent", () => {
  it("linked on main containing origin/main is current", () => {
    const r = checkCliCurrent({
      cliDir: "/r",
      run: fake({ ...linked, "merge-base": { status: 0 } }),
    });
    expect(r.current).toBe(true);
  });

  it("linked and behind origin/main is stale, with the fix", () => {
    const r = checkCliCurrent({
      cliDir: "/r",
      run: fake({
        ...linked,
        "rev-list": { status: 0, stdout: "3\n" },
        "merge-base": { status: 1 },
      }),
    });
    expect(r.current).toBe(false);
    expect(r.text).toMatch(/3 commits behind origin\/main.*pull.*turbo run build/);
    // SW-436: a plain pull dies under pull.rebase=true with a merge ref set.
    expect(r.text).toMatch(/&& git -C \S+ pull --ff-only origin main,/);
  });

  it("linked on a feature branch is stale", () => {
    const r = checkCliCurrent({
      cliDir: "/r",
      run: fake({
        ...linked,
        "rev-parse": { status: 0, stdout: "feat\n" },
        "merge-base": { status: 0 },
      }),
    });
    expect(r).toMatchObject({ current: false });
    expect(r.text).toMatch(/'.*', not main/);
  });

  it("linked with a failing fetch is unchecked, names the error and how to re-check (SW-436, SW-410)", () => {
    const r = checkCliCurrent({
      cliDir: "/r",
      run: fake({
        ...linked,
        fetch: {
          status: 128,
          stderr: "git@github.com: Permission denied (publickey).\nfatal: x\n",
        },
      }),
    });
    expect(r.current).toBeNull();
    expect(r.text).toMatch(
      /could not check.*Permission denied \(publickey\)\..*werkmeister issue start/,
    );
    expect(r.text).not.toMatch(/behind/);
  });

  it("npm install: behind the latest release is stale, equal or ahead is current", () => {
    const npm = (v: string) =>
      fake({ "rev-parse": { status: 128 }, npm: { status: 0, stdout: `${v}\n` } });
    const stale = checkCliCurrent({ cliDir: "/n", version: "0.9.0", run: npm("0.10.0") });
    expect(stale.current).toBe(false);
    expect(stale.text).toMatch(/npm i -g werkmeister@latest/);
    expect(checkCliCurrent({ cliDir: "/n", version: "0.10.0", run: npm("0.10.0") }).current).toBe(
      true,
    );
    expect(checkCliCurrent({ cliDir: "/n", version: "0.11.0", run: npm("0.10.0") }).current).toBe(
      true,
    );
  });

  it("npm install: offline or a thrown run is unchecked", () => {
    const off = fake({ "rev-parse": { status: 128 }, npm: { status: 1 } });
    expect(checkCliCurrent({ cliDir: "/n", version: "1.0.0", run: off }).current).toBeNull();
    expect(
      checkCliCurrent({
        cliDir: "/n",
        version: "1.0.0",
        run: fake({ "rev-parse": "throw", npm: "throw" }),
      }).current,
    ).toBeNull();
  });
});
