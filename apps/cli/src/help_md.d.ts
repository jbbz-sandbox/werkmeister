/** A command's help.md, bundled as a string by esbuild.mjs's `.md` text loader. */
declare module "*.md" {
  const text: string;
  export default text;
}
