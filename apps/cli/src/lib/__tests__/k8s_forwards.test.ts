/**
 * Forward-table generation for `infrastructure:` entries.
 *
 * buildForwardRows() takes services + infrastructure as explicit args, so the
 * generation logic is testable with fixtures — no config/proc mocking needed.
 */
import { describe, expect, it } from "vitest";

import { buildForwardRows } from "../k8s_forwards.js";

describe("buildForwardRows — infrastructure forwards", () => {
  it("emits a pipe-delimited row per infra entry that declares k8s_forward_port", () => {
    const infra = {
      redis: { k8s_forward_port: 9050, internal_port: 6379, k8s_namespace: "default", k8s_pod_prefix: "redis", health_endpoint: "" },
      postgres: { k8s_forward_port: 9051, internal_port: 5432, k8s_namespace: "default", k8s_pod_prefix: "postgres", health_endpoint: "" },
    };
    const rows = buildForwardRows({}, infra);
    // name|listen|remote|namespace|pod_prefix|health
    expect(rows).toEqual([
      "redis|9050|6379|default|redis|",
      "postgres|9051|5432|default|postgres|",
    ]);
  });

  it("skips infra entries without k8s_forward_port", () => {
    const infra = {
      redis: { k8s_forward_port: 9050, internal_port: 6379, k8s_namespace: "default", k8s_pod_prefix: "redis", health_endpoint: "" },
      search: { note: "external, not forwarded" },
    };
    const rows = buildForwardRows({}, infra);
    expect(rows).toEqual(["redis|9050|6379|default|redis|"]);
  });

  it("returns no rows when there is no forwarded infrastructure", () => {
    expect(buildForwardRows({}, {})).toEqual([]);
  });

  it("forwards services to their pod containerPort (internal_port), not the Service port", () => {
    const services = {
      "rest-hello": {
        k8s_forward_port: 9052, internal_port: 3000, k8s_port: 80,
        k8s_namespace: "default", k8s_pod_prefix: "rest-hello", health_endpoint: "/health",
      },
      "next-hello": {
        k8s_forward_port: 9053, internal_port: 3000, k8s_port: 8080,
        k8s_namespace: "default", k8s_pod_prefix: "next-hello", health_endpoint: "/",
      },
    };
    expect(buildForwardRows(services, {})).toEqual([
      "rest-hello|9052|3000|default|rest-hello|/health",
      "next-hello|9053|3000|default|next-hello|/",
    ]);
  });
});
