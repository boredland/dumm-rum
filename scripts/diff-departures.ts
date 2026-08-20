/** Compares getStopDayDepartures output between a legacy-shaped database and
 * a migrated one, to prove the surrogate-key swap is behaviour-preserving.
 *
 * Runs the legacy query as raw SQL (the old journey_ref join) and the new one
 * through the current query layer, then diffs row for row. */
import postgres from "postgres";

const legacyUrl = process.env.LEGACY_URL;
const newUrl = process.env.NEW_URL;
if (!legacyUrl || !newUrl) throw new Error("LEGACY_URL and NEW_URL required");

const legacy = postgres(legacyUrl, { max: 1 });
const migrated = postgres(newUrl, { max: 1 });

const LEGACY_SQL = `
	SELECT js.journey_ref, js.route_idx, js.day_of_operation,
		COALESCE(js.dep_time, js.arr_time) AS time,
		COALESCE(js.rt_dep_time, js.rt_arr_time) AS rt_time,
		jr.dest_name AS direction, js.cancelled
	FROM journey_stops js
	JOIN journey_runs jr
		ON jr.journey_ref = js.journey_ref
		AND jr.day_of_operation = js.day_of_operation
	WHERE js.day_of_operation = $1
	ORDER BY time, jr.line, js.journey_ref, js.route_idx
`;

const NEW_SQL = `
	SELECT jr.journey_ref, js.route_idx, js.day_of_operation,
		COALESCE(js.dep_time, js.arr_time) AS time,
		COALESCE(js.rt_dep_time, js.rt_arr_time) AS rt_time,
		jr.dest_name AS direction, js.cancelled
	FROM journey_stops js
	JOIN journey_runs jr ON jr.run_id = js.run_id
	WHERE js.day_of_operation = $1
	ORDER BY time, jr.line, jr.journey_ref, js.route_idx
`;

const day = process.argv[2] ?? "2026-08-12";
try {
	const a = await legacy.unsafe(LEGACY_SQL, [day]);
	const b = await migrated.unsafe(NEW_SQL, [day]);

	console.log(`legacy rows: ${a.length}`);
	console.log(`migrated rows: ${b.length}`);
	if (a.length !== b.length) {
		console.log("MISMATCH: row counts differ");
		process.exit(1);
	}

	let diffs = 0;
	for (let i = 0; i < a.length; i++) {
		const x = JSON.stringify(a[i]);
		const y = JSON.stringify(b[i]);
		if (x !== y) {
			if (diffs < 3) console.log(`row ${i}:\n  legacy ${x}\n  new    ${y}`);
			diffs++;
		}
	}
	console.log(
		diffs === 0 ? "IDENTICAL" : `MISMATCH: ${diffs} differing row(s)`,
	);
	process.exit(diffs === 0 ? 0 : 1);
} finally {
	await legacy.end({ timeout: 5 });
	await migrated.end({ timeout: 5 });
}
