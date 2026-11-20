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

  // SW-719: every release puts a `chore: version packages` commit on main; its gap is no code change.
  const versionPackages = [
    "diff --git a/.changeset/brave-cats.md b/.changeset/brave-cats.md",
    "deleted file mode 100644",
    "index 1111111..0000000",
    "--- a/.changeset/brave-cats.md",
    "+++ /dev/null",
    "@@ -1,5 +0,0 @@",
    "----",
    '-"werkmeister": patch',
    "----",
    "-cli: a fix",
    "diff --git a/apps/cli/CHANGELOG.md b/apps/cli/CHANGELOG.md",
    "index 2222222..3333333 100644",
    "--- a/apps/cli/CHANGELOG.md",
    "+++ b/apps/cli/CHANGELOG.md",
    "@@ -1,3 +1,9 @@",
    " # werkmeister",
    "+## 0.96.5",
    "diff --git a/apps/cli/package.json b/apps/cli/package.json",
    "index 4444444..5555555 100644",
    "--- a/apps/cli/package.json",
    "+++ b/apps/cli/package.json",
    "@@ -1,6 +1,6 @@",
    ' {"name": "werkmeister",',
    '-  "version": "0.96.4",',
    '+  "version": "0.96.5",',
    '   "license": "Apache-2.0",',
    "",
  ].join("\n");
  const behindBy = (log: string) =>
    checkCliCurrent({
      cliDir: "/r",
      run: fake({
        ...linked,
        "rev-list": { status: 0, stdout: "1\n" },
        "merge-base": { status: 1 },
        log: { status: 0, stdout: log },
      }),
    });

  it("behind only by a version-packages commit is current (SW-719)", () => {
    const r = behindBy(versionPackages);
    expect(r.current).toBe(true);
    expect(r.text).toMatch(/^current: .*1 commits behind origin\/main, only version bumps/);
  });

  it("behind by a source change, or a package.json change beyond its version, is stale (SW-719)", () => {
    const source = `${versionPackages}diff --git a/apps/cli/src/main.ts b/apps/cli/src/main.ts\n--- a/apps/cli/src/main.ts\n+++ b/apps/cli/src/main.ts\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(behindBy(source).current).toBe(false);
    const dep = versionPackages.replace('+  "version": "0.96.5",', '+  "dockerode": "^6.0.0",');
    expect(behindBy(dep).current).toBe(false);
    const added = versionPackages.replace("deleted file mode", "new file mode");
    expect(behindBy(added).current).toBe(false);
    expect(behindBy("").current).toBe(false);
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
