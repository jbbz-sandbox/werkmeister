---
"werkmeister": minor
---

The daemon can take GitHub events by push (SW-583). A GitHub App's webhook goes to a Lambda function URL that checks the signature and queues the event in SQS. The daemon long-polls the queue and runs one `pr watch` pass for the event's repo within seconds, instead of waiting for the 10-minute schedule. It's off until `~/.werkmeister/config.yaml` has a `github_ingest:` block. Setup: docs/github-ingest.md.
