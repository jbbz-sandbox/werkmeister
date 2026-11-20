---
"werkmeister": patch
---

The `github_ingest` AWS key pair now lives in `~/.werkmeister/secrets.env` (`GITHUB_INGEST_ACCESS_KEY_ID`, `GITHUB_INGEST_SECRET_ACCESS_KEY`) instead of `~/.werkmeister/config.yaml`, so reading the config to check a setting no longer prints credentials. `werkmeister machine config --write` and `werkmeister machine setup` move keys still in config.yaml there, and the daemon reads either place until then (SW-759).
