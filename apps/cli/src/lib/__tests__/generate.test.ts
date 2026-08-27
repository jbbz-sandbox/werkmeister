/**
 * the four HIGH-priority generators.
 *
 * SANDBOX_ROOT points at this repo so getInfraRoot finds the real templates,
 * while a throwaway ~/.sandbox (seeded from __tests__/fixtures) backs
 * loadServices/loadPorts — the registry moved out of the checkout, so the
 * developer's own must never be read here. compose/env/supergraph tests pass
 * workspaceOverride=tmp so nothing lands outside the temp dir. Caddyfile tests
 * redirect generate's getInfraRoot into tmp so the real infra/proxy/Caddyfile
 * is never mutated.
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
  isFeatureComposeStale,
  seedWorkspaceMetadataEnv,
} from "../generate.js";
import { loadFeatureRouters } from "../feature_routing.js";
import { loadServices } from "../config.js";
import { getPortRange } from "../slots.js";
import { fixtureServicesYaml, useSandboxHome, type SandboxHome } from "./helpers/sandbox_home.js";

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

function writeWorkspaceYml(workspace: string, mapping: string): void {
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
    writeWorkspaceYml(
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
    writeWorkspaceYml(tmp, "dev_links: {}\n");
    const withEmpty = fs.readFileSync(generateFeatureCompose("myfeat", 1, ["frontend"], null, tmp), "utf8");
    expect(withEmpty).toBe(baseline);
  });

  it("dev_link for another service does not leak", () => {
    writeWorkspaceYml(tmp, 'dev_links:\n  backend:\n    - "${WORKSPACE}/shared:/app/x"\n');
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

// ---- setup services --------------------------------------------------------
// `setup_services` was fully plumbed but never exercised: no entry has ever
// been non-empty, so the template's raw dereferences went unnoticed.

/** Fixture services.yaml with backend wired to a setup service. */
function withSetupService(entry: string): void {
  home.write(
    "services.yaml",
    fixtureServicesYaml()
      .replace("    setup_service: null\n", "    setup_service: demo-install\n")
      .replace("setup_services: {}", `setup_services:\n  demo-install:\n${entry}`),
  );
}

const MINIMAL_SETUP = `    repo: demo-services
    image: node:22-alpine
    command: "npm install"
`;

