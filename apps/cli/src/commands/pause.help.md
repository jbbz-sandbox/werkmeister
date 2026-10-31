## Description

Freezes a workspace's running containers and holds its Claude session until `werkmeister feature resume`. Nothing is removed: the slot, the containers and their state stay as they are.

## Examples

```bash
werkmeister feature pause my-feature
werkmeister feature resume my-feature
```
