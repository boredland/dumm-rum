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
	const ledColor =
		tone === "danger"
			? "led-text-danger"
			: tone === "info"
				? "led-text-info"
				: "led-text-ok";
	return (
		<div className="signage-frame p-1.5 active:translate-y-px transition-transform">
			<div className="led-display">
				<div className="text-micro uppercase font-black text-muted/80 mb-1 border-b border-white/5 pb-1">
					{label}
				</div>
				<div
					className={`text-h2 font-black tabular-nums ${ledColor} tracking-tighter`}
				>
					{value}
				</div>
			</div>
		</div>
	);
}
