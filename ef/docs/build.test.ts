// docs/build.test.ts — the docs' CI gate: the site builds, and every internal
// link resolves — target page exists and the anchor id exists on it. This is
// what keeps cross-page deep links (`types.md#effects`) honest as pages
// evolve. Runs under the root `bun test` like the compiler suites.
import {describe, expect, test} from "bun:test";
import {ALL_PAGES, build} from "./build.ts";

const pages = await build();

const outPath = (file: string): string => file.replace(/\.md$/, ".html");

describe("docs build", () => {
  test("emits a page per nav entry", () => {
    expect(pages.size).toBe(ALL_PAGES.length);
  });

  // Anchor ids present on each emitted page.
  const ids = new Map<string, Set<string>>();
  for (const [file, html] of pages)
    ids.set(outPath(file), new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1])));

  const dirOf = (f: string): string => (f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "");
  const resolveFrom = (fromFile: string, rel: string): string => {
    const out: string[] = [];
    for (const p of `${dirOf(fromFile)}/${rel}`.split("/")) {
      if (p === "" || p === ".") continue;
      if (p === "..") out.pop();
      else out.push(p);
    }
    return out.join("/");
  };

  test("every internal link resolves to a page and anchor", () => {
    const broken: string[] = [];
    for (const [file, html] of pages) {
      for (const m of html.matchAll(/href="([^"]+)"/g)) {
        const href = m[1];
        const hash = href.indexOf("#");
        const path = hash === -1 ? href : href.slice(0, hash);
        const anchorId = hash === -1 ? null : href.slice(hash + 1);
        // Only page links are checked: same-page anchor (empty path or "#…"),
        // page-relative link (x.md / x.html); assets and external URLs are
        // skipped.
        const target = path === "" || path.startsWith("#")
          ? outPath(file)
          : (/\.(html|md)$/.test(path) ? resolveFrom(file, path) : null);
        if (target === null) continue;
        const pageIds = ids.get(target);
        if (pageIds === undefined) {
          broken.push(`${file} → ${href} (no page)`);
          continue;
        }
        if (anchorId !== null && !pageIds.has(anchorId))
          broken.push(`${file} → ${href} (no anchor)`);
      }
    }
    expect(broken).toEqual([]);
  });
});
