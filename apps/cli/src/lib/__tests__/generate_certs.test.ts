/**
 * bin/generate-certs.sh drift detection (#105).
 *
 * The SANs and /etc/hosts entries must match the registry exactly. A service
 * removed from services.yaml used to leave its explicit SAN and its hosts
 * line behind, and `--check` still reported ok because it only looked for
 * missing hostnames. Runs the real script against a temp hosts file
 * (WERKMEISTER_HOSTS_FILE), which is user-writable so no step reaches for sudo.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execAsync } from "./helpers/exec_async.js";

const SCRIPT = path.resolve(__dirname, "../../../bin/generate-certs.sh");
// Each case runs openssl RSA keygen; ~1 s alone, up to ~47 s under full-suite load on a busy host (#178).
const CERT_TIMEOUT = { timeout: 60_000 };

let dir: string;
let hosts: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "certs-"));
  hosts = path.join(dir, "hosts");
  fs.writeFileSync(hosts, "127.0.0.1 localhost\n");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[], env: Record<string, string> = {}, certsDir = dir) {
  const domains = args.flatMap((a) => (a.startsWith("-") ? [a] : ["--domain", a]));
  const r = await execAsync("bash", [SCRIPT, "--certs-dir", certsDir, "--no-trust", ...domains], {
    env: { ...process.env, WERKMEISTER_INGRESS_HOSTS: "", WERKMEISTER_HOSTS_FILE: hosts, ...env },
  });
  return { rc: r.status, out: r.stdout + r.stderr };
}

describe("generate-certs.sh --check", CERT_TIMEOUT, () => {
  it("reports a SAN for a host the registry no longer routes", async () => {
    expect((await run(["keep.local.test", "gone.local.test"])).rc).toBe(0);

    const check = await run(["keep.local.test", "--check"]);

    expect(check.rc).toBe(1);
    expect(check.out).toContain("gone.local.test");
  });

  it("reports a hosts entry for a host the registry no longer routes", async () => {
    expect((await run(["keep.local.test"])).rc).toBe(0);
    // Bare lines, as versions before the managed block appended them.
    fs.writeFileSync(
      hosts,
      "127.0.0.1 localhost\n127.0.0.1 keep.local.test\n127.0.0.1 gone.local.test\n",
    );

    const check = await run(["keep.local.test", "--check"]);

    expect(check.rc).toBe(1);
    expect(check.out).toContain("gone.local.test");
  });

  it("passes once the registry, cert and hosts file agree", async () => {
    expect((await run(["keep.local.test"])).rc).toBe(0);

    expect((await run(["keep.local.test", "--check"])).rc).toBe(0);
  });
});

describe("generate-certs.sh hosts reconcile", CERT_TIMEOUT, () => {
  it("prunes removed services and leaves the user's own lines alone", async () => {
    fs.writeFileSync(
      hosts,
      [
        "127.0.0.1 localhost",
        "127.0.0.1 keep.local.test",
        "127.0.0.1 gone.local.test",
        "127.0.0.1 gone.local.test my.box.lan",
        "10.0.0.5 other.local.test",
        "",
      ].join("\n"),
    );

    expect((await run(["keep.local.test"])).rc).toBe(0);

    expect(fs.readFileSync(hosts, "utf8")).toBe(
      [
        "127.0.0.1 localhost",
        "127.0.0.1 gone.local.test my.box.lan",
        "10.0.0.5 other.local.test",
        "# BEGIN sandbox ingress",
        "127.0.0.1 keep.local.test",
        "# END sandbox ingress",
        "",
      ].join("\n"),
    );
  });
});

// SW-642: a fresh Ubuntu VM (LANG=en_US.UTF-8, locale not generated) reported a failure that
// passed under LC_ALL=C. Not reproduced on ubuntu:24.04; the script now pins C itself.
describe("generate-certs.sh under the caller's locale", CERT_TIMEOUT, () => {
  const hostsList = ["a-b.local.test", "ab.local.test", "A.local.test", "z.local.test"];

  it("generates, re-runs and checks with LANG=en_US.UTF-8 and LC_CTYPE=UTF-8", async () => {
    const env = { LANG: "en_US.UTF-8", LC_CTYPE: "UTF-8", LC_ALL: "" };
    expect((await run(hostsList, env)).rc).toBe(0);
    expect((await run(hostsList, env)).rc).toBe(0);
    expect((await run([...hostsList, "--check"], env)).rc).toBe(0);
  });

  it("names the line that failed, which setup's step does not show", async () => {
    const blocked = path.join(dir, "file");
    fs.writeFileSync(blocked, "");
    const r = await run(["keep.local.test"], {}, path.join(blocked, "certs"));
    expect(r.rc).not.toBe(0);
    expect(r.out).toMatch(/generate-certs\.sh: line \d+ failed \(exit \d+\): mkdir -p/);
  });
});
