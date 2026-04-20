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
		tone === "danger" ? "led-text-danger" : tone === "info" ? "led-text-info" : "led-text-ok";
	return (
		<div className="signage-frame p-1.5 active:scale-[0.98] transition-transform">
			<div className="px-2 py-1 flex items-center justify-between">
				<span className="text-[9px] uppercase font-black tracking-tighter text-muted/60">
					System Status
				</span>
				<div className="flex gap-1">
					<div className="w-1 h-1 rounded-full bg-red-900/50" />
					<div className="w-1 h-1 rounded-full bg-green-500/50 shadow-[0_0_2px_rgba(34,197,94,0.5)]" />
				</div>
			</div>
			<div className="led-display">
				<div className="text-[10px] uppercase font-bold text-muted/80 tracking-widest mb-1 border-b border-white/5 pb-1">
					{label}
				</div>
				<div className={`text-2xl font-black tabular-nums ${ledColor} tracking-tighter`}>
					{value}
				</div>
			</div>
		</div>
	);
}
