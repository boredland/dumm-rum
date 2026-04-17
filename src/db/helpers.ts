import type { GetColumnData, SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

export const excluded = <C extends PgColumn>(column: C) => {
	return sql.raw(`excluded."${column.name}"`) as SQL<GetColumnData<C>>;
};
