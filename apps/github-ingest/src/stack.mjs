import { fileURLToPath } from "node:url";
import { CfnOutput, CfnParameter, Duration, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as sqs from "aws-cdk-lib/aws-sqs";

const LAMBDA_DIR = fileURLToPath(new URL("../lambda", import.meta.url));
const FOURTEEN_DAYS = Duration.days(14);

/** GitHub App webhook → Lambda function URL → SQS (+ DLQ), and the receive/delete-only poller user. */
export class IngestStack extends Stack {
  /**
   * @param {import("constructs").Construct} scope
   * @param {string} id
   * @param {import("aws-cdk-lib").StackProps} [props]
   */
  constructor(scope, id, props) {
    super(scope, id, props);

    const secret = new CfnParameter(this, "WebhookSecret", {
      type: "String",
      noEcho: true,
      minLength: 20,
      description: "The GitHub App's webhook secret.",
    });

    const dlq = new sqs.Queue(this, "Dlq", { retentionPeriod: FOURTEEN_DAYS });
    const queue = new sqs.Queue(this, "Queue", {
      retentionPeriod: FOURTEEN_DAYS,
      // One pr watch pass shells out to gh per PR file; 30 s would redeliver mid-pass.
      visibilityTimeout: Duration.seconds(120),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    const fn = new lambda.Function(this, "Ingest", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler.handler",
      code: lambda.Code.fromAsset(LAMBDA_DIR),
      timeout: Duration.seconds(10),
      memorySize: 128,
      environment: { WEBHOOK_SECRET: secret.valueAsString, QUEUE_URL: queue.queueUrl },
    });
    queue.grantSendMessages(fn);
    // Public on purpose: the HMAC check in the handler is the trust boundary.
    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // Not grantConsumeMessages: that also grants GetQueueAttributes, ChangeMessageVisibility, GetQueueUrl.
    // No access key here either: a CloudFormation output would show its secret.
    const poller = new iam.User(this, "Poller", { userName: "werkmeister-github-ingest-poller" });
    poller.addToPolicy(
      new iam.PolicyStatement({
        actions: ["sqs:ReceiveMessage", "sqs:DeleteMessage"],
        resources: [queue.queueArn],
      }),
    );

    new CfnOutput(this, "FunctionUrl", { value: url.url });
    new CfnOutput(this, "QueueUrl", { value: queue.queueUrl });
    new CfnOutput(this, "DlqUrl", { value: dlq.queueUrl });
    new CfnOutput(this, "PollerUser", { value: poller.userName });
  }
}
