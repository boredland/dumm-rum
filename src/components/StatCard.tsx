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

/** Quiet hairline stat. Reliability tone is conveyed through the
 * value's colour, not a full LED panel — four LEDs in a row drowned
 * the actual numbers. The hero score on landing keeps the LED
 * treatment because it earns the signage moment. */
export function StatCard({
	label,
	value,
	tone,
}: {
	label: string;
	value: string;
	tone?: "danger" | "info";
}) {
	const valueColor =
		tone === "danger"
			? "text-danger"
			: tone === "info"
				? "text-info"
				: "text-fg";
	return (
		<div className="card p-3 flex flex-col gap-1">
			<div className="signage-label">{label}</div>
			<div
				className={`text-h2 font-black tabular-nums tracking-tighter ${valueColor}`}
			>
				{value}
			</div>
		</div>
	);
}
