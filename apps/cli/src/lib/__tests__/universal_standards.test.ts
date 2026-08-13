/**
 * The universal base is declared by the modules (`universal: <n>` frontmatter),
 * not by a list in the loader — which standards are always-on is an org's
 * content, and this loader ships to orgs whose base is not ours.
 *
 * The number carries load order. That ordering is deliberate (base rubric
 * before the constraints built on it) and used to live in a tuple whose own
 * comment warned that alphabetical agreement was coincidence — so the tests
 * below deliberately pick names where the two disagree.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildStandardsManifest,
  resolveActiveStandards,
  universalStandards,
  validateStandardModules,
} from "../standards.js";

/** `zebra` sorts after `alpha` alphabetically but is declared to load first. */
const MODULES = {
  zebra: { universal: 1, applies_to: ["**/*"], summary: "Base rubric" },
  alpha: { universal: 2, applies_to: ["**/*"], summary: "Built on the base" },
  widgets: { applies_to: ["**/*.widget.ts"], summary: "Widget rules" },
};

describe("universalStandards", () => {
  it("orders by the declared number, not alphabetically", () => {
    expect(universalStandards(MODULES)).toEqual(["zebra", "alpha"]);
  });

  it("excludes modules that don't declare it", () => {
    expect(universalStandards(MODULES)).not.toContain("widgets");
  });

  it("is empty for a tree that declares no base at all", () => {
    expect(universalStandards({ widgets: MODULES.widgets })).toEqual([]);
  });
});

describe("resolveActiveStandards", () => {
  it("puts the universal base first, in declared order, ahead of domains", () => {
    const [active] = resolveActiveStandards(
      [],
      { svc: { standards: ["widgets"] } },
      {},
      null,
      MODULES,
      ["svc"],
      {},
    );
    expect(active).toEqual(["zebra", "alpha", "widgets"]);
  });
});

describe("buildStandardsManifest", () => {
  it("splits the universal keys out of the gated domains", () => {
    const manifest = buildStandardsManifest(["zebra", "alpha", "widgets"], MODULES);
    expect(manifest["universal"]).toEqual(["zebra", "alpha"]);
    expect(Object.keys(manifest["domains"])).toEqual(["widgets"]);
  });
});

describe("validateStandardModules", () => {
  it("rejects `universal: true` — it reads as universal but silently is not", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uni-std-"));
    try {
      fs.writeFileSync(
        path.join(dir, "widgets.md"),
        '---\ndomain: widgets\nuniversal: true\nsummary: W\napplies_to: ["**/*"]\n---\n',
      );
      expect(validateStandardModules(dir).join("\n")).toMatch(/`universal:`.*must be an integer/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
