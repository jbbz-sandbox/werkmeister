## Description

Useful after making code changes that hot-reload doesn't pick up. If the feature doesn't have a slot, prints an error suggesting `werkmeister feature up` instead. A changed registry or `services.yaml` definition (e.g. a new `command:`) is not applied by restart, which keeps the existing `compose.yml`; run `werkmeister feature up <feature>` instead.
