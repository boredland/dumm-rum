import { createFileRoute } from "@tanstack/react-router";
import { SITE_ORIGIN } from "../lib/seo.ts";

/** Served from the app rather than `public/` so the sitemap URL and the
 * origin stay tied to `SITE_ORIGIN` — a robots.txt naming a stale host is
 * worse than none.
 *
 * The per-day departure lists carry `noindex` in their own head instead of
 * a `Disallow` here: a disallowed URL can still be indexed from an inbound
 * link, and a crawler that never fetches it never sees the directive. */
const BODY = `User-agent: *
Allow: /

Sitemap: ${SITE_ORIGIN}/sitemap.xml
`;

export const Route = createFileRoute("/robots.txt")({
	server: {
		handlers: {
			GET: async () =>
				new Response(BODY, {
					headers: {
						"Content-Type": "text/plain; charset=utf-8",
						"Cache-Control": "public, max-age=86400",
					},
				}),
		},
	},
});
