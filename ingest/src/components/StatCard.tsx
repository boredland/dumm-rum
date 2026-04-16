export function borderForScore(score: number): string {
	if (score < 80) return "border-red-500";
	if (score < 90) return "border-amber-500";
	return "border-emerald-500";
}

export function borderForCancRate(rate: number): string {
	if (rate > 0.1) return "border-red-500";
	if (rate > 0.05) return "border-amber-500";
	return "border-emerald-500";
}

export function StatCard({
	label,
	value,
	tone,
}: {
	label: string;
	value: string;
	tone?: "danger" | "purple";
}) {
	const color =
		tone === "danger"
			? "text-red-500"
			: tone === "purple"
				? "text-purple-400"
				: "";
	return (
		<div className="bg-surface border border-border rounded-xl p-4">
			<div className="text-[0.7rem] uppercase tracking-wide text-muted mb-1">
				{label}
			</div>
			<div className={`text-2xl font-bold tabular-nums ${color}`}>{value}</div>
		</div>
	);
}
