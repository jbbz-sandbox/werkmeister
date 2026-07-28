---
kind: example
canonical: "econx:apps/web-v2/schema.graphql"
---

# Relay Cursor Connections — the paginated-list shape

## The load-bearing part

Paginated list fields use the Relay Cursor Connections shape — the Relay/Apollo
client cache depends on it, so don't invent a bespoke `{items, nextPage}` shape.

```graphql
type ThingConnection {
  edges: [ThingEdge!]!        # non-null list of non-null edges (empty, never null)
  pageInfo: PageInfo!         # always present
  totalCount: Int             # optional; omit if it forces an extra COUNT query
}

type ThingEdge {
  node: Thing!
  cursor: String!             # opaque; equals PageInfo.startCursor/endCursor at the ends
}

# ONE shared PageInfo across all connections — not a per-type copy.
type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: String
  endCursor: String
}
```

- **Args**: forward = `first: Int, after: String`; backward = `last: Int, before: String`.
  Implement forward at minimum; add backward only when a client needs it.
- **Cursors are opaque** — base64 an encoding of the sort key + a unique tiebreaker
  (e.g. `(createdAt, id)`), never a raw offset or bare DB id. Offsets skip/duplicate
  rows under concurrent writes; the cursor must stay stable across inserts and deletes.

## Going deeper

Avoid (present in web-v2 `schema.graphql`, don't copy): a per-connection
`<Type>PageInfo` — collapse to the single shared `PageInfo`; and nullable
`edges`/`pageInfo` — make both non-null so callers never null-check a list that
is always returnable.
