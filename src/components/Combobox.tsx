import {
	type KeyboardEvent,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";

export interface ComboboxProps {
	value: string;
	onChange: (next: string) => void;
	/** Full picklist; filtering happens client-side. */
	options: readonly string[];
	placeholder?: string;
	className?: string;
	/** Max rows shown at once — keeps the popover bounded when the picklist
	 * is thousands of stops long. */
	maxResults?: number;
	disabled?: boolean;
	ariaLabel?: string;
	/** Strict mode: only values from `options` are committed. Typed text
	 * filters the popup but never lands in `onChange` directly — you have
	 * to pick a row (Enter / click). On blur or Escape the query resets to
	 * the last valid value. The input border goes red when the query
	 * doesn't match anything so the user sees why pressing Enter or
	 * tabbing away revert their text. */
	strict?: boolean;
}

function normalize(s: string): string {
	return s
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
}

/** Rank exact-prefix → word-boundary → substring so "S6" lands above "S60"
 * and "Main Hbf" lands above "Klein-Hbf-Main". */
function scoreMatch(option: string, needle: string): number {
	if (!needle) return 0;
	const o = normalize(option);
	const n = normalize(needle);
	if (o === n) return 0;
	if (o.startsWith(n)) return 1;
	if (new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(o))
		return 2;
	const i = o.indexOf(n);
	return i >= 0 ? 3 + i / 1000 : Number.POSITIVE_INFINITY;
}

export function Combobox({
	value,
	onChange,
	options,
	placeholder,
	className,
	maxResults = 50,
	disabled,
	ariaLabel,
	strict,
}: ComboboxProps) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState(value);
	const [activeIdx, setActiveIdx] = useState(0);
	const rootRef = useRef<HTMLDivElement>(null);
	const listId = useId();

	useEffect(() => {
		setQuery(value);
	}, [value]);

	const filtered = useMemo(() => {
		const q = query.trim();
		if (!q) return options.slice(0, maxResults);
		const scored: { o: string; s: number }[] = [];
		for (const o of options) {
			const s = scoreMatch(o, q);
			if (Number.isFinite(s)) scored.push({ o, s });
		}
		scored.sort((a, b) => a.s - b.s || a.o.localeCompare(b.o));
		return scored.slice(0, maxResults).map((x) => x.o);
	}, [options, query, maxResults]);

	const commit = useCallback(
		(next: string) => {
			onChange(next);
			setQuery(next);
			setOpen(false);
		},
		[onChange],
	);

	/** Roll the query back to the last valid value — used by Escape, blur,
	 * and clicks outside the component in strict mode. */
	const revert = useCallback(() => {
		setQuery(value);
		setOpen(false);
	}, [value]);

	const onKey = useCallback(
		(e: KeyboardEvent<HTMLInputElement>) => {
			if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
				setOpen(true);
				setActiveIdx(0);
				e.preventDefault();
				return;
			}
			if (!open) return;
			if (e.key === "ArrowDown") {
				setActiveIdx((i) => Math.min(filtered.length - 1, i + 1));
				e.preventDefault();
			} else if (e.key === "ArrowUp") {
				setActiveIdx((i) => Math.max(0, i - 1));
				e.preventDefault();
			} else if (e.key === "Enter") {
				const pick = filtered[activeIdx];
				if (pick) commit(pick);
				else if (strict) revert();
				else commit(query);
				e.preventDefault();
			} else if (e.key === "Escape") {
				if (strict) revert();
				else setOpen(false);
				e.preventDefault();
			} else if (e.key === "Tab") {
				if (strict) revert();
				else setOpen(false);
			}
		},
		[activeIdx, commit, filtered, open, query, revert, strict],
	);

	// Click-outside to dismiss. In strict mode this also rolls the query
	// back to the last valid value so a user who typed garbage and clicked
	// away doesn't leave the input showing that garbage.
	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (rootRef.current?.contains(e.target as Node)) return;
			if (strict) revert();
			else setOpen(false);
		};
		window.addEventListener("mousedown", handler);
		return () => window.removeEventListener("mousedown", handler);
	}, [open, revert, strict]);

	// Reset highlight whenever the filter result set changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on new result set, not on every re-render
	useEffect(() => {
		setActiveIdx(0);
	}, [filtered.length, filtered[0]]);

	const strictInvalid =
		strict && query.trim().length > 0 && !options.some((o) => o === query);

	return (
		<div ref={rootRef} className={`relative ${className ?? ""}`}>
			<input
				type="text"
				role="combobox"
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-label={ariaLabel}
				aria-invalid={strictInvalid || undefined}
				className={`w-full bg-surface border rounded px-2 py-1.5 text-sm text-fg ${
					strictInvalid ? "border-red-500" : "border-border"
				}`}
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					if (!strict) onChange(e.target.value);
					setOpen(true);
				}}
				onFocus={() => !disabled && setOpen(true)}
				onBlur={() => {
					if (strict) {
						// Delay so a click on a list row gets a chance to
						// commit before we revert.
						setTimeout(() => {
							if (!options.some((o) => o === query)) revert();
						}, 0);
					}
				}}
				onKeyDown={onKey}
				placeholder={placeholder}
				disabled={disabled}
			/>
			{open && filtered.length > 0 && (
				<div
					id={listId}
					role="listbox"
					className="absolute z-10 mt-1 left-0 right-0 max-h-60 overflow-y-auto bg-surface border border-border rounded shadow-lg"
				>
					{filtered.map((opt, i) => (
						<div
							key={opt}
							role="option"
							tabIndex={-1}
							aria-selected={i === activeIdx}
							className={`px-2 py-1 text-sm cursor-pointer ${
								i === activeIdx
									? "bg-accent/15 text-fg"
									: "text-fg hover:bg-accent/10"
							}`}
							onMouseDown={(e) => {
								e.preventDefault();
								commit(opt);
							}}
							onMouseEnter={() => setActiveIdx(i)}
						>
							{opt}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
