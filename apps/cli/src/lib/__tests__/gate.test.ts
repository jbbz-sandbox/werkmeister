/** PreToolUse standards gate. */

import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// gate.main() reads the hook payload from fd 0 via fs.readFileSync(0). fd 0
// can't be reassigned and node:fs exports aren't spy-able, so intercept the
// single fd-0 read here; everything else delegates to the real fs.
const hh = vi.hoisted(() => ({ stdin: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (fd: unknown, ...rest: unknown[]) =>
      fd === 0 && hh.stdin !== null
        ? hh.stdin
        : (actual.readFileSync as (...args: unknown[]) => unknown)(fd, ...rest),
  };
});

import * as fs from "node:fs";
import * as gate from "werkmeister-core/gate";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeManifest(workspace: string, domains?: Record<string, unknown> | null): void {
  const manifest = {
    generated_by: "werkmeister workspace init",
    universal: ["comments", "engineering"],
    domains:
      domains !== undefined
        ? domains
        : {
            ui: {
              applies_to: ["**/*.tsx", "**/*.jsx"],
              summary: "UI standard — render/effect ordering.",
            },
          },
  };
  const sandbox = path.join(workspace, ".werkmeister");
  fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "standards.json"), JSON.stringify(manifest));
}

function state(workspace: string, sessionId: string): Record<string, unknown> | null {
  const p = path.join(workspace, ".werkmeister", ".gate", `${sessionId}.json`);
  try {
    if (!fs.statSync(p).isFile()) return null;
  } catch {
    return null;
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---- decision table -------------------------------------------------------

describe("decide — decision table", () => {
  it("allows outside a workspace", () => {
    expect(gate.decide(tmp, "s1", path.join(tmp, "x.tsx"))).toBeNull();
  });

  it("allows when no manifest", () => {
    fs.mkdirSync(path.join(tmp, ".werkmeister"));
    expect(gate.decide(tmp, "s1", path.join(tmp, "x.tsx"))).toBeNull();
  });

  it("first edit any path denies phase entry", () => {
    writeManifest(tmp);
    const reason = gate.decide(tmp, "s1", path.join(tmp, "README.md"));
    expect(reason).not.toBeNull();
    expect(reason).toContain("w9r-implement");
    expect(reason).toContain("Precedence:");
    expect(state(tmp, "s1")).toEqual({ phase_entry_delivered: true, delivered: [] });
  });

  it("second edit to ungoverned path allows", () => {
    writeManifest(tmp);
    gate.decide(tmp, "s1", path.join(tmp, "README.md"));
    expect(gate.decide(tmp, "s1", path.join(tmp, "README.md"))).toBeNull();
  });

  it("governed path denies domain payload", () => {
    writeManifest(tmp);
    gate.decide(tmp, "s1", path.join(tmp, "README.md"));
    const reason = gate.decide(tmp, "s1", path.join(tmp, "web", "Button.tsx"));
    expect(reason).not.toBeNull();
    expect(reason).toContain("w9r-ui-standard");
    expect(reason).toContain("render/effect ordering");
    expect(state(tmp, "s1")).toEqual({ phase_entry_delivered: true, delivered: ["ui"] });
  });

  it("domain only denied once", () => {
    writeManifest(tmp);
    gate.decide(tmp, "s1", path.join(tmp, "README.md"));
    gate.decide(tmp, "s1", path.join(tmp, "web", "Button.tsx"));
    expect(gate.decide(tmp, "s1", path.join(tmp, "web", "Other.tsx"))).toBeNull();
  });

  it("first edit to governed path coalesces both payloads", () => {
    writeManifest(tmp);
    const reason = gate.decide(tmp, "s1", path.join(tmp, "web", "Button.tsx"));
    expect(reason).not.toBeNull();
    expect(reason).toContain("w9r-implement");
    expect(reason).toContain("w9r-ui-standard");
    expect((reason?.match(/Precedence:/g) || []).length).toBe(1);
    expect(state(tmp, "s1")).toEqual({ phase_entry_delivered: true, delivered: ["ui"] });
  });

  it("ungoverned path after phase entry delivered allows", () => {
    writeManifest(tmp);
    gate.decide(tmp, "s1", path.join(tmp, "README.md"));
    expect(gate.decide(tmp, "s1", path.join(tmp, "docs", "notes.md"))).toBeNull();
  });

  it("sessions are independent", () => {
    writeManifest(tmp);
    gate.decide(tmp, "s1", path.join(tmp, "README.md"));
    const reason = gate.decide(tmp, "s2", path.join(tmp, "README.md"));
    expect(reason).not.toBeNull();
  });
});

// ---- fail-open edges -------------------------------------------------------

describe("decide — fail-open edges", () => {
  it("unreadable state file allows", () => {
    writeManifest(tmp);
    const stateDir = path.join(tmp, ".werkmeister", ".gate");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "s1.json"), "{ not json");
    expect(gate.decide(tmp, "s1", path.join(tmp, "README.md"))).toBeNull();
  });

  it("malformed manifest allows", () => {
    fs.mkdirSync(path.join(tmp, ".werkmeister"));
    fs.writeFileSync(path.join(tmp, ".werkmeister", "standards.json"), "not json");
    expect(gate.decide(tmp, "s1", path.join(tmp, "README.md"))).toBeNull();
  });

  it("manifest not a dict allows", () => {
    fs.mkdirSync(path.join(tmp, ".werkmeister"));
    fs.writeFileSync(
      path.join(tmp, ".werkmeister", "standards.json"),
      JSON.stringify(["not", "a", "dict"]),
    );
    expect(gate.decide(tmp, "s1", path.join(tmp, "README.md"))).toBeNull();
  });

  it("unwritable state dir allows instead of denying forever", () => {
    writeManifest(tmp);
    const gateDir = path.join(tmp, ".werkmeister", ".gate");
    fs.mkdirSync(path.dirname(gateDir), { recursive: true });
    fs.writeFileSync(gateDir, "blocking file, not a directory");
    expect(gate.decide(tmp, "s1", path.join(tmp, "README.md"))).toBeNull();
  });

  it("empty session id allows", () => {
    writeManifest(tmp);
    expect(gate.decide(tmp, "", path.join(tmp, "README.md"))).toBeNull();
  });

  it("session id with path separator allows", () => {
    writeManifest(tmp);
    expect(gate.decide(tmp, "../../etc", path.join(tmp, "README.md"))).toBeNull();
  });
});

