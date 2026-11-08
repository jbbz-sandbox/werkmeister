# GitHub push events (GitHub App → AWS → daemon)

Without this, werkmeister learns about GitHub events by polling: `werkmeister pr watch` runs every 10 minutes ([Workspace lifecycle](workspace-lifecycle.md)). With it, a GitHub event reaches the daemon within seconds, and events wait in a queue while the laptop sleeps or the daemon is down. The 10-minute schedule stays as the fallback.

```
GitHub App webhook ─▶ Lambda function URL ─▶ SQS queue ─(5 failed receives)─▶ DLQ
                         checks the signature        ▲
                                                     └── werkmeister daemon long-polls (20 s)
```

- **The Lambda** checks `X-Hub-Signature-256` against the webhook secret and returns 401 for anything unsigned or wrongly signed. It forwards only `check_run`, `workflow_run`, `pull_request`, `pull_request_review`, `pull_request_review_comment` and `issue_comment`, as `{delivery, event, action, repo}`. The payload itself stays in GitHub.
- **The queue** keeps messages for 14 days, and so does its DLQ.
- **The daemon** runs one `pr watch` pass for each repo a batch names, and only over workspaces that have a PR file for that repo. Events for other repos are logged as ignored and deleted. A message is deleted only after its pass finishes. A pass that throws leaves the message for redelivery, and after 5 receives it moves to the DLQ. Delivery ids are remembered, so a redelivered event doesn't run a second pass.

There's nothing to set up per repo. The App is installed on all of your repos, and a repo's events act as soon as a workspace on this machine has a PR file for it.

The infra code is in `apps/github-ingest` (AWS CDK). The daemon side is `apps/werkmeister-mcp/src/github_ingest.ts`.

## Setup

Do it once for each part: the AWS account, the GitHub account, and each machine.

### 1. AWS: deploy the stack

You need the AWS CLI with credentials for the account (`aws configure`), and a fresh worktree install (`pnpm install --frozen-lockfile` at the repo root).

```sh
SECRET=$(openssl rand -hex 32)    # keep it for step 2
cd apps/github-ingest
pnpm exec cdk bootstrap           # first time in this account and region only
pnpm exec cdk deploy --parameters WebhookSecret=$SECRET
aws iam create-access-key --user-name werkmeister-github-ingest-poller
```

`cdk deploy` prints `FunctionUrl`, `QueueUrl`, `DlqUrl` and `PollerUser`. The region defaults to `us-east-1`; set `CDK_DEFAULT_REGION` to use another. The access key belongs to a user that can only `sqs:ReceiveMessage` and `sqs:DeleteMessage` on that one queue. The stack doesn't create the key itself, because a CloudFormation output would show its secret.

### 2. GitHub: create and install the App

Go to GitHub → Settings → Developer settings → GitHub Apps → New GitHub App:

- **Webhook URL:** the `FunctionUrl` output. **Webhook secret:** `$SECRET` from step 1.
- **Repository permissions**, all read-only: Checks, Actions, Pull requests, Issues, Metadata.
- **Subscribe to events:** Check run, Workflow run, Pull request, Pull request review, Pull request review comment, Issue comment.
- **Where can this App be installed:** only on this account.

Then install it with **All repositories**. You don't need the App's private key: werkmeister calls no API as the App, and `gh` keeps doing the reading.

### 3. Each machine: point the daemon at the queue

Add this to `~/.werkmeister/config.yaml`:

```yaml
github_ingest:
  queue_url: https://sqs.us-east-1.amazonaws.com/123456789012/WerkmeisterGithubIngest-Queue...
  region: us-east-1
  access_key_id: AKIA...
  secret_access_key: ...
```

Then run `werkmeister daemon restart`. The daemon log should show `github ingest: polling …`, or `github ingest: off` without the block. The log is at
`~/.werkmeister/sandbox-mcp.log`. <!-- name-check: ignore: the daemon's real log file name -->

The keys and region come only from this block. `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `AWS_REGION` in the daemon's environment are ignored, so the poller always runs as the receive/delete-only user. The SDK still honours endpoint and proxy variables such as `AWS_ENDPOINT_URL_SQS`. `werkmeister machine config` masks the two keys when it prints the config.

Use only one machine per queue. A second machine polling the same queue would take events meant for the first.

## Checking it works

- Comment on an open PR that a workspace has a PR file for. Within about 20 s, the log shows `github ingest: issue_comment/created on <owner>/<repo> (<delivery id>): …`.
- The App's **Advanced** tab lists each delivery with its response: 202 queued, 204 an event type that isn't forwarded, 401 a bad signature. You can redeliver from there.
- To see failed messages: `aws sqs receive-message --queue-url <DlqUrl> --max-number-of-messages 10`.

## Cost

One poller makes 2,592,000 s ÷ 20 s ≈ 130k receive requests a month, however many repos there are. Each event adds about three requests (send, receive, delete) and one Lambda invocation. That's well within the SQS free tier (1M requests) and the Lambda free tier (1M invocations). Events from repos with no workspace still cross the queue before the daemon ignores them. The function URL is public: a bad signature is rejected cheaply, but every request is still an invocation.
