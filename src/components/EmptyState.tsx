/**
 * Hazard-placard empty state. Yellow-black tactile stripe above and below,
 * concrete-dark middle with the icon + title treated like an "OUT OF
 * SERVICE" sign. Callers supply the voice via `title`; keep it short and
 * signage-like ("Keine Abfahrten", "No departures").
 */

export function EmptyState({
	icon,
	title,
	hint,
	action,
}: {
	icon: string;
	title: string;
	hint?: string;
	action?: { label: string; onClick: () => void };
}) {
	return (
		<div className="overflow-hidden rounded-sm">
			<div className="platform-yellow-line h-1.5" />
			<div className="bg-signage px-6 py-8 text-center space-y-2">
				<div aria-hidden className="text-[28px] leading-none opacity-60">
					{icon}
				</div>
				<p className="text-h2 font-black uppercase tracking-widest text-white/80">
					{title}
				</p>
				{hint && (
					<p className="text-meta uppercase tracking-wider text-white/40">
						{hint}
					</p>
				)}
				{action && (
					<button
						type="button"
						onClick={action.onClick}
						className="mt-3 cursor-pointer rounded-full bg-platform-yellow text-black font-black uppercase tracking-wider px-4 py-2 text-meta active:translate-y-px transition-transform"
					>
						{action.label}
					</button>
				)}
			</div>
			<div className="platform-yellow-line h-1.5" />
		</div>
	);
}
