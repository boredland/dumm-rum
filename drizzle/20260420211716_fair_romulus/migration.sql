ALTER TABLE "journey_stops" ADD COLUMN "delay_min" double precision GENERATED ALWAYS AS (COALESCE(
				CASE WHEN rt_dep_time IS NOT NULL AND dep_time IS NOT NULL THEN
					(split_part(rt_dep_time, ':', 1)::int * 60 + split_part(rt_dep_time, ':', 2)::int + split_part(rt_dep_time, ':', 3)::int / 60.0)
					- (split_part(dep_time, ':', 1)::int * 60 + split_part(dep_time, ':', 2)::int + split_part(dep_time, ':', 3)::int / 60.0)
				END,
				CASE WHEN rt_arr_time IS NOT NULL AND arr_time IS NOT NULL THEN
					(split_part(rt_arr_time, ':', 1)::int * 60 + split_part(rt_arr_time, ':', 2)::int + split_part(rt_arr_time, ':', 3)::int / 60.0)
					- (split_part(arr_time, ':', 1)::int * 60 + split_part(arr_time, ':', 2)::int + split_part(arr_time, ':', 3)::int / 60.0)
				END
			)) STORED;--> statement-breakpoint
CREATE INDEX "idx_journey_stops_delay_min" ON "journey_stops" ("journey_ref","day_of_operation") WHERE "delay_min" >= 7.5;