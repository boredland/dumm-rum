import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { findStopBySlug, type KnownStop } from "../../../lib/queries.ts";

const resolveStation = createServerFn({ method: "GET" })
	.inputValidator((slug: unknown): string => {
		if (typeof slug !== "string" || slug.length === 0) {
			throw new Error("invalid slug");
		}
		return slug;
	})
	.handler(async ({ data: slug }): Promise<KnownStop> => {
		const stop = await findStopBySlug(slug);
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
