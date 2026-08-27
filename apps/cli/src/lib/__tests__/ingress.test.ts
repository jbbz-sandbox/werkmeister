/**
 * Ingress hostname derivation — the single list behind the Caddy site blocks,
 * the certificate SANs and /etc/hosts.
 *
 * The invariant worth protecting: a service that declares `feature_router:`
 * gets a hostname whether or not it spells one out, and an explicit hostname
 * always wins. Before this, every host was restated per service AND in
 * bin/generate-certs.sh, so the two could disagree silently.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ingressHostnames, loadFeatureRouters } from "sandbox-core/feature_routing";
import { INGRESS_DEFAULTS, loadIngress } from "sandbox-core/global_config";
import { useSandboxHome, type SandboxHome } from "./helpers/sandbox_home.js";

let home: SandboxHome;

const CUSTOM_DOMAINS = {
  version: 1,
  ingress: { local_domain: "local.example.test", remote_domain: "remote.example.test" },
};

beforeEach(() => {
  home = useSandboxHome({ fixtures: [] });
});
afterEach(() => {
  home.cleanup();
});

describe("loadIngress", () => {
  it("falls back to the built-in domains when no config exists", () => {
    expect(loadIngress()).toEqual(INGRESS_DEFAULTS);
  });

  it("fills in only the keys the config omits", () => {
    home.writeConfig({ version: 1, ingress: { local_domain: "dev.internal" } });
    const ingress = loadIngress();
    expect(ingress.local_domain).toBe("dev.internal");
    expect(ingress.remote_domain).toBe(INGRESS_DEFAULTS.remote_domain);
  });

  it("expands a `~` in certs_dir so docker compose gets a real path", () => {
    home.writeConfig({ version: 1, ingress: { certs_dir: "~/certs" } });
    expect(loadIngress().certs_dir).not.toContain("~");
    expect(loadIngress().certs_dir.endsWith("/certs")).toBe(true);
  });
});

describe("loadFeatureRouters", () => {
  it("derives both hostnames from the configured base domains", () => {
    home.writeConfig(CUSTOM_DOMAINS);
    home.write(
      "services.yaml",
      "services:\n" +
        "  web:\n" +
        "    feature_router:\n" +
        "      remote_upstream: web.default.svc.cluster.local:8080\n",
    );
    expect(loadFeatureRouters().web).toMatchObject({
      hostname: "web.local.example.test",
      remoteHostname: "web.remote.example.test",
      remoteUpstream: "web.default.svc.cluster.local:8080",
    });
  });

  it("lets an explicit hostname override the derived one", () => {
    home.writeConfig(CUSTOM_DOMAINS);
    home.write(
      "services.yaml",
      "services:\n" +
        "  web:\n" +
        "    feature_router:\n" +
        "      hostname: vanity.elsewhere.test\n",
    );
    expect(loadFeatureRouters().web.hostname).toBe("vanity.elsewhere.test");
  });

  it("omits the remote host for a service with no cluster upstream", () => {
    home.writeConfig(CUSTOM_DOMAINS);
    home.write("services.yaml", "services:\n  web:\n    feature_router: {}\n");
    const web = loadFeatureRouters().web;
    expect(web.hostname).toBe("web.local.example.test");
    // No remote_upstream -> a remote hostname would resolve to nothing.
    expect(web.remoteHostname).toBeUndefined();
  });

  it("ignores services that never opt into routing", () => {
    home.write("services.yaml", "services:\n  worker:\n    internal_port: 3000\n");
    expect(loadFeatureRouters()).toEqual({});
  });
});

describe("ingressHostnames", () => {
  it("returns every routed host, sorted and deduped", () => {
    home.writeConfig(CUSTOM_DOMAINS);
    home.write(
      "services.yaml",
      "services:\n" +
        "  web:\n" +
        "    feature_router:\n" +
        "      remote_upstream: web:8080\n" +
        "  api:\n" +
        "    feature_router: {}\n",
    );
    expect(ingressHostnames()).toEqual([
      "api.local.example.test",
      "web.local.example.test",
      "web.remote.example.test",
    ]);
  });

  it("is empty when nothing is routed — a machine with no ingress needs no cert", () => {
    home.write("services.yaml", "services:\n  worker:\n    internal_port: 3000\n");
    expect(ingressHostnames()).toEqual([]);
  });
});
