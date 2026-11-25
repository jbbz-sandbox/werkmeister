// SW-584: the werkmeister GitHub App's installation token. Config and key come from a temp HOME; GitHub is a fake fetch.

import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { appInstallationToken, githubAppConfig, refuseAppToken } from "../dist/github_app.js";
import { withSandboxHome } from "./fixtures.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });
const CONFIG = { appId: "4242", privateKey: PEM };
const HOUR = 3600_000;

/** A fake GitHub: records each call and answers the two endpoints. */
function github({
  installation = 200,
  expiresAt = new Date(Date.now() + HOUR).toISOString(),
} = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      auth: init.headers?.Authorization,
      signal: init.signal,
    });
    if (url.endsWith("/installation"))
      return { ok: installation === 200, status: installation, json: async () => ({ id: 77 }) };
    return {
      ok: true,
      status: 201,
      json: async () => ({ token: "ghs_minted", expires_at: expiresAt }),
    };
  };
  return { fetch, calls };
}

test("mints with a JWT the App's public key verifies, from the repo's installation", async () => {
  const gh = github();
  const token = await appInstallationToken("acme/api", { config: CONFIG, fetch: gh.fetch });
  assert.equal(token, "ghs_minted");
  assert.deepEqual(
    gh.calls.map((c) => `${c.method} ${c.url}`),
    [
      "GET https://api.github.com/repos/acme/api/installation",
      "POST https://api.github.com/app/installations/77/access_tokens",
    ],
  );
  const [head, body, sig] = gh.calls[0].auth.replace(/^Bearer /, "").split(".");
  assert.ok(
    verify("RSA-SHA256", Buffer.from(`${head}.${body}`), publicKey, Buffer.from(sig, "base64url")),
  );
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(claims.iss, "4242");
  assert.ok(claims.exp - claims.iat <= 600, "GitHub refuses a JWT that lives over 10 min");
});

test("reuses the owner's token until 5 min before it expires", async () => {
  const gh = github();
  const opts = { config: CONFIG, fetch: gh.fetch };
  await appInstallationToken("cache/a", opts);
  assert.equal(await appInstallationToken("cache/b", opts), "ghs_minted");
  assert.equal(gh.calls.length, 2, "same owner: no second mint");
  await appInstallationToken("cache/a", { ...opts, now: () => Date.now() + HOUR - 4 * 60_000 });
  assert.equal(gh.calls.length, 4, "inside the 5-min margin: minted again");
});

test("a repo the App isn't installed on gives null, and the owner isn't retried for 10 min", async () => {
  const gh = github({ installation: 404 });
  const opts = { config: CONFIG, fetch: gh.fetch };
  assert.equal(await appInstallationToken("other/x", opts), null);
  assert.equal(gh.calls.length, 1, "the installation lookup ran");
  assert.equal(await appInstallationToken("other/y", opts), null);
  assert.equal(gh.calls.length, 1, "same owner within 10 min: no new lookup");
  await appInstallationToken("other/x", { ...opts, now: () => Date.now() + 11 * 60_000 });
  assert.equal(gh.calls.length, 2, "after 10 min: looked up again");
});

test("every GitHub call carries an abort signal, so a stalled API falls back", async () => {
  const gh = github();
  await appInstallationToken("timeout/a", { config: CONFIG, fetch: gh.fetch });
  assert.deepEqual(
    gh.calls.map((c) => c.signal instanceof AbortSignal),
    [true, true],
  );
});

test("not configured: null with no call to GitHub", async () => {
  const gh = github();
  assert.equal(await appInstallationToken("none/x", { config: null, fetch: gh.fetch }), null);
  assert.deepEqual(gh.calls, []);
});

test("githubAppConfig reads app_id from config.yaml and the base64 key from secrets.env", async () => {
  const secrets = Buffer.from(PEM).toString("base64");
  await withSandboxHome(
    () => {
      const dir = path.dirname(process.env.WERKMEISTER_CONFIG_FILE);
      assert.equal(githubAppConfig(), null, "no key yet");
      fs.writeFileSync(path.join(dir, "secrets.env"), `GITHUB_APP_PRIVATE_KEY=${secrets}\n`);
      assert.deepEqual(githubAppConfig(), { appId: "4242", privateKey: PEM });
    },
    { config: "github_ingest:\n  app_id: '4242'\n" },
  );
  await withSandboxHome(() => {
    const dir = path.dirname(process.env.WERKMEISTER_CONFIG_FILE);
    fs.writeFileSync(path.join(dir, "secrets.env"), `GITHUB_APP_PRIVATE_KEY=${secrets}\n`);
    assert.equal(githubAppConfig(), null, "a key without app_id is off");
  });
});

test("a token the App's gh call was refused with is dropped: the owner runs as the person for 10 min", async () => {
  const gh = github();
  const opts = { config: CONFIG, fetch: gh.fetch };
  assert.equal(await appInstallationToken("drop/a", opts), "ghs_minted");
  refuseAppToken("drop/a");
  assert.equal(await appInstallationToken("drop/b", opts), null);
  assert.equal(gh.calls.length, 2, "no new mint while refused");
  assert.equal(
    await appInstallationToken("drop/a", { ...opts, now: () => Date.now() + 11 * 60_000 }),
    "ghs_minted",
  );
});
