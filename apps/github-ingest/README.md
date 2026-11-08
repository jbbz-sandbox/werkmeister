# github-ingest

AWS infra (CDK) for werkmeister's GitHub push path (SW-583). GitHub App webhook → Lambda function URL → SQS (+ DLQ) → the werkmeister daemon. Setup, deploy and costs: [docs/github-ingest.md](../../docs/github-ingest.md).
