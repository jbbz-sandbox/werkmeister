---
"werkmeister": patch
---

SW-556: `werkmeister internal wait-load`, the host-load wait `with-temp-home` runs before its command, returns at once on macOS: the macOS load average counts idle daemons (450-550 on a quiet host) and never the Linux VM that runs the tests, so the wrapper waited, or refused with exit 75, while the VM idled. On Linux the 90 s wait is unchanged. `waitForHostLoad` and its unused budget parameters are folded into `waitForHostLoadNow`.
