---
"werkmeister-core": patch
---

SW-1203: the generated ICM implement contract (feature and refactor) runs `werkmeister pr gate --tests` once, after the last review round has no open finding the person wants fixed, and never while a review runs. Between fixes it reruns only the test files a fix reaches and the cheap rows. It runs `werkmeister feature stop` before the review and before a browser check that doesn't use the test containers. The implement and propose contracts now say what the gate does with its containers: a failing gate stops the ones it started, a passing one leaves them running, and the idle reaper stops idle ones. So before a test after the gate, start the service's container with `werkmeister feature up --service <name>` if it is not running.
