/**
 * GitHub's heading id: link text kept, punctuation dropped, lowercased, spaces to hyphens.
 * The one slug rule (SW-611): the site builds heading ids with it and scripts/check-docs.mjs
 * checks #anchors with it. It lives here, not in check-docs.mjs, because that file starts
 * with a shebang and the VitePress config bundle can't import one.
 */
export function slug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, "")
    .replace(/ /g, "-");
}
