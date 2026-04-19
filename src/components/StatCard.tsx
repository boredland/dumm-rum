/**
 * Re-export the score/rate helpers from their canonical home in
 * `src/lib/status.ts`. Kept here so the existing `import { borderForScore }
 * from ".../StatCard"` sites in the routes don't all have to churn at once.
 */
export {
	borderForCancRate,
	borderForScore,
	textForScore,
} from "../lib/status.ts";

export function StatCard({
	label,
	value,
	tone,
}: {
	label: string;
	value: string;
	tone?: "danger" | "info";
}) {
	const color =
		tone === "danger" ? "text-danger" : tone === "info" ? "text-info" : "";
	return (
		<div className="bg-surface border border-border rounded-xl p-4">
			<div className="text-meta uppercase text-muted mb-1">{label}</div>
			<div className={`text-h2 font-bold tabular-nums ${color}`}>{value}</div>
		</div>
	);
}
