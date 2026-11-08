// SW-583: the synthesized template. Retention, redrive, the poller's exact rights, no SNS, no access key.
// Synthesizes offline: no AWS credentials needed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { IngestStack } from "./src/stack.mjs";

const template = Template.fromStack(new IngestStack(new App(), "Test"));
const FOURTEEN_DAYS = 1209600;

test("queue: 14-day retention, 120 s visibility, DLQ after 5 receives; DLQ keeps 14 days", () => {
  template.resourceCountIs("AWS::SQS::Queue", 2);
  template.hasResourceProperties("AWS::SQS::Queue", {
    MessageRetentionPeriod: FOURTEEN_DAYS,
    VisibilityTimeout: 120,
    RedrivePolicy: { deadLetterTargetArn: Match.anyValue(), maxReceiveCount: 5 },
  });
  template.hasResourceProperties("AWS::SQS::Queue", {
    MessageRetentionPeriod: FOURTEEN_DAYS,
    RedrivePolicy: Match.absent(),
  });
});

test("the poller user may only receive and delete on the one queue; the stack makes no access key", () => {
  const policies = Object.values(template.findResources("AWS::IAM::Policy")).filter((p) =>
    JSON.stringify(p.Properties.Users ?? []).includes("Poller"),
  );
  assert.equal(policies.length, 1);
  const statements = policies[0].Properties.PolicyDocument.Statement;
  assert.equal(statements.length, 1);
  assert.deepEqual(statements[0].Action, ["sqs:ReceiveMessage", "sqs:DeleteMessage"]);
  assert.equal(statements[0].Effect, "Allow");
  assert.deepEqual(statements[0].Resource, { "Fn::GetAtt": [queueId(false), "Arn"] });
  template.resourceCountIs("AWS::IAM::AccessKey", 0);
});

test("no SNS: the Lambda sends straight to SQS", () => {
  template.resourceCountIs("AWS::SNS::Topic", 0);
});

test("public function URL; the Lambda gets the secret parameter and the queue URL", () => {
  template.hasResourceProperties("AWS::Lambda::Url", { AuthType: "NONE" });
  template.hasResourceProperties("AWS::Lambda::Function", {
    Runtime: "nodejs22.x",
    Handler: "handler.handler",
    Environment: {
      Variables: { WEBHOOK_SECRET: { Ref: "WebhookSecret" }, QUEUE_URL: { Ref: queueId(false) } },
    },
  });
  template.hasParameter("WebhookSecret", { NoEcho: true, MinLength: 20 });
});

/** The logical id of the main queue (dlq=false) or the DLQ. */
function queueId(dlq) {
  const [id] = Object.entries(template.findResources("AWS::SQS::Queue")).find(
    ([, r]) => !r.Properties.RedrivePolicy === dlq,
  );
  return id;
}
