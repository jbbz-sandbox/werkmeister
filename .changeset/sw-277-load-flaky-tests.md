---
"werkmeister": patch
"werkmeister-core": patch
---

SW-277: test-only. The wrapper npx-bootstrap test runs the wrapper async with a 120 s limit (macOS's first-exec check of its fresh stubs slows with host load), and `infra-retire-legacy`'s `argvOf` names a missing docker-stub line and prints the whole log instead of throwing a TypeError.
