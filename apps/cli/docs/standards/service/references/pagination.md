---
kind: example
canonical: comx:libs/modules/rest-crud/src/lib/base-crud.service.ts
---

# Offset pagination with a shared envelope

`page` (1-based) + `perPage` in, `{ data, total, page, perPage }` out. This
is the direction chosen where repos disagree: taxonomy-service's
`FilteredPaginationQueryDto` instead names the params `limit`/`offset` and
returns no shared envelope of its own — but `BaseCrudService.findMany` is
the implementation actually reused across Product/Category/Feature/
FeatureGroup controllers via `CrudController<T>()`, so its param names and
envelope are the ones to match.

## The load-bearing part

```ts
async findMany(query: QueryParams<T>): Promise<PaginatedResponse<T>> {
  const { page = 1, perPage = 1, sort, filter } = query;
  const findQuery = this.model.find(filter || {});
  // … sort handling …
  const [data, total] = await Promise.all([
    findQuery
      .skip((page - 1) * perPage)
      .limit(perPage)
      .exec(),
    this.model.countDocuments(filter || {}),
  ]);

  return {
    data,
    total,
    page,
    perPage,
  };
}
```

If this workspace has `comx` checked out, read the full canonical file
before writing your own.
