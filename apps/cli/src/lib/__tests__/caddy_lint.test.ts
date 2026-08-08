/**
 * Structural lint of Caddyfile text.
 *
 * lintCaddyfileStructure() is pure text in, findings out — no config or proc
 * mocking needed, so the route-drop signatures are testable as fixtures.
 */
import { describe, expect, it } from "vitest";

import { lintCaddyfileStructure } from "../caddy.js";

/** A bare `handle {` next to a path-scoped sibling — the route-drop shape. */
const BARE_PLUS_SCOPED = `sandbox.local {
	handle /api/* {
		reverse_proxy backend:3000
	}
	handle {
		reverse_proxy frontend:5173
	}
}
`;

/** Identical, but the proxy carries a Caddy placeholder: `{re.xf.1}`. */
const WITH_PLACEHOLDER = `sandbox.local {
	handle /api/* {
		reverse_proxy backend:3000 {
			header_up X-Feature {re.xf.1}
		}
	}
	handle {
		reverse_proxy frontend:5173
	}
}
`;

describe("lintCaddyfileStructure — bare-vs-scoped handle guard", () => {
  it("flags a bare handle coexisting with a path-scoped sibling", () => {
    const findings = lintCaddyfileStructure(BARE_PLUS_SCOPED);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("sandbox.local");
    expect(findings[0]).toContain("bare unscoped 'handle {'");
  });

  // The depth counter treated every line ending in `}` as a block close, so a
  // Caddy placeholder (`{re.xf.1}`) decremented depth mid-block. That split the
  // sibling handle group across two depths and the guard silently stopped
  // firing — on a file with the exact defect it exists to catch.
  it("still flags it when a Caddy placeholder appears inside the block", () => {
    const findings = lintCaddyfileStructure(WITH_PLACEHOLDER);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("bare unscoped 'handle {'");
  });

  it("stays quiet when every sibling handle is path-scoped", () => {
    const findings = lintCaddyfileStructure(`sandbox.local {
	handle /api/* {
		reverse_proxy backend:3000 {
			header_up X-Feature {re.xf.1}
		}
	}
	handle /* {
		reverse_proxy frontend:5173
	}
}
`);
    expect(findings).toEqual([]);
  });

  it("flags two scoped siblings sharing one matcher", () => {
    const findings = lintCaddyfileStructure(`sandbox.local {
	handle /api/* {
		reverse_proxy backend:3000 {
			header_up X-Feature {re.xf.1}
		}
	}
	handle /api/* {
		reverse_proxy other:3000
	}
}
`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("duplicate 'handle /api/*'");
  });
});
