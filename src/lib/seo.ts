// The URL this site is actually served from. Kept here rather than read from
// astro.config `site`, which these hand-built demos either never set or set to
// a stale preview host.
export const SITE_URL = "https://something-social.webtag.co.nz";

// The real routes, read off src/pages at build time, so sitemap.xml cannot
// drift from the pages that exist. Lazy glob: Vite gives us the keys without
// importing (and running) a single page component.
const PAGE_FILES = import.meta.glob("../pages/**/*.astro");

export const pagePaths = (): string[] =>
  Object.keys(PAGE_FILES)
    .map((f) => f.replace("../pages", "").replace(/\/index\.astro$/, "").replace(/\.astro$/, "") || "/")
    .filter((p) => !p.includes("[") && p !== "/404")
    .sort((a, b) => (a === "/" ? -1 : b === "/" ? 1 : a.localeCompare(b)));
