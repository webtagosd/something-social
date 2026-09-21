// Sanity check for the data-wt live-canvas bindings baked into the built site.
// Run after `npm run build` (walks dist/**/*.html, does not build anything
// itself). Exits non-zero on failure.
//
// Multi-page version of the standard template's check-wt-tags.mjs: instead of
// checking one dist/client/index.html, it walks every built page and
// validates data-wt keys against content/content.json in both directions:
//   1. forward — every data-wt="<key>" found in any page resolves to a real
//      path in content.json (catches typos / stale keys).
//   2. reverse — every leaf value in content.json is bound by a data-wt
//      somewhere across the site (catches content that was added but never
//      wired up). Exemptions ("where feasible"): site.*/seo.* are Base.astro
//      config/meta with no visual DOM element to bind to (same convention as
//      the reference template), and "" (empty string) leaves — an unset
//      optional field renders no element at all, so it can't be bound.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const distDir = join(root, "dist");
const content = JSON.parse(readFileSync(join(root, "content", "content.json"), "utf8"));

function walkHtmlFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkHtmlFiles(p));
    else if (entry.endsWith(".html")) out.push(p);
  }
  return out;
}

// Every dot-joined leaf path in content.json. Arrays are walked by index
// (matching the data-wt="list.0.field" convention editor-bridge.ts resolves).
function collectLeafPaths(obj, prefix = "") {
  const out = [];
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => out.push(...collectLeafPaths(v, prefix ? `${prefix}.${i}` : String(i))));
  } else if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      const next = prefix ? `${prefix}.${k}` : k;
      out.push(...collectLeafPaths(v, next));
    }
  } else {
    out.push({ path: prefix, value: obj });
    return out;
  }
  return out;
}

function getAtPath(obj, path) {
  return path.split(".").reduce((a, k) => (a == null ? a : a[Array.isArray(a) ? Number(k) : k]), obj);
}

let htmlFiles;
try {
  htmlFiles = walkHtmlFiles(distDir);
} catch (e) {
  console.error(`check-wt-tags: could not read ${distDir} — did you run \`npm run build\` first?`);
  console.error(e.message);
  process.exit(1);
}
if (htmlFiles.length === 0) {
  console.error(`check-wt-tags: no .html files found under ${distDir}`);
  process.exit(1);
}

const EXEMPT_PREFIXES = ["site.", "seo.", "analytics."];
// Exact keys that could not be bound without changing the design.
const EXEMPT_KEYS = new Set([
  // Meta-only field (schema help: "Short description used in meta tags"); no visible element renders it.
  "business.tagline",
  // Builds the tel: hrefs; tel links are never attr-bound, the visible business.phone.display text is.
  "business.phone.tel",
]);
// Alt-text fields are never data-wt-attr="alt" bound in this contract (same
// as the reference template's own <Image alt=...> usages) — alt text isn't a
// visually selectable canvas element, only src/href attrs are bound.
const ALT_SUFFIX_RE = /(^|\.)[a-zA-Z]*[Aa]lt$/;
const foundKeys = new Set();
let totalWtAttrs = 0;
let totalWtAttrSrc = 0;

for (const file of htmlFiles) {
  // Strip <script>...</script> bodies before scanning — the bundled
  // editor-bridge.ts JS itself contains the literal string data-wt="${...}"
  // (its own selector-building code), which is not an HTML attribute and
  // would otherwise show up as a false-positive orphan key.
  const html = readFileSync(file, "utf8").replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const matches = html.match(/data-wt="([^"]*)"/g) ?? [];
  totalWtAttrs += matches.length;
  totalWtAttrSrc += (html.match(/data-wt-attr="src"/g) ?? []).length;
  for (const m of matches) {
    const key = m.slice('data-wt="'.length, -1);
    if (key) foundKeys.add(key);
  }
}

// Forward: every data-wt key found must resolve in content.json.
const orphanKeys = [];
for (const key of foundKeys) {
  if (getAtPath(content, key) === undefined) orphanKeys.push(key);
}

// Reverse: every non-exempt, non-empty content.json leaf must be bound
// somewhere. List leaves are checked as a whole array path (e.g.
// "home.dishes") never bound directly — item-level paths ("home.dishes.0.name")
// are what's actually bound — so we only check scalar leaves here.
const unboundLeaves = [];
for (const { path, value } of collectLeafPaths(content)) {
  if (EXEMPT_PREFIXES.some((p) => path.startsWith(p))) continue;
  if (EXEMPT_KEYS.has(path)) continue;
  if (ALT_SUFFIX_RE.test(path)) continue;
  if (value === "" || value === null) continue;
  if (typeof value === "object") continue; // shouldn't happen (collectLeafPaths already flattens)
  if (!foundKeys.has(path)) unboundLeaves.push(path);
}

const checks = [
  ["≥100 data-wt attributes across the site", totalWtAttrs >= 100, `found ${totalWtAttrs}`],
  ["includes hero.headline binding", foundKeys.has("hero.headline"), null],
  ["includes an indexed list key", [...foundKeys].some((k) => /\.\d+\./.test(k)), null],
  ["includes a data-wt-attr=\"src\" binding", totalWtAttrSrc > 0, `found ${totalWtAttrSrc}`],
  ["no orphan data-wt keys (forward)", orphanKeys.length === 0, orphanKeys.length ? orphanKeys.slice(0, 20).join(", ") : null],
  ["no unbound content leaves (reverse)", unboundLeaves.length === 0, unboundLeaves.length ? unboundLeaves.slice(0, 20).join(", ") : null],
];

let failed = false;
console.log(`Scanned ${htmlFiles.length} page(s) under dist/: ${htmlFiles.map((f) => relative(distDir, f)).join(", ")}`);
for (const [label, pass, detail] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"} — ${label}${detail ? ` (${detail})` : ""}`);
  if (!pass) failed = true;
}

if (failed) {
  console.error("\ncheck-wt-tags: FAILED");
  process.exit(1);
}
console.log("\ncheck-wt-tags: all checks passed");