// ---- resetSessionState -----------------------------------------------------

describe("resetSessionState", () => {
  it("deletes existing file", () => {
    writeManifest(tmp);
    gate.decide(tmp, "s1", path.join(tmp, "README.md"));
    expect(state(tmp, "s1")).not.toBeNull();
    gate.resetSessionState(tmp, "s1");
    expect(state(tmp, "s1")).toBeNull();
  });

  it("missing file is a no-op", () => {
    expect(() => gate.resetSessionState(tmp, "s1")).not.toThrow();
  });

  it("rejects unsafe session id", () => {
    expect(() => gate.resetSessionState(tmp, "../../etc")).not.toThrow();
  });
});

// ---- main(): stdin -> hookSpecificOutput -----------------------------------

function runMain(stdinText: string): string {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.join(" "));
  });
  hh.stdin = stdinText;
  const prevTTY = process.stdin.isTTY;
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  try {
    gate.main();
  } finally {
    hh.stdin = null;
    Object.defineProperty(process.stdin, "isTTY", { value: prevTTY, configurable: true });
    vi.restoreAllMocks();
  }
  return logs.join("\n");
}

describe("main", () => {
  it("prints deny JSON on first edit", () => {
    writeManifest(tmp);
    const payload = JSON.stringify({
      session_id: "s1",
      cwd: tmp,
      tool_input: { file_path: path.join(tmp, "README.md") },
    });
    const out = runMain(payload);
    const data = JSON.parse(out);
    expect(data.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(data.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(data.hookSpecificOutput.permissionDecisionReason).toContain("w9r-implement");
  });

  it("prints nothing on allow", () => {
    fs.mkdirSync(path.join(tmp, ".werkmeister")); // no manifest -> allow
    const payload = JSON.stringify({
      session_id: "s1",
      cwd: tmp,
      tool_input: { file_path: path.join(tmp, "README.md") },
    });
    expect(runMain(payload)).toBe("");
  });

  it("never raises on malformed stdin", () => {
    expect(runMain("not json")).toBe("");
  });

  it("never raises on missing fields", () => {
    expect(runMain("{}")).toBe("");
  });
});
