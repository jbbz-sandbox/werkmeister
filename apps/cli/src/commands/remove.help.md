## Description

Removes the service from the feature's local stack. The service will now be served from k8s. Config files are regenerated and Caddy is reloaded.

If removing the last service, the feature's containers are fully stopped (though the slot remains allocated — use `werkmeister feature down` to release it).

```bash
werkmeister feature drop my-feature frontend
```
