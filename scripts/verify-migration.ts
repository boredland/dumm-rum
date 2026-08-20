/** Applies every migration to a throwaway database and prints the resulting
 * journey_stops shape. Used to check a fresh database converges on the same
 * schema production ends up with. */
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const conn = postgres(url, { max: 1 });
try {
	await migrate(drizzle({ client: conn }), { migrationsFolder: "./drizzle" });
	console.log("migrations applied");

	const cols = await conn`
		SELECT column_name, data_type, is_nullable
		FROM information_schema.columns
		WHERE table_name = 'journey_stops' ORDER BY ordinal_position
	`;
	console.log("\njourney_stops columns:");
	for (const c of cols)
		console.log(`  ${c.column_name} ${c.data_type} null=${c.is_nullable}`);

	const idx = await conn`
		SELECT indexname, indexdef FROM pg_indexes
		WHERE tablename = 'journey_stops' ORDER BY indexname
	`;
	console.log("\njourney_stops indexes:");
	for (const i of idx) console.log(`  ${i.indexname}`);
} finally {
	await conn.end({ timeout: 5 });
}
