---
kind: example
canonical: comx:domains/communication/modules/contact/src/lib/contact.controller.ts
---

# 404 on missing, no custom exception filter

No repo in scope defines a custom `ExceptionFilter` — the convention is to
throw NestJS's own typed exception at the point of failure and let Nest's
default filter shape the response body (`{ statusCode, message, error }`).
This handler is the cleanest real instance of the pattern: a lookup that
can legitimately miss, converted to a 404 with a specific message, nothing
else caught or reformatted.

## The load-bearing part

```ts
@Get('find-by-email')
async findByEmail(@Query('email') email: string) {
  const contact = await this.contactService.findByEmail(email);
  if (!contact) {
    throw new NotFoundException(`Contact with email ${email} not found`);
  }
  return contact;
}
```

If this workspace has `comx` checked out, read the full canonical file
before writing your own.
