---
"werkmeister": patch
"werkmeister-vscode": patch
---

The status strip's infra chip names each service by its state, in the /workspaces pane and the VS Code strip: `infra: caddy down, k8s-forwards starting`. A service still starting no longer reads `down`, and the chip is amber while every named service is only starting; red once one is down or unhealthy (SW-1069).
