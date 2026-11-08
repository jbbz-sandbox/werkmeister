import { App } from "aws-cdk-lib";
import { IngestStack } from "../src/stack.mjs";

const app = new App();
new IngestStack(app, "WerkmeisterGithubIngest", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
