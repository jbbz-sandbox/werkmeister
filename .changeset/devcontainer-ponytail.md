---
"werkmeister-core": patch
---

Devcontainer workspaces install the ponytail plugin in `postCreateCommand`, into the shared `~/.claude` volume, so Claude sessions inside the container run with ponytail like host sessions do.
