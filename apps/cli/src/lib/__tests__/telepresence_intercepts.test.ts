/**
 * Intercept-state reads for `sandbox status --intercepts`.
 *
 * The active-intercept fixture below is trimmed from a real
 * `telepresence list -i --format json` captured against the OrbStack cluster
 * (frontend intercepted by feature test-me). The live payload also carries an
 * `environment` block of the pod's env vars — deliberately NOT reproduced here,
 * since on a real cluster it can contain secrets.
 */
import { describe, expect, it } from "vitest";

import {
  interceptBlocker,
  listIntercepts,
  parseInterceptList,
  type Runner,
} from "../telepresence.js";

/** Shape of one intercepted deployment, trimmed to the fields we parse. */
const ACTIVE = JSON.stringify([
  {
    name: "frontend",
    namespace: "default",
    intercept_info: [
      {
        spec: {
          name: "frontend",
          agent: "frontend",
          workload_kind: "Deployment",
          namespace: "default",
          mechanism: "http",
          service_port: 8080,
          target_port: 11101,
          header_filters: { "x-feature": "test-me" },
        },
        id: "8c3b8989-29e2-4bfc-b18d-612e4a95fe75:frontend",
        pod_name: "frontend-74cb74bb6d-dnxxt",
        mechanism_args_desc: "HTTP requests with header 'X-Feature: test-me'",
      },
    ],
    workload_resource_type: "DEPLOYMENT",
    agent_version: "v2.30.1",
  },
]);

const FULL_SVC = {
  k8s_deployment: "frontend",
  k8s_namespace: "default",
  k8s_port: 8080,
  k8s_port_name: "http",
};

describe("parseInterceptList", () => {
  it("maps an intercepted deployment to the feature in its x-feature header filter", () => {
    const result = parseInterceptList(ACTIVE);
    expect(result.get("frontend")).toBe("test-me");
  });

  it("returns an empty map for the no-intercepts case", () => {
    // Verified live: `telepresence list -i --format json` prints exactly this.
    expect(parseInterceptList("[]").size).toBe(0);
  });

  it("matches the header filter case-insensitively", () => {
    const upper = ACTIVE.replace('"x-feature"', '"X-Feature"');
    expect(parseInterceptList(upper).get("frontend")).toBe("test-me");
  });

  it("records the deployment with a null feature when no x-feature filter is present", () => {
    const noFilter = ACTIVE.replace('{"x-feature": "test-me"}', "{}").replace(
      '{"x-feature":"test-me"}',
      "{}",
    );
    const result = parseInterceptList(noFilter);
    expect(result.has("frontend")).toBe(true);
    expect(result.get("frontend")).toBeNull();
  });

  it("ignores a deployment whose intercept_info is absent or empty", () => {
    const idle = JSON.stringify([{ name: "backend", namespace: "default", intercept_info: [] }]);
    expect(parseInterceptList(idle).size).toBe(0);
  });

  it("returns an empty map for malformed or empty output", () => {
    for (const junk of ["", "   ", "not json", "{}", "null"]) {
      expect(parseInterceptList(junk).size).toBe(0);
    }
  });
});

describe("interceptBlocker", () => {
  it("returns null for a fully specified service", () => {
    expect(interceptBlocker(FULL_SVC)).toBeNull();
  });

  it.each(["k8s_deployment", "k8s_namespace", "k8s_port"])(
    "names %s when it is missing",
    (key) => {
      const svc: Record<string, unknown> = { ...FULL_SVC };
      delete svc[key];
      expect(interceptBlocker(svc)).toContain(key);
    },
  );

  it("reports every missing coordinate at once", () => {
    const blocker = interceptBlocker({});
    expect(blocker).toContain("k8s_deployment");
    expect(blocker).toContain("k8s_namespace");
    expect(blocker).toContain("k8s_port");
  });

  it("requires k8s_port_name, citing the ambient-mesh precondition", () => {
    const svc: Record<string, unknown> = { ...FULL_SVC };
    delete svc.k8s_port_name;
    const blocker = interceptBlocker(svc);
    expect(blocker).toContain("k8s_port_name");
  });

  it("rejects a non-object service definition", () => {
    for (const bad of [null, undefined, "frontend", []]) {
      expect(interceptBlocker(bad)).toBeTruthy();
    }
  });
});

describe("listIntercepts", () => {
  it("returns the parsed map from `telepresence list -i`", () => {
    const runner: Runner = () => [0, ACTIVE];
    expect(listIntercepts(runner).intercepts.get("frontend")).toBe("test-me");
  });

  it("reports available when the command succeeds", () => {
    expect(listIntercepts(() => [0, "[]"]).available).toBe(true);
  });

  it("reports unavailable, not an error, when telepresence exits non-zero", () => {
    const result = listIntercepts(() => [127, "telepresence: command not found"]);
    expect(result.available).toBe(false);
    expect(result.intercepts.size).toBe(0);
  });

  it("asks telepresence for intercepts only, as json", () => {
    let seen: string[] = [];
    listIntercepts((cmd) => {
      seen = cmd;
      return [0, "[]"];
    });
    expect(seen).toContain("-i");
    expect(seen).toContain("--format");
    expect(seen).toContain("json");
  });
});