describe("setup services", () => {
  it("takes its image from config, like the app services do", () => {
    withSetupService(MINIMAL_SETUP);
    const content = fs.readFileSync(generateFeatureCompose("f", 1, ["backend"], null, tmp), "utf8");
    // A setup container installs deps the app container then loads, so the two
    // must agree on platform+libc — sharp resolves @img/sharp-linux-x64 vs
    // -linuxmusl-x64 at install time. The image was hardcoded to node:20.16.0
    // (glibc) while the demo apps run node:22-alpine (musl).
    expect(content).toContain("image: node:22-alpine");
    expect(content).not.toContain("node:20.16.0");
  });

  it("falls back to the previous hardcoded image when none is set", () => {
    withSetupService(`    repo: demo-services\n    command: "npm install"\n`);
    const content = fs.readFileSync(generateFeatureCompose("f", 1, ["backend"], null, tmp), "utf8");
    expect(content).toContain("image: node:20.16.0");
  });

  it("fills the fields the template dereferences unguarded", () => {
    withSetupService(MINIMAL_SETUP);
    const content = fs.readFileSync(generateFeatureCompose("f", 1, ["backend"], null, tmp), "utf8");
    // Rendering these empty yields `memory:` / `test: ["CMD-SHELL", ""]`, which
    // compose rejects — the whole file, not just the setup block.
    expect(content).toContain("memory: 2G");
    expect(content).toContain("memory: 512M");
    expect(content).not.toMatch(/^\s*memory:\s*$/m);
    expect(content).not.toContain('"CMD-SHELL", ""');
  });

  it("mounts startup.sh only when the config opts in", () => {
    withSetupService(MINIMAL_SETUP);
    const without = fs.readFileSync(generateFeatureCompose("f", 1, ["backend"], null, tmp), "utf8");
    // No `*-startup.sh` ships in infra/compose/scripts/; bind-mounting a host
    // path that does not exist makes Docker create an empty directory there.
    expect(without).not.toContain("startup.sh");

    withSetupService(MINIMAL_SETUP + "    startup_script: true\n");
    const withScript = fs.readFileSync(
      generateFeatureCompose("f", 1, ["backend"], null, tmp),
      "utf8",
    );
    expect(withScript).toContain("demo-install-startup.sh:/usr/local/bin/startup.sh");
  });

  it("blocks the app service until the setup container exits", () => {
    withSetupService(MINIMAL_SETUP);
    const content = fs.readFileSync(generateFeatureCompose("f", 1, ["backend"], null, tmp), "utf8");
    expect(content).toContain("demo-install:\n        condition: service_completed_successfully");
  });

  it("shares one node_modules volume across the setup container and every app", () => {
    // Both demo apps bind-mount the *same* repo at /app, so they share a single
    // volume rather than taking one each: two per-service volumes would be two
    // concurrent `npm install`s against one bind-mounted package-lock.json.
    home.write(
      "services.yaml",
      fixtureServicesYaml()
        .replaceAll("    setup_service: null\n", "    setup_service: demo-install\n")
        .replaceAll("    node_modules_volume: null\n", "    node_modules_volume: node-modules\n")
        .replace(
          "setup_services: {}",
          `setup_services:\n  demo-install:\n${MINIMAL_SETUP}    node_modules_volume: node-modules\n`,
        ),
    );
    const content = fs.readFileSync(
      generateFeatureCompose("f", 1, ["backend", "frontend"], null, tmp),
      "utf8",
    );
    // Declared once — a duplicate top-level key makes compose reject the file.
    expect(content.match(/^  f-node-modules:$/gm)).toHaveLength(1);
    // Mounted by the setup container and both apps.
    expect(content.match(/^ +- f-node-modules:\/app\/node_modules$/gm)).toHaveLength(3);
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

  // init-workspace writes .env twice: the metadata seed, then the generator.
  // The seed used to be a bare overwrite, so the generator's preservation pass
  // only ever saw what the seed had just written — hand-added keys were gone
  // one line earlier, in a different file.
  it("keeps hand-added keys across the seed + regeneration pair", () => {
    const envPath = path.join(tmp, ".env");
    fs.writeFileSync(envPath, "DATABASE_URL=postgres://local/app\n");
    seedWorkspaceMetadataEnv(envPath, { FEATURE: "myfeat", SERVICES: "backend" });
    const content = fs.readFileSync(generateFeatureEnv("myfeat", 1, ["backend"], null, tmp), "utf8");
    expect(content).toContain("DATABASE_URL=postgres://local/app");
    expect(content).toContain("FEATURE=myfeat");
    // One preserved block, one copy of each key — the seed's own header must
    // not survive into the generator's header as a second copy.
    expect(content.match(/Workspace metadata \(preserved across regeneration\)/g)).toHaveLength(1);
    expect(content.match(/^DATABASE_URL=/gm)).toHaveLength(1);
    expect(content.match(/^FEATURE=/gm)).toHaveLength(1);
  });

  it("seeding overwrites a stale metadata value rather than duplicating it", () => {
    const envPath = path.join(tmp, ".env");
    fs.writeFileSync(envPath, "FEATURE=old\nDATABASE_URL=postgres://local/app\n");
    seedWorkspaceMetadataEnv(envPath, { FEATURE: "new" });
    const content = fs.readFileSync(envPath, "utf8");
    expect(content).toContain("FEATURE=new");
    expect(content).not.toContain("FEATURE=old");
    expect(content).toContain("DATABASE_URL=postgres://local/app");
  });

  it("removes legacy docker-compose.env file", () => {
    const legacy = path.join(tmp, "docker-compose.env");
    fs.writeFileSync(legacy, "LEGACY=1\n");
    generateFeatureEnv("myfeat", 1, ["frontend"], null, tmp);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  // Both context values were plumbed to env.njk and never populated: `env_vars`
  // was a `{}` literal that nothing wrote to, and `secrets` was loaded, passed,
  // and never rendered. So the template's per-workspace section was structurally
  // always empty and there was no config surface for workspace env vars at all.
  it("renders env_vars from workspace.yml", () => {
    writeWorkspaceYml(tmp, "env_vars:\n  DATABASE_URL: postgres://k8s-postgres:9051/app\n  RETRIES: 3\n");
    const content = fs.readFileSync(generateFeatureEnv("myfeat", 1, ["backend"], null, tmp), "utf8");
    expect(content).toContain("DATABASE_URL=postgres://k8s-postgres:9051/app");
    expect(content).toContain("RETRIES=3");
  });

  it("env_vars is rendered after service URLs so it wins on a collision", () => {
    writeWorkspaceYml(tmp, "env_vars:\n  BACKEND_URL: http://pinned:9999\n");
    const content = fs.readFileSync(generateFeatureEnv("myfeat", 1, ["backend"], null, tmp), "utf8");
    expect(content.lastIndexOf("BACKEND_URL=http://pinned:9999")).toBeGreaterThan(
      content.indexOf("BACKEND_URL=http://backend:3000"),
    );
  });

  it("renders only the secrets the local services declare", () => {
    home.write("secrets.env", "DEMO_TOKEN=shhh\nOTHER_TEAMS_KEY=nope\n");
    const services = loadServices();
    services.backend.secrets = ["DEMO_TOKEN"];
    const content = fs.readFileSync(
      generateFeatureEnv("myfeat", 1, ["backend"], { services }, tmp),
      "utf8",
    );
    expect(content).toContain("DEMO_TOKEN=shhh");
    // The global secrets file is shared across every workspace; a key no local
    // service declares must not leak into this feature's .env.
    expect(content).not.toContain("OTHER_TEAMS_KEY");
  });

  it("renders no secrets when the local services declare none", () => {
    home.write("secrets.env", "DEMO_TOKEN=shhh\n");
    const content = fs.readFileSync(generateFeatureEnv("myfeat", 1, ["backend"], null, tmp), "utf8");
    expect(content).not.toContain("shhh");
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

  // The point of the sandbox is several workstreams at once. Before this, the
  // local host bound one winner (first by name) and the cookie was decoration,
  // so a second feature was unreachable and a dead one could hold the hostname.
  it("routes concurrent features on one hostname by cookie value", () => {
    const rc = loadFeatureRouters()["frontend"];
    const offset = loadServices()["frontend"]?.port_offset ?? 0;
    const content = fs.readFileSync(
      generateCaddyfile({
        alpha: { slot: 1, services: ["frontend"] },
        beta: { slot: 2, services: ["frontend"] },
      }),
      "utf8",
    );

    // Both features get their own matcher + upstream, so neither shadows the other.
    for (const [name, slot] of [["alpha", 1], ["beta", 2]] as [string, number][]) {
      const port = getPortRange(slot)[0] + offset;
      expect(content).toContain(`X-Feature=${name}(?:\\s*;|\\s*$)`);
      expect(content).toContain(`reverse_proxy host.docker.internal:${port}`);
      expect(content).toContain(`header_up X-Feature ${name}`);
    }

    // Unmatched/absent cookie prefers the always-live remote face over guessing
    // a local feature — that guess is what let a torn-down workspace 502 the host.
    expect(content).toContain(`reverse_proxy ${rc!.remoteUpstream}`);
  });

  it("anchors the cookie matcher so one feature can't match another's prefix", () => {
    // A bare `X-Feature=web` substring also matches `X-Feature=web-v2`, which
    // would route one workspace's traffic into another's containers.
    const content = fs.readFileSync(
      generateCaddyfile({
        web: { slot: 1, services: ["frontend"] },
        "web-v2": { slot: 2, services: ["frontend"] },
      }),
      "utf8",
    );
    expect(content).toContain("(?:^|;\\s*)X-Feature=web(?:\\s*;|\\s*$)");
    expect(content).toContain("(?:^|;\\s*)X-Feature=web-v2(?:\\s*;|\\s*$)");
    // Distinct matcher names, so the two handles don't collapse into one.
    expect(content).toMatch(/@feat0_web\b/);
    expect(content).toMatch(/@feat1_web_v2\b/);
  });
});

// ---- compose staleness -----------------------------------------------------
// `sandbox up` only reads the compose file, so a registry edit made after
// init-workspace ran was invisible until a container failed on config that no
// longer existed — a feature booted with a deleted install probe and no setup
// container, and the error named neither.

describe("compose staleness", () => {
  it("is not stale immediately after generation", () => {
    generateFeatureCompose("f", 1, ["backend"], null, tmp);
    expect(isFeatureComposeStale("f", 1, ["backend"], null, tmp)).toBe(false);
  });

  it("ignores the command name recorded in the header", () => {
    generateFeatureCompose("f", 1, ["backend"], null, tmp, "sandbox init-workspace");
    expect(isFeatureComposeStale("f", 1, ["backend"], null, tmp)).toBe(false);
  });

  it("is stale once the registry changes under it", () => {
    generateFeatureCompose("f", 1, ["backend"], null, tmp);
    home.write("services.yaml", fixtureServicesYaml().replace("memory_limit: 256M", "memory_limit: 512M"));
    expect(isFeatureComposeStale("f", 1, ["backend"], null, tmp)).toBe(true);
  });

  it("reports a missing compose as not stale, leaving that error to the caller", () => {
    // `up` already fails with its own 'run init-workspace first' message.
    expect(isFeatureComposeStale("f", 1, ["backend"], null, tmp)).toBe(false);
  });
});
