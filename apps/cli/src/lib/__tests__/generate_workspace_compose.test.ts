/**
 * smoke test that the
 * moved generateWorkspaceCompose still allocates a slot and writes the expected
 * workspace artifacts. allocateSlot is stubbed to avoid shelling out to Docker.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSE_FILE } from "sandbox-core/compose_file";
import { dotDir } from "sandbox-core/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sandbox-core/slots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("sandbox-core/slots")>();
  return { ...actual, allocateSlot: async () => 1 };
});

import { generateWorkspaceCompose } from "sandbox-core/generate";
import { type SandboxHome, useSandboxHome } from "./helpers/sandbox_home.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let tmp: string;
let home: SandboxHome;

beforeEach(() => {
  // SANDBOX_ROOT for the templates; a temp ~/.sandbox for the registry.
  process.env.SANDBOX_ROOT = repoRoot;
  home = useSandboxHome();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wscompose-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  home.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("generateWorkspaceCompose", () => {
  it("writes the expected files", async () => {
    const slot = await generateWorkspaceCompose("smoke-test-feature", "frontend", tmp);
    expect(typeof slot).toBe("number");
    expect(fs.statSync(path.join(tmp, COMPOSE_FILE)).isFile()).toBe(true);
    expect(fs.statSync(path.join(tmp, ".env")).isFile()).toBe(true);
    // The fixture registry has no GraphQL subgraph, so no supergraph config.
    expect(fs.existsSync(path.join(dotDir(tmp), "supergraph-config.yml"))).toBe(false);
    expect(fs.statSync(path.join(dotDir(tmp), "sandbox-context.md")).isFile()).toBe(true);
  });
});
