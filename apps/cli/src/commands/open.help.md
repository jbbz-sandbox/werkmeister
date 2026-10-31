## Description

Launches an isolated Chrome window for a feature: it sets the `X-Feature` routing cookie and tags the window (title prefix and corner badge) so it is plainly that feature's window. It drives Chrome over the DevTools Protocol, without Playwright.

Routing only resolves while the feature is running (`werkmeister feature up`). Otherwise the cookie is set but traffic falls through to the k8s baseline.

## Examples

```bash
werkmeister feature open my-feature
werkmeister feature open my-feature --path /settings
werkmeister feature open my-feature --size 1280,800 --position 0,0
```
