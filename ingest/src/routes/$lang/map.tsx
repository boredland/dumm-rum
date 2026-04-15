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
		<main
			style={{
				padding: "1rem",
				maxWidth: 1200,
				margin: "0 auto",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					marginBottom: "1rem",
				}}
			>
				<Link
					to="/$lang"
					params={{ lang: l }}
					style={{
						color: "var(--muted)",
						fontSize: "0.875rem",
					}}
				>
					← {t(l, "nav.back")}
				</Link>
				<h1 style={{ margin: 0, fontSize: "1.5rem" }}>{t(l, "map.title")}</h1>
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

			<footer
				style={{
					marginTop: "1rem",
					paddingTop: "1rem",
					borderTop: "1px solid var(--border-dim)",
					fontSize: "0.75rem",
					color: "var(--dimmed)",
					display: "flex",
					alignItems: "center",
					gap: "0.75rem",
				}}
			>
				<a
					href="https://www.rmv.de"
					style={{ display: "inline-flex", flexShrink: 0 }}
				>
					<img
						src="/rmv-logo.svg"
						alt="RMV"
						width={74}
						height={15}
						style={{ opacity: 0.6 }}
					/>
				</a>
				<span>{l === "de" ? "Datenquelle: RMV" : "Data source: RMV"}</span>
			</footer>
		</main>
	);
}
