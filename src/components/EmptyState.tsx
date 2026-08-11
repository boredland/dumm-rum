/**
 * Absence of data is a fact the report states, not an event that needs a
 * placard. One line of type between rules, in the same voice as the rest
 * of the page.
 */

export function EmptyState({
	title,
	hint,
	action,
}: {
	title: string;
	hint?: string;
	action?: { label: string; onClick: () => void };
}) {
	return (
		<div className="border-y border-rule py-8 text-center space-y-2">
			<p className="text-lead">{title}</p>
			{hint && <p className="text-meta text-muted">{hint}</p>}
			{action && (
				<button
					type="button"
					onClick={action.onClick}
					className="text-meta underline underline-offset-4 decoration-rule hover:decoration-current"
				>
					{action.label}
				</button>
			)}
		</div>
	);
}
