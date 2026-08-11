/**
 * Filter toggle. The active option is set in ink and underlined; the rest
 * stay muted. Filters are navigation, not content, so they get the least
 * ink on the page that still reads as a control.
 *
 * For callers that need a `<Link>` instead of a `<button>` (URL-driven
 * filters that want SPA navigation), compose with `pillClass` on the link
 * directly — one style source, two render modes.
 */

import type { ReactNode } from "react";

const BASE =
	"cursor-pointer text-meta no-underline whitespace-nowrap transition-colors decoration-1 underline-offset-4";

/** Returns the className string for a filter toggle in the given state. */
export function pillClass(active: boolean): string {
	const state = active
		? "text-ink underline"
		: "text-muted hover:text-ink no-underline";
	return `${BASE} ${state}`;
}

export function Pill({
	active,
	onClick,
	title,
	children,
}: {
	active: boolean;
	onClick?: () => void;
	title?: string;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			aria-pressed={active}
			className={pillClass(active)}
		>
			{children}
		</button>
	);
}
