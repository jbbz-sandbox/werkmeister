---
"werkmeister-core": patch
---

An on-demand service the PR gate or `feature up --service` starts now reaches its checked-out `depends_on` at their containers, which compose starts alongside it: its `.env.<svc>` carries those dependencies' `<SVC>_URL`/`_HOST`/`_PORT`, and its `{dep}` references in `environment:` resolve the same way. Before, an all-on-demand workspace pointed them at `k8s-forwards`. A workspace's own `env_vars` still win (SW-956).
