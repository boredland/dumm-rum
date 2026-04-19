/**
 * Shared empty-state block. Replaces the bare `text-dimmed` paragraphs
 * scattered across `no_departures` / `no_data` branches — those read as
 * errors instead of "we found nothing, which is fine". Keeps the
 * contents quiet and helpful: a small icon, one-line headline, an
 * optional action button (typically "reset filters").
 */

import type { ReactNode } from "react";

export function EmptyState({
	icon,
	title,
	hint,
	action,
}: {
	/** Unicode / emoji glyph rendered large. Kept as a string rather
	 * than an SVG slot so the call sites stay one-liners and match the
	 * app's existing emoji-forward iconography (🚏, 👻, 📱). */
	icon: string;
	title: string;
	hint?: string;
	action?: { label: string; onClick: () => void };
}) {
	return (
		<div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-dim bg-surface/50 px-6 py-10 text-center">
			<div aria-hidden className="text-[28px] leading-none opacity-70">
				{icon}
			</div>
			<p className="text-body font-medium text-muted">{title}</p>
			{hint && <p className="text-meta text-dimmed">{hint}</p>}
			{action && (
				<button
					type="button"
					onClick={action.onClick}
					className="mt-1 cursor-pointer rounded-full border border-border px-3 py-1.5 text-meta font-medium text-fg transition-colors hover:bg-surface-hover"
				>
					{action.label}
				</button>
			)}
		</div>
	);
}
