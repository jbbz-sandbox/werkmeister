/**
 * bin/generate-certs.sh drift detection (#105).
 *
 * The SANs and /etc/hosts entries must match the registry exactly. A service
 * removed from services.yaml used to leave its explicit SAN and its hosts
 * line behind, and `--check` still reported ok because it only looked for
 * missing hostnames. Runs the real script against a temp hosts file
 * (WERKMEISTER_HOSTS_FILE), which is user-writable so no step reaches for sudo.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

function run(args: string[]) {
  const domains = args.flatMap((a) => (a.startsWith("-") ? [a] : ["--domain", a]));
  const r = spawnSync("bash", [SCRIPT, "--certs-dir", dir, "--no-trust", ...domains], {
    encoding: "utf8",
    env: { ...process.env, WERKMEISTER_INGRESS_HOSTS: "", WERKMEISTER_HOSTS_FILE: hosts },
  });
  return { rc: r.status, out: r.stdout + r.stderr };
}

describe("generate-certs.sh --check", CERT_TIMEOUT, () => {
  it("reports a SAN for a host the registry no longer routes", () => {
    expect(run(["keep.local.test", "gone.local.test"]).rc).toBe(0);

    const check = run(["keep.local.test", "--check"]);

    expect(check.rc).toBe(1);
    expect(check.out).toContain("gone.local.test");
  });

  it("reports a hosts entry for a host the registry no longer routes", () => {
    expect(run(["keep.local.test"]).rc).toBe(0);
    // Bare lines, as versions before the managed block appended them.
    fs.writeFileSync(
      hosts,
      "127.0.0.1 localhost\n127.0.0.1 keep.local.test\n127.0.0.1 gone.local.test\n",
    );

    const check = run(["keep.local.test", "--check"]);

    expect(check.rc).toBe(1);
    expect(check.out).toContain("gone.local.test");
  });

  it("passes once the registry, cert and hosts file agree", () => {
    expect(run(["keep.local.test"]).rc).toBe(0);

    expect(run(["keep.local.test", "--check"]).rc).toBe(0);
  });
});

describe("generate-certs.sh hosts reconcile", CERT_TIMEOUT, () => {
  it("prunes removed services and leaves the user's own lines alone", () => {
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

    expect(run(["keep.local.test"]).rc).toBe(0);

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
