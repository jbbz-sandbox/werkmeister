/**
 * SW-954: setup services, services and sidecars render `extra_volumes` through one template macro,
 * so a fix to one kind of mount reaches all three. The setup copy had drifted: it left `${WORKSPACE}`
 * unresolved.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateFeatureCompose } from "werkmeister-core/generate";
import * as YAML from "yaml";
import { fixtureServicesYaml, type SandboxHome, useSandboxHome } from "./helpers/sandbox_home.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
let home: SandboxHome;
let ws: string;

beforeEach(() => {
  process.env.WERKMEISTER_ROOT = repoRoot;
  home = useSandboxHome();
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "compose-volumes-"));
  fs.mkdirSync(path.join(ws, "demo-services"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  home.cleanup();
  fs.rmSync(ws, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it("renders one volume list the same for a setup service, a service and a sidecar", () => {
  const vols = ["${WORKSPACE}/w:/w", "${REPO}/r:/r:ro", "^shared:/s", "cache:/c"];
  const doc = YAML.parse(fixtureServicesYaml());
  doc.services.backend.setup_service = "demo-install";
  doc.services.backend.extra_volumes = vols;
  // The sidecar names its own volume: a name it shared would be one data dir (SW-955).
  const dbVols = [...vols.slice(0, 3), "db-data:/c"];
  doc.services.backend.extra_services = { db: { image: "postgres:16", extra_volumes: dbVols } };
  doc.setup_services = { "demo-install": { repo: "demo-services", extra_volumes: vols } };
  home.write("services.yaml", YAML.stringify(doc));
  const compose = YAML.parse(
    fs.readFileSync(generateFeatureCompose("f", 1, ["backend"], null, ws), "utf8"),
  );
  const expected = [`${ws}/w:/w`, `${ws}/demo-services/r:/r:ro`, "shared:/s", "f-cache:/c"];
  expect(compose.services.db.volumes).toEqual([...expected.slice(0, 3), "f-db-data:/c"]);
  expect(compose.services["demo-install"].volumes).toEqual(expect.arrayContaining(expected));
  expect(compose.services.backend.volumes).toEqual(expect.arrayContaining(expected));
  expect(compose.volumes).toEqual({
    "f-cache": { name: "f-cache" },
    "f-db-data": { name: "f-db-data" },
    shared: { name: "shared", external: true },
  });
});
