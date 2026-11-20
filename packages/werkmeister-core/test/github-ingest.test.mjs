// SW-583: the daemon's SQS consumer config and the queue message contract.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { githubIngestConfig, parseIngestMessage } from "../dist/github_ingest.js";
import { save } from "../dist/global_config.js";

const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ingest-cfg-")), "config.yaml");
process.env.WERKMEISTER_CONFIG_FILE = file;
for (const k of ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]) delete process.env[k];

const BLOCK = `github_ingest:
  queue_url: https://sqs.us-east-1.amazonaws.com/1/q
  region: us-east-1
  access_key_id: AKIAX
  secret_access_key: sek
`;

test("githubIngestConfig: off without a config file or a github_ingest block", () => {
  fs.rmSync(file, { force: true });
  assert.equal(githubIngestConfig(), null);
  fs.writeFileSync(file, "jira:\n  email: a@b.c\n");
  assert.equal(githubIngestConfig(), null);
});

test("githubIngestConfig: reads all four keys", () => {
  fs.writeFileSync(file, BLOCK);
  assert.deepEqual(githubIngestConfig(), {
    queueUrl: "https://sqs.us-east-1.amazonaws.com/1/q",
    region: "us-east-1",
    accessKeyId: "AKIAX",
    secretAccessKey: "sek",
  });
});

test("githubIngestConfig: shell AWS_* keys are ignored", (t) => {
  t.after(() => {
    delete process.env.AWS_ACCESS_KEY_ID;
  });
  process.env.AWS_ACCESS_KEY_ID = "AKIAENV";
  fs.writeFileSync(file, BLOCK);
  assert.equal(githubIngestConfig()?.accessKeyId, "AKIAX");
  fs.writeFileSync(file, "jira: {}\n");
  assert.equal(githubIngestConfig(), null);
});

test("githubIngestConfig: an empty field turns it off", () => {
  fs.writeFileSync(file, BLOCK.replace("sek", '""'));
  assert.equal(githubIngestConfig(), null);
});

test("parseIngestMessage: good, bad JSON, missing fields", () => {
  assert.deepEqual(
    parseIngestMessage('{"delivery":"d1","event":"pull_request","action":"opened","repo":"o/app"}'),
    { delivery: "d1", event: "pull_request", action: "opened", repo: "o/app" },
  );
  assert.equal(parseIngestMessage('{"delivery":"d1","event":"x","repo":"o/a"}').action, null);
  assert.equal(parseIngestMessage("not json"), null);
  assert.equal(parseIngestMessage('{"repo":"o/app"}'), null);
  assert.equal(parseIngestMessage('{"delivery":"d1"}'), null);
  assert.equal(parseIngestMessage("null"), null);
});

// SW-759: the AWS key pair lives in secrets.env (next to config.yaml), never in config.yaml.
test("githubIngestConfig: reads the key pair from secrets.env", (t) => {
  const secrets = path.join(path.dirname(file), "secrets.env");
  t.after(() => fs.rmSync(secrets, { force: true }));
  fs.writeFileSync(
    file,
    "github_ingest:\n  queue_url: https://sqs.us-east-1.amazonaws.com/1/q\n  region: us-east-1\n",
  );
  fs.writeFileSync(
    secrets,
    "GITHUB_INGEST_ACCESS_KEY_ID=AKIASEC\nGITHUB_INGEST_SECRET_ACCESS_KEY=seksec\n",
  );
  assert.equal(githubIngestConfig()?.accessKeyId, "AKIASEC");
  assert.equal(githubIngestConfig()?.secretAccessKey, "seksec");
});

test("save moves the key pair out of config.yaml; a key already in secrets.env wins", (t) => {
  const secrets = path.join(path.dirname(file), "secrets.env");
  t.after(() => fs.rmSync(secrets, { force: true }));
  fs.writeFileSync(secrets, "OTHER=keep\nGITHUB_INGEST_ACCESS_KEY_ID=AKIAROTATED\n");
  save(parse(BLOCK));
  const yaml = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(yaml, /AKIAX|sek|access_key/);
  assert.match(yaml, /queue_url/);
  assert.equal(
    fs.readFileSync(secrets, "utf8"),
    "OTHER=keep\nGITHUB_INGEST_ACCESS_KEY_ID=AKIAROTATED\nGITHUB_INGEST_SECRET_ACCESS_KEY=sek\n",
  );
  assert.equal(fs.statSync(secrets).mode & 0o777, 0o600);
  assert.equal(githubIngestConfig()?.secretAccessKey, "sek");
  assert.equal(githubIngestConfig()?.accessKeyId, "AKIAROTATED");
});
