---
"werkmeister": patch
---

`werkmeister-context.md` § Test commands now says that stopping a background `docker exec` test run ends only the client while the run goes on in the container, and how to end it there (`docker exec <container> kill -TERM -- -<pid>`), so a rerun doesn't race the old one (SW-968).
