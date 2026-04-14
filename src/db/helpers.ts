import type { GetColumnData, SQL } from "drizzle-orm";
import { getTableColumns, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

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

const D1_MAX_PARAMS = 100;

export function d1BatchSize(table: SQLiteTable): number {
	const colCount = Object.keys(getTableColumns(table)).length;
	return Math.max(1, Math.floor(D1_MAX_PARAMS / colCount));
}

export function sqlIdList(ids: string[]) {
	return sql.join(
		ids.map((id) => sql`${id}`),
		sql`, `,
	);
}
