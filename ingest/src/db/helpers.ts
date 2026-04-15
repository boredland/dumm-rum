import type { GetColumnData, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

type SqlOrColumn = SQL | PgColumn;

export const excluded = <C extends PgColumn>(column: C) => {
	return sql.raw(`excluded."${column.name}"`) as SQL<GetColumnData<C>>;
};

export function coalesce<T>(...args: SqlOrColumn[]) {
	return sql<T>`COALESCE(${sql.join(
		args.map((a) => sql`${a}`),
		sql.raw(","),
	)})`;
}
