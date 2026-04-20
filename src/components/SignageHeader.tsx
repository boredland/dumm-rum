import type { ReactNode } from "react";

interface Props {
	backLink: ReactNode;
	title: ReactNode;
	action?: ReactNode;
	children?: ReactNode;
}

export function SignageHeader({ backLink, title, action, children }: Props) {
	return (
		<header className="signage-frame p-3 space-y-2">
			<div className="text-meta uppercase font-black tracking-widest text-muted">
				{backLink}
			</div>
			<div className="flex items-center justify-between gap-3 flex-wrap">
				<h1 className="text-h1 font-black tracking-tighter flex items-center gap-2 text-white">
					{title}
				</h1>
				{action}
			</div>
			{children && (
				<div className="text-meta text-muted space-y-0.5">{children}</div>
			)}
		</header>
	);
}

export function BackLink({
	children,
	className = "",
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<span
			className={`inline-flex items-center gap-1 hover:text-white transition-colors ${className}`}
		>
			<svg
				aria-hidden
				className="h-3 w-3"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="3"
				strokeLinecap="square"
			>
				<title>back</title>
				<path d="M15 18l-6-6 6-6" />
			</svg>
			{children}
		</span>
	);
}

export function SubscribeButton({
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
			className="rounded-full bg-platform-yellow text-black font-black uppercase tracking-wider px-4 py-2 text-meta active:translate-y-px transition-transform cursor-pointer shrink-0"
		>
			{label}
		</button>
	);
}
