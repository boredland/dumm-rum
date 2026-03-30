import type { GetColumnData, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

type SqlOrColumn = SQL | SQLiteColumn;

export const excluded = <C extends SQLiteColumn>(column: C) => {
	return sql.raw(`excluded."${column.name}"`) as SQL<GetColumnData<C>>;
};

export function coalesce<T>(...args: SqlOrColumn[]) {
	return sql<T>`COALESCE(${sql.join(
		args.map((a) => sql`${a}`),
		sql.raw(","),
	)})`;
}

export function max<T>(...args: SqlOrColumn[]) {
	return sql<T>`MAX(${sql.join(
		args.map((a) => sql`${a}`),
		sql.raw(","),
	)})`;
}
