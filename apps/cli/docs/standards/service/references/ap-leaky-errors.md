---
kind: anti-pattern
---

# Leaky errors from a broad catch

## What it looks like

```ts
async findById(id: string): Promise<T> {
  try {
    const entity = await this.model.findById(id).exec();
    if (!entity) {
      throw new NotFoundException(`Entity with id ${id} not found`);
    }
    return entity;
  } catch (error: any) {
    throw new NotFoundException(`Failed to find entity with id ${id}: ${error.message}`);
  }
}
```

## Why it's wrong

Real code: `comx:libs/modules/rest-crud/src/lib/base-crud.service.ts` wraps
`findById`/`findOne`/`findMany`/`findAll` in exactly this shape. The outer
catch re-wraps *any* thrown error — including a Mongo connection timeout or
a malformed filter, not just "not found" — as a 404, and interpolates the
caught error's raw `error.message` into the new one. A DB outage now reads
as "Failed to find entity with id 123: connect ECONNREFUSED 10.0.0.5:27017"
to the API consumer: an internal infrastructure detail leaked through a
misclassified status code.

## The fix

```ts
async findById(id: string): Promise<T> {
  const entity = await this.model.findById(id).exec();
  if (!entity) {
    throw new NotFoundException(`Entity with id ${id} not found`);
  }
  return entity;
}
```

Throw the specific exception for the specific failure you can identify;
let anything else propagate to Nest's default filter instead of relabeling
it.
