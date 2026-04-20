/**
 * Rounded-rectangle toggle chip used for every filter / day / status
 * selector in the app. Consolidates the three padding variants the
 * design audit flagged (`px-3 py-1.5`, `px-2.5 py-1`, `px-3 py-1`) so
 * identical affordances don't read as different controls.
 *
 * For callers that need a `<Link>` instead of a `<button>` (URL-driven
 * filters that want SPA navigation), compose with `pillClass` on the
 * link directly — one style source, two render modes, no type gymnastics.
 */

import type { ReactNode } from "react";

const BASE =
	"cursor-pointer rounded border border-border px-3 py-1.5 text-meta font-bold uppercase tracking-wider no-underline transition-[transform,box-shadow,background-color] duration-150 ease-out active:translate-y-px select-none";

/** Returns the className string for a pill in the given state. Use on
 * router `<Link>`s and other non-button triggers. */
export function pillClass(active: boolean): string {
	const state = active
		? "bg-accent !text-white border-accent shadow-sm"
		: "bg-surface-hover text-muted hover:text-fg surface-backlit";
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
