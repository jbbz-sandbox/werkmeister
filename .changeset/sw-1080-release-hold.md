---
"werkmeister": patch
---

A service start that waits for capacity in an autonomous workspace no longer stops the workspace's containers while a `docker exec` runs in them (another gate's row, an agent's tests); it holds them and looks again at the next poll. When it does stop them it records why, so a gate row that finds its container stopped names that wait instead of saying werkmeister recorded no stop, and the record is cleared once the set starts again (SW-1080).
