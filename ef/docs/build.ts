// docs/build.ts — builds the documentation site into dist/: markdown sources
// in content/ → static HTML pages. Hand-rolled like the playground's build:
// no SSG framework — `marked` renders markdown; nav, page shell, theming and
// link rewriting live here.
//
// Theme reuse: the design tokens (the :root / [data-theme] variable blocks)
// are extracted at build time from ../playground/studio.css, so the docs track
// the playground's palette with no manual sync. site.css supplies the
// docs-specific layout and prose styles on top of those tokens.

import {existsSync, mkdirSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {readFile} from "node:fs/promises";
import {join, dirname} from "node:path";
import {marked} from "marked";

const here = (...p: string[]) => join(import.meta.dir, ...p);
const dist = here("dist");

// --- nav (single source: the content/ tree itself) ---------------------------

// The sidebar mirrors the markdown directory structure: a directory's
// index.md is its page — the site root (index.md), a section root (spec/,
// dev/) or a subtree root (dev/wasm/) — and every other *.md beside it is a
// child page; subdirectories recurse. Labels and section titles are each
// file's first `#` heading; children sort by filename (the parent pages'
// pipeline tables carry the reading order). Each file is read exactly once
// per build: label and md body both come from that single read.
type Page = {file: string, label: string, md: string, children?: Page[]};

async function loadFile(file: string): Promise<Page> {
  const md = await readFile(here("content", file), "utf8");
  const m = md.match(/^# (.+)$/m);
  if (m === null)
    throw new Error(`docs/content/${file}: no top-level '#' heading for the nav label`);
  return {file, label: m[1], md};
}

// Page for a directory: its index.md, with its *.md files and subdirectories
// (each index.md-rooted) as name-sorted children.
async function loadDir(relDir: string): Promise<Page> {
  if (!existsSync(here("content", relDir, "index.md")))
    throw new Error(`docs/content/${relDir}: every directory needs an index.md root page`);
  const file = relDir === "" ? "index.md" : `${relDir}/index.md`;
  const children: Page[] = [];
  const entries = readdirSync(here("content", relDir), {withFileTypes: true})
    .filter(e => e.isDirectory() || e.name.endsWith(".md"))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const e of entries) {
    if (e.name === "index.md") continue;
    const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
    children.push(e.isDirectory() ? await loadDir(rel) : await loadFile(rel));
  }
  return {...await loadFile(file), children: children.length > 0 ? children : undefined};
}

// Sidebar tree flattened in build order (children after their parent).
const flat = (p: Page): Page[] => [p, ...(p.children ?? []).flatMap(flat)];

const outPath = (page: Page): string => page.file.replace(/\.md$/, ".html");

// --- theming -----------------------------------------------------------------
// Same preference key as the playground: one light/dark choice across the site.
// Applied before first paint (head script) and toggled by the topbar button
// (event-delegated, so the script needs no DOMContentLoaded).
const THEME_JS = `(() => {
  const KEY = "ef.playground.theme"; // shared with the playground
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const pref = () => {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : (mq.matches ? "dark" : "light");
  };
  document.documentElement.dataset.theme = pref();
  document.addEventListener("click", (e) => {
    if (e.target instanceof Element && e.target.closest("#theme-btn")) {
      const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = t;
      localStorage.setItem(KEY, t);
    }
  });
})();`;

// Theme-toggle button (moon/sun icons via icones.js.org), same markup as the
// playground's topbar so the same CSS applies.
const THEME_BTN = `<button id="theme-btn" class="tb-btn icon" title="toggle theme">` +
  `<svg class="i-moon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>` +
  `<svg class="i-sun" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></g></svg></button>`;

// Design tokens lifted verbatim from the playground stylesheet (the two
// variable blocks — everything else in studio.css is app-shell layout the
// docs must not inherit, e.g. body{overflow:hidden}). Throws when the file's
// shape changes: a failed build beats silently unstyled docs.
async function studioTokens(): Promise<string> {
  const css = await readFile(here("../playground/studio.css"), "utf8");
  const blocks = css.match(/^(?::root|\[data-theme="dark"\]) \{[\s\S]*?\n\}/gm);
  if (blocks === null || blocks.length !== 2)
    throw new Error("could not extract :root / [data-theme] token blocks from playground/studio.css");
  return blocks.join("\n\n");
}

// --- markdown ----------------------------------------------------------------

// Heading ids (GFM-style slugs, deduplicated per page) so pages can deep-link
// each other, e.g. spec.md#effects.
const slugCounts = new Map<string, number>();
const slugOf = (text: string): string => {
  const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s+/g, "-");
  const key = base === "" ? "section" : base;
  const n = slugCounts.get(key) ?? 0;
  slugCounts.set(key, n + 1);
  return n === 0 ? key : `${key}-${n}`;
};

