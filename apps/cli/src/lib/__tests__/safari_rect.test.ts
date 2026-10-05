/** `parseRect` — WebDriver window/rect from `--window-size`/`--window-position`. */
import { describe, expect, it } from "vitest";

import { parseRect } from "sandbox-core/safari";

describe("parseRect", () => {
  it("parses size and position into a WebDriver rect", () => {
    expect(parseRect("1440,900", "100,200")).toEqual({ width: 1440, height: 900, x: 100, y: 200 });
  });

  it("defaults position when none is given", () => {
    expect(parseRect("1440,900", null)).toEqual({ width: 1440, height: 900, x: 60, y: 60 });
  });
});
