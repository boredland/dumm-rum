import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { findStopBySlug, type KnownStop } from "../../../lib/queries.ts";
import { makeSwr } from "../../../lib/swr.ts";

const stopSwr = makeSwr<KnownStop | null>(findStopBySlug, {
	freshMs: 5 * 60_000,
	staleMs: 60 * 60_000,
});

const resolveStation = createServerFn({ method: "GET" })
	.inputValidator((slug: unknown): string => {
		if (typeof slug !== "string" || slug.length === 0) {
			throw new Error("invalid slug");
		}
		return slug;
	})
	.handler(async ({ data: slug }): Promise<KnownStop> => {
		setResponseHeader(
			"Cache-Control",
			"public, max-age=300, s-maxage=3600, stale-while-revalidate=3600",
		);
		const stop = await stopSwr.get(slug);
		if (!stop) throw notFound();
		return stop;
	});

export const Route = createFileRoute("/$lang/$station")({
	loader: async ({ params }) => await resolveStation({ data: params.station }),
	component: StationLayout,
});

function StationLayout() {
	return <Outlet />;
}
