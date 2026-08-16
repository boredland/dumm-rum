/**
 * Pure journey poll hard-cap calculation helper used by the poller
 * (see `src/lib/poll.ts`).
 *
 * Kept in a standalone DB-free module so it can be imported and tested
 * without requiring a DATABASE_URL connection.
 */

import { berlinTime, nowBerlin } from "./utils.ts";

export function isHardCapReached(
	originDep?: string,
	destArr?: string,
	dayOfOp?: string,
): boolean {
	if (!destArr || !dayOfOp) return false;
	let arr = berlinTime(dayOfOp, destArr);
	const dep = originDep ? berlinTime(dayOfOp, originDep) : undefined;
	// HAFAS stamps both times with the service date; a wrapped arrival
	// belongs to the following calendar day.
	if (dep && arr.isBefore(dep)) {
		arr = arr.add(1, "day");
	}
	const durationMin = dep ? arr.diff(dep, "minute") : 0;
	const buffer = Math.max(durationMin, 15);
	return nowBerlin().isAfter(arr.add(buffer, "minute"));
}
