## Description

Runs `python3 -I -u -m http.server 0 -b 127.0.0.1 -d <dir>` in the foreground: loopback only, a port the OS picks (the first line prints it). Refuses a `<dir>` whose real path is outside the workspace, is the workspace folder itself, or is in a dot-folder: those hold its daemon token and `.env` files. It resolves only `<dir>` itself, so a symlink inside it is still followed. The ICM stage contracts name it for a browser check of a static HTML page, since the Chrome tool refuses `file://`; each ICM run pre-approves it. Run it as a background job and stop it by its task ID.

## Examples

```bash
werkmeister workspace serve stages
```
