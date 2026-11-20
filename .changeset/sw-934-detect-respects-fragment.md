---
"werkmeister": patch
---

Re-running `werkmeister machine detect` no longer proposes an `infrastructure:` entry for a compose datastore the fragment already runs as a local service (`image:`), matched by name or by the host the service's existing env URL uses. It no longer proposes `command: sleep infinity` for an idle type (`cli`, `library`, `extension`), which already idles (SW-934).
