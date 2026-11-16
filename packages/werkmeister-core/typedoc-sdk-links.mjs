// SW-770: docs:links makes each src file its own module, and TypeScript reads `@throws {@link X}` as the
// tag's type, so that link only resolves when the file defines or re-exports X. Resolve the rest by the
// SDK's export of the name, the rule docs:sdk uses, so one `{@link X}` form passes both.

/** True when `ref` is a bare name (`{@link X}`) that `sdk` (the `sdk.ts` module reflection) exports. */
export function sdkExports(ref, sdk) {
  const path = ref.symbolReference?.path;
  return !ref.moduleSource && path?.length === 1 && Boolean(sdk?.getChildByName(path[0].path));
}

export function load(app) {
  app.converter.addUnknownSymbolResolver((ref, refl) =>
    // docs:links emits nothing, so the target only has to exist.
    sdkExports(ref, refl.project.getChildByName("sdk")) ? "#sdk" : undefined,
  );
}
