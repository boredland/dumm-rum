/**
 * Filter toggle. The active option is set in ink, weighted, and carries a
 * rule beneath it; the rest stay muted and unweighted. Filters are
 * navigation, not content, so they get the least ink on the page that
 * still reads as a control — but the selected one has to be legible at a
 * glance, which a hairline underline was not.
 *
 * The active state is deliberately over-specified (colour AND weight AND
 * the rule). styles.css sets `a { color: inherit }` for content links,
 * which ties with Tailwind's `text-muted` on specificity and won by order,
 * so every link-rendered filter came out full ink and only the underline
 * distinguished the selected one. The `!` prefixes settle that tie.
 *
 * For callers that need a `<Link>` instead of a `<button>` (URL-driven
 * filters that want SPA navigation), compose with `pillClass` on the link
 * directly — one style source, two render modes.
 */

import type { ReactNode } from "react";

const BASE =
	"cursor-pointer text-meta whitespace-nowrap transition-colors no-underline";

/** Returns the className string for a filter toggle in the given state. */
export function pillClass(active: boolean): string {
	// border-b rather than `underline`: BASE has to keep `no-underline` for
	// the link case, and the two set the same property, so the winner came
	// down to stylesheet order. A border is independent of that, and sits
	// clear of descenders instead of striking through them.
	//
	// `!font-medium` for the same reason as `!text-ink`: styles.css sets
	// `button { font: inherit }`, and that shorthand resets font-weight, so
	// a plain `font-medium` lost on the button-rendered filters while
	// working on the link-rendered ones.
	const state = active
		? "!text-ink !font-medium border-b-2 border-ink pb-0.5"
		: "!text-muted hover:!text-ink border-b-2 border-transparent pb-0.5";
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
