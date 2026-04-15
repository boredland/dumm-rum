import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { count } from "drizzle-orm";
import { db } from "../db/client.ts";
import { journeyRuns } from "../db/schema.ts";

// Server function: runs only in the Nitro output, so the drizzle/postgres
// imports don't leak into the client bundle. Proves schema-sharing from
// the same codebase works.
const getJourneyCount = createServerFn({ method: "GET" }).handler(async () => {
	const [row] = await db.select({ n: count() }).from(journeyRuns);
	return { journeyCount: row?.n ?? 0, at: new Date().toISOString() };
});

export const Route = createFileRoute("/")({
	loader: async () => await getJourneyCount(),
	component: Index,
});

function Index() {
	const { journeyCount, at } = Route.useLoaderData();
	return (
		<main
			style={{
				fontFamily: "system-ui, sans-serif",
				padding: "2rem",
				lineHeight: 1.5,
			}}
		>
			<h1>ingest up</h1>
			<p>
				<strong>{journeyCount}</strong> journey_runs in the DB
			</p>
			<p style={{ color: "#666", fontSize: "0.875rem" }}>rendered at {at}</p>
		</main>
	);
}
