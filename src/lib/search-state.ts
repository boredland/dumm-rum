/** Tiny helper for controlled filter state backed by URL search params.
 *
 * Used by route pages to hoist `useState` into `?key=value` search
 * params via TanStack Router's `navigate({ search, replace: true })`.
 * Returns a `[value, setter]` pair shaped like `useState`, ready to
 * pass into the `{ value, onChange }` options of `useDaysFilter` or
 * `useDepartureFilters`. When the value equals the default, the key is
 * dropped from the URL so clean URLs stay clean.
 */
export function urlFilter<T extends string>(
	current: string | undefined,
	fallback: T,
	allowed: readonly T[],
	setSearch: (patch: Record<string, string | undefined>) => void,
	key: string,
): [T, (v: T) => void] {
	const v = (allowed as readonly string[]).includes(current ?? "")
		? (current as T)
		: fallback;
	const set = (next: T) => {
		setSearch({ [key]: next === fallback ? undefined : next });
	};
	return [v, set];
}

/** Freeform-string variant (e.g. direction values picked from data).
 * `any` sentinel is dropped from the URL. */
export function urlStringFilter(
	current: string | undefined,
	fallback: string,
	setSearch: (patch: Record<string, string | undefined>) => void,
	key: string,
): [string, (v: string) => void] {
	const v = current ?? fallback;
	const set = (next: string) => {
		setSearch({ [key]: next === fallback ? undefined : next });
	};
	return [v, set];
}
