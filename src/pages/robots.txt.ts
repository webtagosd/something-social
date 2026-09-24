import type { APIRoute } from "astro";
import { SITE_URL, INDEXABLE } from "../lib/seo";

// One `User-agent: *` Allow covers GPTBot, ClaudeBot, PerplexityBot and the
// rest. Do not add per-bot Disallow lines: blocking them is how a site
// disappears from AI answers.
export const GET: APIRoute = () =>
  new Response(
    INDEXABLE
      ? `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`
      : `User-agent: *\nDisallow: /\n`, {
    headers: { "Content-Type": "text/plain" },
  });
