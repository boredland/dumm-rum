import { createFileRoute, Link } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { LiveMapView } from "../../components/LiveMapView.tsx";
import { type Lang, t } from "../../lib/i18n.ts";
import { getLiveMap } from "../../lib/liveMap.ts";

const fetchLiveMap = createServerFn({ method: "GET" }).handler(async () => {
	return await getLiveMap();
});

export const Route = createFileRoute("/$lang/map")({
	loader: async () => await fetchLiveMap(),
	component: MapPage,
});

function MapPage() {
	const payload = Route.useLoaderData();
	const { lang } = Route.useParams();
	const l = lang as Lang;

	return (
		<main className="mx-auto max-w-[1200px] p-4">
			<div className="mb-4 flex items-center justify-between">
				<Link
					to="/$lang"
					params={{ lang: l }}
					className="text-sm text-muted hover:text-fg"
				>
					← {t(l, "nav.back")}
				</Link>
				<h1 className="m-0 text-2xl font-semibold">{t(l, "map.title")}</h1>
			</div>

			<LiveMapView
				initial={payload}
				lang={l}
				texts={{
					vehicles: t(l, "map.vehicles"),
					noVehicles: t(l, "map.no_vehicles"),
					lastUpdate: t(l, "map.last_update"),
					filterAll: t(l, "filter.all"),
				}}
				onRefresh={fetchLiveMap}
			/>

			<footer className="mt-4 pt-4 border-t border-border-dim flex items-center gap-3 text-xs text-dimmed">
				<a href="https://www.rmv.de" className="inline-flex shrink-0">
					<img
						src="/rmv-logo.svg"
						alt="RMV"
						width={74}
						height={15}
						className="opacity-60 hover:opacity-100 transition-opacity"
					/>
				</a>
				<span>{l === "de" ? "Datenquelle: RMV" : "Data source: RMV"}</span>
			</footer>
		</main>
	);
}
