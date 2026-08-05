/**
 * the four HIGH-priority generators.
 *
 * SANDBOX_ROOT points at this repo so getInfraRoot finds the real templates,
 * while a throwaway ~/.sandbox (seeded from __tests__/fixtures) backs
 * loadServices/loadPorts — the registry moved out of the checkout, so the
 * developer's own must never be read here. compose/env/supergraph tests pass
 * workspaceOverride=tmp so nothing lands outside the temp dir. Caddyfile tests
 * redirect generate's getInfraRoot into tmp (Python monkeypatches the same
 * reference) so the real infra/proxy/Caddyfile is never mutated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({ infraRoot: null as string | null }));

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  // Only generate.ts's imported getInfraRoot is redirected; config.ts's own
  // loadServices/loadPorts keep using their internal (real) getInfraRoot.
  return { ...actual, getInfraRoot: () => h.infraRoot ?? actual.getInfraRoot() };
});

import {
  generateCaddyfile,
  generateFeatureCompose,
  generateFeatureEnv,
  generateSupergraphConfig,
} from "../generate.js";
import { loadFeatureRouters } from "../feature_routing.js";
import { loadServices } from "../config.js";
import { getPortRange } from "../slots.js";
import { useSandboxHome, type SandboxHome } from "./helpers/sandbox_home.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let tmp: string;
let home: SandboxHome;

beforeEach(() => {
  process.env.SANDBOX_ROOT = repoRoot;
  home = useSandboxHome();
  h.infraRoot = null;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gen-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  home.cleanup();
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeDevLinks(workspace: string, mapping: string): void {
  const sandbox = path.join(workspace, ".sandbox");
  fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "workspace.yml"), mapping);
}

// ---- worktree gitdir resolution (exercised via generateFeatureCompose) -----
// _resolveWorktreeGitdir is private in the TS port; its observable effect (a
// worktree admin dir bind-mounted into the container) is covered below.

describe("worktree gitdir mounting", () => {
  it("mounts a linked worktree's admin dir", () => {
    const admin = path.join(tmp, "mainrepo", ".git", "worktrees", "wt");
    fs.mkdirSync(admin, { recursive: true });
    // backend's repo is `demo-services`; the checkout is {workspace}/demo-services.
    const repoDir = path.join(tmp, "demo-services");
    fs.mkdirSync(repoDir);
    fs.writeFileSync(path.join(repoDir, ".git"), `gitdir: ${admin}\n`);
    const outPath = generateFeatureCompose("myfeat", 1, ["backend"], null, tmp);
    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain(`- ${admin}:${admin}:ro`);
  });
});

// ---- dev_links -------------------------------------------------------------

describe("dev_links", () => {
  it("emits a dev link with ${WORKSPACE} resolved", () => {
    writeDevLinks(
      tmp,
      "dev_links:\n  frontend:\n" +
        '    - "${WORKSPACE}/shared/packages/core:/app/node_modules/@sandbox/core"\n',
    );
    const content = fs.readFileSync(generateFeatureCompose("myfeat", 1, ["frontend"], null, tmp), "utf8");
    expect(content).toContain(`- ${tmp}/shared/packages/core:/app/node_modules/@sandbox/core`);
    expect(content).not.toContain("${WORKSPACE}");
  });

  it("empty dev_links is byte-identical to none", () => {
    const baseline = fs.readFileSync(generateFeatureCompose("myfeat", 1, ["frontend"], null, tmp), "utf8");
    writeDevLinks(tmp, "dev_links: {}\n");
    const withEmpty = fs.readFileSync(generateFeatureCompose("myfeat", 1, ["frontend"], null, tmp), "utf8");
    expect(withEmpty).toBe(baseline);
  });

  it("dev_link for another service does not leak", () => {
    writeDevLinks(tmp, 'dev_links:\n  backend:\n    - "${WORKSPACE}/shared:/app/x"\n');
    const content = fs.readFileSync(generateFeatureCompose("myfeat", 1, ["frontend"], null, tmp), "utf8");
    expect(content).not.toContain("/app/x");
  });
});

// ---- generateFeatureCompose / generateFeatureEnv ---------------------------

describe("generateFeatureCompose", () => {
  it("writes header and service block", () => {
    const outPath = generateFeatureCompose("myfeat", 1, ["frontend"], null, tmp);
    expect(outPath).toBe(path.join(tmp, "docker-compose.yml"));
    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("# Sandbox docker-compose for feature: myfeat");
    expect(content).toContain("frontend:");
  });

  it("empty local services still writes a valid file", () => {
    const content = fs.readFileSync(generateFeatureCompose("myfeat", 1, [], null, tmp), "utf8");
    expect(content.startsWith("# Sandbox docker-compose for feature: myfeat")).toBe(true);
    expect(content).not.toContain("backend:");
    expect(content).not.toContain("frontend:");
  });

});

describe("generateFeatureEnv", () => {
  it("writes feature, slot, and a local service DNS URL", () => {
    // Demo services have no k8s forward, so a local service is reached over the
    // feature network by its Docker DNS alias (http://<svc>:<port>).
    const outPath = generateFeatureEnv("myfeat", 1, ["backend"], null, tmp);
    expect(outPath).toBe(path.join(tmp, ".env"));
    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("SANDBOX_FEATURE=myfeat");
    expect(content).toContain("SANDBOX_SLOT=1");
    expect(content).toContain("http://backend:3000");
  });

  it("preserves workspace metadata across regeneration", () => {
    fs.writeFileSync(path.join(tmp, ".env"), "FEATURE=x\n");
    const content = fs.readFileSync(generateFeatureEnv("myfeat", 1, ["frontend"], null, tmp), "utf8");
    expect(content).toContain("Workspace metadata (preserved across regeneration)");
    expect(content).toContain("FEATURE=x");
  });

  it("removes legacy docker-compose.env file", () => {
    const legacy = path.join(tmp, "docker-compose.env");
    fs.writeFileSync(legacy, "LEGACY=1\n");
    generateFeatureEnv("myfeat", 1, ["frontend"], null, tmp);
    expect(fs.existsSync(legacy)).toBe(false);
  });
});

// ---- generateSupergraphConfig ----------------------------------------------

describe("generateSupergraphConfig", () => {
  // The demo config has no `graphql-subgraph` services, so the generator writes
  // a valid file with an empty subgraph set and no service URLs. (The k8s /
  // federation resolution branches are still in generate.ts, just unexercised
  // by this playground's two self-contained apps.)
  it("writes an empty supergraph config when there are no subgraphs", () => {
    const outPath = generateSupergraphConfig("myfeat", 1, [], null, tmp);
    expect(outPath).toBe(path.join(tmp, ".sandbox", "supergraph-config.yml"));
    const content = fs.readFileSync(outPath, "utf8");
    expect(content).toContain("subgraphs");
    expect(content).not.toContain("k8s-forwards:");
    expect(content).not.toContain("http://");
  });
});

// ---- generateCaddyfile (getInfraRoot redirected into tmp) ------------------

describe("generateCaddyfile", () => {
  beforeEach(() => {
    h.infraRoot = tmp;
  });

  it("writes Caddyfile and features.json", () => {
    const outPath = generateCaddyfile({ myfeat: { slot: 1, services: ["frontend"] } });
    expect(outPath).toBe(path.join(tmp, "proxy", "Caddyfile"));
    expect(fs.statSync(outPath).isFile()).toBe(true);

    const featuresJsonPath = path.join(tmp, "proxy", "ui", "features.json");
    expect(fs.statSync(featuresJsonPath).isFile()).toBe(true);
    const features = JSON.parse(fs.readFileSync(featuresJsonPath, "utf8"));
    expect(features).toEqual([{ name: "myfeat", slot: 1, services: ["frontend"] }]);
  });

  it("no running feature -> local host falls back to the remote upstream", () => {
    // With no feature running, the local hostname block still renders but
    // proxies to remote_upstream (the cluster Service) instead of a container.
    const content = fs.readFileSync(generateCaddyfile({}), "utf8");
    expect(content).toContain("admin localhost:2019");
    const rc = loadFeatureRouters()["frontend"];
    expect(rc?.hostname).toBeTruthy();
    expect(rc?.remoteUpstream).toBeTruthy();
    expect(content).toContain(`${rc!.hostname} {`);
    // Nothing local is running, so no host.docker.internal upstream anywhere.
    expect(content).not.toContain("host.docker.internal:");
    expect(content).toContain(`reverse_proxy ${rc!.remoteUpstream}`);
  });

  it("remote (K8s) router is static — emitted with no running features", () => {
    const rc = loadFeatureRouters()["frontend"];
    expect(rc?.remoteHostname).toBeTruthy();
    expect(rc?.remoteUpstream).toBeTruthy();
    const content = fs.readFileSync(generateCaddyfile({}), "utf8");
    // Terminates the remote host and proxies to the cluster Service upstream...
    expect(content).toContain(`${rc!.remoteHostname} {`);
    expect(content).toContain(`reverse_proxy ${rc!.remoteUpstream}`);
    // ...still converting the X-Feature cookie to a header on that upstream.
    expect(content).toContain("header_up X-Feature {re.xf.1}");
  });

  it("terminates the hostname and routes to the running feature's container", () => {
    const content = fs.readFileSync(
      generateCaddyfile({ myfeat: { slot: 1, services: ["frontend"] } }),
      "utf8",
    );
    const [base] = getPortRange(1);
    const offset = loadServices()["frontend"]?.port_offset ?? 0;
    const hostname = loadFeatureRouters()["frontend"]?.hostname;
    expect(content).toContain(`${hostname} {`);
    expect(content).toContain(`host.docker.internal:${base + offset}`);
  });

  it("converts the X-Feature cookie to an X-Feature header", () => {
    const content = fs.readFileSync(
      generateCaddyfile({ myfeat: { slot: 1, services: ["frontend"] } }),
      "utf8",
    );
    // Cookie matcher captures the value; header_up copies it to the upstream.
    expect(content).toContain("header_regexp xf Cookie X-Feature=([^;]+)");
    expect(content).toContain("header_up X-Feature {re.xf.1}");
  });

  it("emits one site block per routed service that has a running feature", () => {
    const svcCfg = loadServices();
    const routers = loadFeatureRouters();
    const services = Object.keys(routers);
    const content = fs.readFileSync(
      generateCaddyfile({ allsvc: { slot: 1, services } }),
      "utf8",
    );
    const [base] = getPortRange(1);

    for (const [svc, rc] of Object.entries(routers)) {
      if (!rc.hostname) {
        continue;
      }
      expect(content, `missing site block for ${svc}`).toContain(`${rc.hostname} {`);
      const offset = svcCfg[svc]?.port_offset ?? 0;
      expect(content, `missing upstream for ${svc}`).toContain(
        `host.docker.internal:${base + offset}`,
      );
    }

    const hostnames = Object.values(routers).map((rc) => rc.hostname).filter(Boolean);
    expect(new Set(hostnames).size).toBe(hostnames.length);
  });
});
