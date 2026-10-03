/** The Claude pass's SDK options: isolated from every on-disk setting, plugin and MCP server. Never calls the SDK. */
import { describe, expect, it } from "vitest";

import { assistOptions } from "../assist_resolver.js";

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
