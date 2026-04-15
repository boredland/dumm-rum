import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { count } from "drizzle-orm";
import { db } from "../../db/client.ts";
import { journeyRuns } from "../../db/schema.ts";
import { type Lang, t } from "../../lib/i18n.ts";

const getJourneyCount = createServerFn({ method: "GET" }).handler(async () => {
	const [row] = await db.select({ n: count() }).from(journeyRuns);
	return { journeyCount: row?.n ?? 0, at: new Date().toISOString() };
});

export const Route = createFileRoute("/$lang/")({
	loader: async () => await getJourneyCount(),
	component: Index,
});

function Index() {
	const { journeyCount, at } = Route.useLoaderData();
	const { lang } = Route.useParams();
	const l = lang as Lang;
	const other: Lang = l === "de" ? "en" : "de";

	return (
		<main style={{ padding: "2rem" }}>
			<h1>{t(l, "home.title")}</h1>
			<p>{t(l, "home.subtitle")}</p>
			<p>
				<strong>{journeyCount}</strong> {t(l, "stat.departures")}
			</p>
			<p style={{ color: "var(--muted)", fontSize: "0.875rem" }}>
				{t(l, "station.last_updated")}: {at}
			</p>
			<p>
				<Link to="/$lang/map" params={{ lang: l }}>
					{t(l, "map.title")} →
				</Link>
			</p>
			<p>
				<Link to="/$lang" params={{ lang: other }}>
					{other.toUpperCase()}
				</Link>
			</p>
		</main>
	);
}
