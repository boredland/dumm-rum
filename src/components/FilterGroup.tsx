import { Link, type LinkProps } from "@tanstack/react-router";
import { pillClass } from "./Pill.tsx";

interface FilterOption<T> {
	key: T;
	label: string;
}

export interface FilterGroupProps<T> {
	options: FilterOption<T>[];
	selected: T | T[] | undefined;
	onToggle?: (key: T) => void;
	showClearButton?: boolean;
	onClear?: () => void;
	clearLabel?: string;
	/** Optional Link props for router-based filters. If provided, buttons render as links instead. */
	linkProps?: (key: T, active: boolean) => Omit<LinkProps, "children">;
}

/**
 * Unified filter control for toggle-based selections (days, categories, etc).
 * Renders as buttons (client-controlled) or Links (router-controlled) depending on linkProps.
 *
 * Multi-select: pass selected as array. Single-select: pass as scalar or undefined.
 */
export function FilterGroup<T extends string>({
	options,
	selected,
	onToggle,
	showClearButton,
	onClear,
	clearLabel,
	linkProps,
}: FilterGroupProps<T>) {
	const isMultiSelect = Array.isArray(selected);
	const isActive = (key: T): boolean => {
		if (isMultiSelect) return selected.includes(key);
		return selected === key;
	};

	return (
		<div className="flex flex-wrap gap-2">
			{options.map((option) => {
				const active = isActive(option.key);
				if (linkProps) {
					return (
						<Link
							key={option.key}
							{...linkProps(option.key, active)}
							className={pillClass(active)}
						>
							{option.label}
						</Link>
					);
				}
				return (
					<button
						key={option.key}
						type="button"
						aria-pressed={active}
						onClick={() => onToggle?.(option.key)}
						className={pillClass(active)}
					>
						{option.label}
					</button>
				);
			})}
			{showClearButton && selected && (
				<button type="button" onClick={onClear} className={pillClass(false)}>
					{clearLabel ?? (typeof selected === "string" ? "Clear" : "Clear all")}
				</button>
			)}
		</div>
	);
}
