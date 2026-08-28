/**
 * The CRLF case is the one a test can pin: five of the six former copies
 * returned "demo\r" for it, and this suite fails if anyone simplifies
 * `split(/\r?\n/)` back to `split("\n")`.
 *
 * The other fix — stat-and-catch instead of existsSync-then-stat — is a race
 * and is not reproducible here. The symlink case below only pins the weaker
 * property that an unstattable .env reads as absent; `existsSync` short-circuits
 * on a dangling link, so it would have passed against the old code too.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { loadDotenv } from "../dotenv.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("loadDotenv", () => {
  it("finds the nearest .env by walking up", () => {
    const deep = path.join(tmp, "a", "b");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(tmp, ".env"), "FEATURE=outer\n");
    fs.writeFileSync(path.join(tmp, "a", ".env"), "FEATURE=inner\n");

    expect(loadDotenv(deep)["FEATURE"]).toBe("inner");
  });

  it("returns {} when no .env exists anywhere above", () => {
    // Walks to the filesystem root; the assertion is that it terminates and
    // reports nothing rather than throwing.
    expect(loadDotenv(tmp)).toEqual({});
  });

  it("strips the \\r from a CRLF file", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "FEATURE=demo\r\nSLOT=3\r\n");

    // The pre-collapse copies returned "demo\r" here, which matches no slot.
    expect(loadDotenv(tmp)).toEqual({ FEATURE: "demo", SLOT: "3" });
  });

  it("skips blanks, comments and lines with no '='", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "\n# a comment\nNOEQUALS\nFEATURE=demo\n");

    expect(loadDotenv(tmp)).toEqual({ FEATURE: "demo" });
  });

  it("keeps '=' inside a value", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "DATABASE_URL=postgres://u:p@h/db?x=1\n");

    expect(loadDotenv(tmp)["DATABASE_URL"]).toBe("postgres://u:p@h/db?x=1");
  });

  it("treats an unstattable .env as absent instead of throwing", () => {
    fs.symlinkSync(path.join(tmp, "gone"), path.join(tmp, ".env"));

    expect(() => loadDotenv(tmp)).not.toThrow();
    expect(loadDotenv(tmp)).toEqual({});
  });
});