marked.use({
  gfm: true,
  renderer: {
    heading(t) {
      const inner = this.parser.parseInline(t.tokens);
      return `<h${t.depth} id="${slugOf(t.text)}">${inner}</h${t.depth}>\n`;
    },
  },
});

// Markdown links (`[x](spec.md)`) stay page-relative in the output — the dist
// tree mirrors content/ — with .md rewritten to .html.
function rewriteLinks(html: string): string {
  return html.replace(/href="([^"]+)"/g, (m, href: string) => {
    if (/^(https?:|mailto:|#|\/)/.test(href) || !href.includes(".md")) return m;
    return `href="${href.replace(/\.md(?=#|$)/, ".html")}"`;
  });
}

// --- page shell --------------------------------------------------------------

function renderNav(current: Page, root: string, overview: Page, sections: Page[]): string {
  const attrOf = (p: Page, base = ""): string => {
    const cls = `${base}${p.file === current.file ? " active" : ""}`.trim();
    return cls === "" ? "" : ` class="${cls}"`;
  };
  const link = (p: Page, base = ""): string =>
    `    <a${attrOf(p, base)} href="${root}${outPath(p)}">${p.label}</a>`;
  const item = (p: Page): string => {
    if (p.children === undefined) return link(p);
    return `${link(p)}\n    <div class="nav-children">\n${p.children.map(item).join("\n")}\n    </div>`;
  };
  // Overview's children are the sections — rendered as groups, not as its nav subtree.
  const groups = [
    `  <div class="nav-group">\n${link(overview)}\n  </div>`,
    ...sections.map(s => 
      // The section title is its root page's link (index.md).
      `  <div class="nav-group">\n${link(s, "nav-title")}\n${(s.children ?? []).map(item).join("\n")}\n  </div>`,
    ),
  ];
  return `<nav id="sidebar">\n${groups.join("\n")}\n</nav>`;
}

function renderPage(page: Page, body: string, overview: Page, sections: Page[]): string {
  const root = "../".repeat(page.file.split("/").length - 1);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.label} · ef</title>
<link rel="stylesheet" href="${root}site.css">
<script>${THEME_JS}</script>
</head>
<body>
<header id="topbar">
  <a id="brand" href="${root}index.html"><b>ef</b></a>
  <span class="spacer"></span>
  ${THEME_BTN}
  <a id="src-link" href="https://github.com/rprtr258/lish" title="source repository" aria-label="source repository"><svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg></a>
</header>
<div id="page">
${renderNav(page, root, overview, sections)}
<main id="content">
${body}
</main>
</div>
</body>
</html>
`;
}

// --- build -------------------------------------------------------------------

export async function build(): Promise<{pages: Page[], html: Map<string, string>}> {
  const overview = await loadDir("");       // content/index.md — the site root
  const sections = overview.children ?? []; // top-level directories; their label titles the nav group
  const all = flat(overview);

  const tokens = await studioTokens();
  const siteCss = `${tokens}\n\n${await readFile(here("site.css"), "utf8")}`;

  rmSync(dist, {recursive: true, force: true});
  mkdirSync(dist, {recursive: true});
  writeFileSync(join(dist, "site.css"), siteCss);

  const out = new Map<string, string>();
  for (const page of all) {
    slugCounts.clear();
    const body = rewriteLinks(await marked.parse(page.md));
    const html = renderPage(page, body, overview, sections);
    mkdirSync(dirname(join(dist, outPath(page))), {recursive: true});
    writeFileSync(join(dist, outPath(page)), html);
    out.set(page.file, html);
  }
  console.log(`built docs → ${dist} (${all.length} pages)`);
  return {pages: all, html: out};
}

if (import.meta.main) {
  await build();
}
