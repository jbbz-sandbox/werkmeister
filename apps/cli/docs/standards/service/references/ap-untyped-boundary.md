---
kind: anti-pattern
---

# Untyped request body

## What it looks like

```ts
@Post()
async create(@Body() createDto: any): Promise<T> {
  return this.service.create(createDto);
}

@Put(':id')
async update(@Param('id') id: string, @Body() updateDto: any): Promise<T> {
  return this.service.update(id, updateDto);
}
```

## Why it's wrong

Real code: `comx:libs/modules/rest-crud/src/lib/base-crud.controller.ts`'s
generic `CrudController<T>()` factory has exactly this — `create`/`update`
take `any`, with no DTO class and no `ValidationPipe`. Every current
consumer (Product/Category/Feature/FeatureGroup controllers) has to
explicitly `exclude: ['create', 'update', 'remove']` in `CrudOptions` to
avoid inheriting it — proof the untyped boundary is already known to be
unsafe to expose. Left as-is, whatever the caller sends reaches the
service and the model layer unchecked: wrong types, extra fields, or
missing required fields all pass straight through to the database.

## The fix

```ts
@Post()
@UsePipes(new ValidationPipe({ transform: true }))
async create(@Body() createDto: CreateThingDto): Promise<T> {
  return this.service.create(createDto);
}
```

Declare a class-validator DTO for the resource and validate at the
handler, the way `category.controller.ts` / `contact.controller.ts` do.
