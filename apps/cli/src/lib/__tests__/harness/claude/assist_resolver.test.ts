/** The Claude pass's SDK options: isolated from every on-disk setting, plugin and MCP server. Never calls the SDK. */
import { describe, expect, it } from "vitest";

import {
  assistOptions,
  SdkMissingError,
  sdkLoadError,
} from "../../../harness/claude/assist_resolver.js";

const notInstalled = Object.assign(new Error("Cannot find package"), {
  code: "ERR_MODULE_NOT_FOUND",
});

describe("sdkLoadError", () => {
  it("turns a missing SDK into an SdkMissingError with the install command", () => {
    const err = sdkLoadError(notInstalled);
    expect(err).toBeInstanceOf(SdkMissingError);
    expect((err as Error).message).toContain("npm install -g @anthropic-ai/claude-agent-sdk");
  });

  it("lets any other load failure through untouched", () => {
    const broken = new Error("SyntaxError in sdk");
    expect(sdkLoadError(broken)).toBe(broken);
  });
});

describe("assistOptions", () => {
  const o = assistOptions("/repos/shop");

  it("loads no settings, plugins or MCP servers from disk", () => {
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toBeUndefined();
    expect(o.plugins).toEqual([]);
  });

  it("is read-only, scoped to the repo, on the pinned model", () => {
    expect(o.cwd).toBe("/repos/shop");
    expect(o.model).toBe("claude-opus-5-5");
    expect(o.tools).toEqual(["Read", "Glob", "Grep"]);
    expect(o.allowedTools).toEqual(["Read(./**)"]);
    expect(o.permissionMode).toBe("dontAsk");
  });
});
