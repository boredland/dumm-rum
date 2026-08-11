import type { ReactNode } from "react";

interface Props {
	backLink: ReactNode;
	title: ReactNode;
	action?: ReactNode;
	children?: ReactNode;
}

/** Entity page masthead. A rule under the title does the work the old
 * black panel was doing, so the name of the thing stays the loudest
 * element on the page. */
export function PageHeader({ backLink, title, action, children }: Props) {
	return (
		<header className="space-y-4">
			<div className="text-micro uppercase tracking-[0.08em] text-muted">
				{backLink}
			</div>
			<div className="border-b border-ink pb-4 flex items-start justify-between gap-6">
				{/* min-w-0 so a long subtitle wraps inside the column instead of
				    pushing the action below it. */}
				<div className="min-w-0 space-y-1">
					<h1 className="text-h1 font-bold">{title}</h1>
					{children && (
						<div className="text-meta text-muted space-y-0.5">{children}</div>
					)}
				</div>
				{action}
			</div>
		</header>
	);
}

export function BackLink({ children }: { children: ReactNode }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-muted hover:text-ink transition-colors">
			<span aria-hidden>←</span>
			{children}
		</span>
	);
}

export function AlertButton({
	label,
	onClick,
}: {
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="shrink-0 border border-ink px-3 py-1.5 text-meta hover:bg-ink hover:text-paper transition-colors"
		>
			{label}
		</button>
	);
}
