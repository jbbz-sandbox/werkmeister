import assert from "node:assert/strict";
import { test } from "node:test";
import { sdkExports } from "../typedoc-sdk-links.mjs";

const sdk = { getChildByName: (n) => (n === "SandboxError" ? {} : undefined) };
const ref = (...names) => ({ symbolReference: { path: names.map((path) => ({ path })) } });

test("sdkExports resolves a bare name the SDK exports", () => {
  assert.equal(sdkExports(ref("SandboxError"), sdk), true);
});

test("sdkExports leaves an unknown name, a member path or a module-qualified name to fail", () => {
  assert.equal(sdkExports(ref("NoSuch"), sdk), false);
  assert.equal(sdkExports(ref("SandboxError", "code"), sdk), false);
  assert.equal(sdkExports({ ...ref("SandboxError"), moduleSource: "errors" }, sdk), false);
  assert.equal(sdkExports(ref("SandboxError"), undefined), false);
});
