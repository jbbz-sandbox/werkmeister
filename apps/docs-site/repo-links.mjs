import { dirname, join, normalize, relative } from "node:path";

/**
 * Relative links to repo files that aren't site pages (LICENSE, apps/cli, …) go
 * to GitHub. A target that doesn't exist is left alone, so VitePress's dead-link
 * check still fails the build on it.
 */
export function repoLinks(md, { root, pages, repoUrl, exists }) {
  md.core.ruler.push("repo-links", (state) => {
    const from = dirname(relative(root, state.env.path));
    for (const token of state.tokens)
      for (const link of token.children ?? []) {
        if (link.type !== "link_open") continue;
        const href = link.attrGet("href");
        if (/^([a-z][a-z\d+.-]*:|#|\/)/i.test(href)) continue;
        const [path, hash] = href.split("#");
        const target = normalize(join(from, path));
        if (!pages.includes(target) && exists(join(root, target)))
          link.attrSet("href", `${repoUrl}${target}${hash ? `#${hash}` : ""}`);
      }
  });
}
