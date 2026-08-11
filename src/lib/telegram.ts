import { and, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
	journeyRuns,
	journeyStops,
	telegramSubscriptions,
} from "../db/schema.ts";
import { DISPLAYED_CATEGORY, normalizedCategorySql } from "./queries.ts";
import {
	DELAY_THRESHOLD_MIN,
	nowBerlin,
	parseLineSlug,
	providerFromRef,
} from "./utils.ts";

interface TelegramUpdate {
	message?: {
		chat: { id: number };
		from?: { language_code?: string };
		text?: string;
	};
}

type Lang = "de" | "en";

function detectLang(code?: string): Lang {
	return code?.startsWith("de") ? "de" : "en";
}

const ALERT_LABELS: Record<
	Lang,
	{ title: string; cancelled: string; delay: string }
> = {
	de: {
		title: "DummRum Meldung",
		cancelled: "ausgefallen",
		delay: "Verspätung",
	},
	en: { title: "DummRum Alert", cancelled: "cancelled", delay: "delay" },
};

async function sendMessage(
	token: string,
	chatId: string | number,
	text: string,
) {
	const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
	});
	if (!res.ok) console.error(`Telegram API error: ${res.status}`);
}

const WEEKDAY_NAMES: Record<string, number> = {
	mo: 1,
	mon: 1,
	di: 2,
	tue: 2,
	mi: 3,
	wed: 3,
	do: 4,
	thu: 4,
	fr: 5,
	fri: 5,
	sa: 6,
	sat: 6,
	so: 0,
	sun: 0,
};

const DAY_NAMES = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];

function expandRange(from: number, to: number): number[] {
	const result: number[] = [];
	for (let i = from; i !== (to + 1) % 7; i = (i + 1) % 7) result.push(i);
	result.push(to);
	return result;
}

function parseWeekdays(input: string): string | null {
	const days: number[] = [];
	for (const part of input.split(",")) {
		const trimmed = part.trim().toLowerCase();
		const rangeParts = trimmed.split("-");
		if (rangeParts.length === 2) {
			const from = WEEKDAY_NAMES[rangeParts[0]];
			const to = WEEKDAY_NAMES[rangeParts[1]];
			if (from === undefined || to === undefined) return null;
			days.push(...expandRange(from, to));
		} else {
			const n = WEEKDAY_NAMES[trimmed];
			if (n === undefined) return null;
			days.push(n);
		}
	}
	return [...new Set(days)].sort().join(",");
}

function formatWeekdays(weekdays: string): string {
	return weekdays
		.split(",")
		.map((d) => DAY_NAMES[Number(d)])
		.join(", ");
}

async function fetchDirections(lineSlug: string) {
	const { line, category } = parseLineSlug(lineSlug);
	const where = and(
		eq(journeyRuns.line, line),
		DISPLAYED_CATEGORY,
		category ? eq(normalizedCategorySql, category) : undefined,
	);

	return db
		.selectDistinct({ direction: journeyRuns.destName })
		.from(journeyRuns)
		.where(
			and(
				where,
				isNotNull(journeyRuns.destName),
				gte(
					journeyRuns.dayOfOperation,
					sql`to_char(CURRENT_DATE - INTERVAL '7 days', 'YYYY-MM-DD')`,
				),
			),
		);
}

export async function handleTelegramWebhook(
	token: string,
	body: TelegramUpdate,
): Promise<void> {
	const msg = body.message;
	if (!msg?.text) return;

	const chatId = String(msg.chat.id);
	const lang = detectLang(msg.from?.language_code);
	const text = msg.text.trim();
	const reply = (t: string) => sendMessage(token, chatId, t);

	if (text.startsWith("/start s-")) {
		const encoded = text.slice("/start s-".length);
		try {
			const decoded = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
			// Schema: line|direction|stopName|timeRanges|weekdays.
			// Trailing empties may be absent (the client encoder drops
			// them). The stopName field is newer — older links that
			// encoded only 4 fields (line|direction|timeRanges|weekdays)
			// are still accepted: we detect the old shape by a 3rd field
			// that looks like a time range (contains ":") and shift.
			const parts = decoded.split("|");
			const line = parts[0] ?? "";
			const direction = parts[1] ?? "";
			let stopName = parts[2] ?? "";
			let timeRanges = parts[3] ?? "";
			let weekdays = parts[4] ?? "";
			if (stopName.includes(":") && !timeRanges && !weekdays) {
				// Legacy 4-field payload; shift stopName → timeRanges,
				// timeRanges → weekdays, and treat stopName as absent.
				weekdays = parts[3] ?? "";
				timeRanges = stopName;
				stopName = "";
			}
			let cmd = `/subscribe ${line}`;
			if (direction) cmd += ` ${direction}`;
			if (stopName) cmd += ` @${stopName}`;
			if (timeRanges) cmd += ` ${timeRanges}`;
			if (weekdays) cmd += ` ${weekdays}`;
			const desc = direction
				? `<b>${line}</b> → ${direction}`
				: `<b>${line}</b>`;
			const stopBit = stopName ? ` @ <b>${stopName}</b>` : "";
			await reply(
				`🚏 Subscribe to ${desc}${stopBit} alerts:\n\n<code>${cmd}</code>\n\nTap the command above to copy, then send it here.\n\nYou can add options before sending:\n⏰ Time: <code>${cmd} 06:00-09:00,16:00-19:00</code>\n📅 Days: <code>${cmd} Mo-Fr</code>\n⏰📅 Both: <code>${cmd} 06:00-09:00 Mo-Fr</code>`,
			);
		} catch {
			await reply("Invalid link. Try /help");
		}
		return;
	}

	if (text.startsWith("/start subscribe_")) {
		const line = decodeURIComponent(text.slice("/start subscribe_".length));
		const knownDirs = await fetchDirections(line);
		const dirs = knownDirs.map((d) => d.direction);
		const exampleDir =
			dirs.length >= 2
				? `${dirs[0]}+${dirs[1]}`
				: (dirs[0] ?? "&lt;direction&gt;");
		await reply(
			`🚏 To subscribe to <b>${line}</b> alerts, send:\n\n<code>/subscribe ${line}</code> — to see destinations\n<code>/subscribe ${line} ${dirs[0] ?? "&lt;direction&gt;"}</code> — to subscribe\n\nOptions: time range, weekdays, multiple directions with +\n<code>/subscribe ${line} ${exampleDir} 06:00-09:00,16:00-19:00 Mo-Fr</code>`,
		);
		return;
	}

	if (text === "/start" || text === "/help") {
		await reply(
			"🚏 <b>DummRum Alerts</b>\n\n" +
				"Get notified about cancellations & delays on Frankfurt public transport.\n\n" +
				"<b>Commands:</b>\n" +
				"/subscribe S1 — show destinations for S1\n" +
				"/subscribe S1 Wiesbaden — alerts for S1 towards Wiesbaden (all stops)\n" +
				"/subscribe S1 Wiesbaden @Konstablerwache — only at a specific stop\n" +
				"/subscribe S1 Wiesbaden+Ober-Roden — both directions\n" +
				"/unsubscribe — list your subscriptions to remove\n" +
				"/unsubscribe all — remove all subscriptions\n" +
				"/list — show all subscriptions\n" +
				"/lang de|en — change notification language\n\n" +
				"<b>Options (add after direction):</b>\n" +
				"Stop: <code>@Konstablerwache</code>\n" +
				"Time: <code>7:50-8:30</code> or <code>06:00-09:00,16:00-19:00</code>\n" +
				"Days: <code>Mo-Fr</code> or <code>Mo,Mi,Fr</code> or <code>Mo-We,Fr</code>\n\n" +
				"<b>Example:</b>\n" +
				"<code>/subscribe S1 Wiesbaden @Konstablerwache 06:00-09:00 Mo-Fr</code>\n\n" +
				"Direction and stop are matched as substrings.",
		);
		return;
	}

	if (text.startsWith("/subscribe ")) {
		const args = text.slice("/subscribe ".length).trim().split(" ");
		if (args.length < 2) {
			const line = args[0];
			const knownDirs = await fetchDirections(line);
			if (knownDirs.length > 0) {
				const list = knownDirs
					.map((d) => `• <code>/subscribe ${line} ${d.direction}</code>`)
					.join("\n");
				await reply(`Pick a direction for <b>${line}</b>:\n\n${list}`);
			} else {
				await reply(
					`Unknown line <b>${line}</b>.\n\nUsage: /subscribe &lt;line&gt; &lt;direction&gt; [HH:MM-HH:MM,...] [Mo,Di,...]`,
				);
			}
			return;
		}

		const line = args[0];
		const remaining = args.slice(1);

		let direction = "";
		let stopFilter = "";
		const timeRanges: string[] = [];
		let weekdays: string | null = null;

		for (const arg of remaining) {
			if (arg.startsWith("@")) {
				stopFilter += (stopFilter ? " " : "") + arg.slice(1);
			} else if (
				/^\d{1,2}:\d{2}-\d{1,2}:\d{2}(,\d{1,2}:\d{2}-\d{1,2}:\d{2})*$/.test(arg)
			) {
				timeRanges.push(
					...arg.split(",").map((r) => {
						const [from, to] = r.split("-");
						return `${from.padStart(5, "0")}-${to.padStart(5, "0")}`;
					}),
				);
			} else if (
				arg.includes(",") ||
				Object.keys(WEEKDAY_NAMES).includes(arg.toLowerCase()) ||
				/^[A-Za-z]{2,3}-[A-Za-z]{2,3}$/.test(arg)
			) {
				weekdays = parseWeekdays(arg);
				if (!weekdays) {
					await reply(`Invalid weekdays: ${arg}\nUse: Mo,Di,Mi,Do,Fr,Sa,So`);
					return;
				}
			} else {
				direction += (direction ? " " : "") + arg;
			}
		}

		if (!direction) {
			await reply("Please specify a direction.");
			return;
		}

		const directions = direction
			.split("+")
			.map((d) => d.trim())
			.filter(Boolean);
		const knownDirs = await fetchDirections(line);
		const unmatched: string[] = [];
		const matched: string[] = [];
		for (const dir of directions) {
			const low = dir.toLowerCase();
			const found = knownDirs.find((d) =>
				d.direction.toLowerCase().includes(low),
			);
			if (found) {
				matched.push(found.direction);
			} else {
				unmatched.push(dir);
			}
		}
		if (unmatched.length > 0) {
			if (knownDirs.length === 0) {
				await reply(
					`Unknown line <b>${line}</b>. Check the line name and try again.`,
				);
			} else {
				const list = knownDirs.map((d) => `• ${d.direction}`).join("\n");
				await reply(
					`No direction matching "${unmatched.join(", ")}" for <b>${line}</b>.\n\nKnown destinations:\n${list}`,
				);
			}
			return;
		}

		let resolvedStopId = "";
		let resolvedStopName = "";
		if (stopFilter) {
			const stopRows = await db
				.execute<{
					stop_id: string;
					stop_name: string;
				}>(sql`
				SELECT DISTINCT ON (js.stop_id) js.stop_id, js.stop_name
				FROM journey_stops js
				JOIN journey_runs jr
					ON jr.journey_ref = js.journey_ref
					AND jr.day_of_operation = js.day_of_operation
				WHERE js.day_of_operation >= to_char(CURRENT_DATE - INTERVAL '30 days', 'YYYY-MM-DD')
					AND LOWER(js.stop_name) LIKE ${`%${stopFilter.toLowerCase()}%`}
					AND normalize_category(jr.category) <> 'Fernverkehr'
				ORDER BY js.stop_id, js.stop_name
			`)
				.then((rs) =>
					(rs as unknown as { stop_id: string; stop_name: string }[]).map(
						(r) => ({ stopId: r.stop_id, stopName: r.stop_name }),
					),
				);
			if (stopRows.length === 0) {
				await reply(
					`No stop matching "<b>${stopFilter}</b>".\n\nTry a different name or omit @stop to subscribe to all stops.`,
				);
				return;
			}
			if (stopRows.length > 1) {
				const list = stopRows
					.slice(0, 10)
					.map(
						(s) =>
							`• <code>/subscribe ${line} ${direction} @${s.stopName.replace(/Frankfurt \(Main\) /i, "")}</code>`,
					)
					.join("\n");
				await reply(`Multiple stops match "<b>${stopFilter}</b>":\n\n${list}`);
				return;
			}
			resolvedStopId = stopRows[0].stopId;
			resolvedStopName = stopRows[0].stopName;
		}

		const tr = timeRanges.length > 0 ? timeRanges.join(",") : null;
		let updated = false;
		for (const dir of matched) {
			const existing = await db
				.select({ id: telegramSubscriptions.id })
				.from(telegramSubscriptions)
				.where(
					and(
						eq(telegramSubscriptions.chatId, chatId),
						eq(telegramSubscriptions.line, line),
						eq(telegramSubscriptions.direction, dir),
						eq(telegramSubscriptions.stopId, resolvedStopId),
					),
				)
				.limit(1);
			if (existing.length > 0) updated = true;
			await db
				.insert(telegramSubscriptions)
				.values({
					chatId,
					lang,
					line,
					direction: dir,
					stopId: resolvedStopId,
					timeRanges: tr,
					weekdays,
					createdAt: new Date().toISOString(),
				})
				.onConflictDoUpdate({
					target: [
						telegramSubscriptions.chatId,
						telegramSubscriptions.line,
						telegramSubscriptions.direction,
						telegramSubscriptions.stopId,
					],
					set: { timeRanges: tr, weekdays },
				});
		}

		let details = `<b>${line}</b> → ${matched.join(" + ")}`;
		if (resolvedStopName)
			details += `\n📍 ${resolvedStopName.replace(/Frankfurt \(Main\) /i, "")}`;
		if (timeRanges.length > 0) details += `\n⏰ ${timeRanges.join(", ")}`;
		if (weekdays) details += `\n📅 ${formatWeekdays(weekdays)}`;
		await reply(`✅ ${updated ? "Updated" : "Subscribed"}:\n${details}`);
		return;
	}

	if (text === "/unsubscribe all") {
		await db
			.delete(telegramSubscriptions)
			.where(eq(telegramSubscriptions.chatId, chatId));
		await reply("✅ Removed all subscriptions.");
		return;
	}

	if (text === "/unsubscribe") {
		const subs = await db
			.select()
			.from(telegramSubscriptions)
			.where(eq(telegramSubscriptions.chatId, chatId));
		if (subs.length === 0) {
			await reply("No subscriptions to remove.");
		} else {
			const list = subs.map(
				(s) => `• <code>/unsubscribe ${s.line} ${s.direction}</code>`,
			);
			await reply(`Which subscription to remove?\n\n${list.join("\n")}`);
		}
		return;
	}

	if (text.startsWith("/unsubscribe ")) {
		const parts = text.slice("/unsubscribe ".length).trim();
		const spaceIdx = parts.indexOf(" ");
		if (spaceIdx === -1) {
			await reply("Usage: /unsubscribe &lt;line&gt; &lt;direction&gt;");
			return;
		}
		const line = parts.slice(0, spaceIdx);
		const direction = parts.slice(spaceIdx + 1).trim();

		const existing = await db
			.select({ id: telegramSubscriptions.id })
			.from(telegramSubscriptions)
			.where(
				and(
					eq(telegramSubscriptions.chatId, chatId),
					eq(telegramSubscriptions.line, line),
					eq(telegramSubscriptions.direction, direction),
				),
			)
			.limit(1);

		if (existing.length === 0) {
			await reply(`No subscription found for <b>${line}</b> → ${direction}`);
			return;
		}

		await db
			.delete(telegramSubscriptions)
			.where(
				and(
					eq(telegramSubscriptions.chatId, chatId),
					eq(telegramSubscriptions.line, line),
					eq(telegramSubscriptions.direction, direction),
				),
			);

		await reply(`✅ Removed subscription for <b>${line}</b> → ${direction}`);
		return;
	}

	if (text === "/lang de" || text === "/lang en") {
		const newLang = text.slice(6) as Lang;
		await db
			.update(telegramSubscriptions)
			.set({ lang: newLang })
			.where(eq(telegramSubscriptions.chatId, chatId));
		await reply(
			newLang === "de"
				? "✅ Sprache auf Deutsch gesetzt."
				: "✅ Language set to English.",
		);
		return;
	}

	if (text === "/lang") {
		await reply(`Current: <b>${lang}</b>\n\nChange: /lang de or /lang en`);
		return;
	}

	if (text === "/list") {
		const subs = await db
			.select()
			.from(telegramSubscriptions)
			.where(eq(telegramSubscriptions.chatId, chatId));

		if (subs.length === 0) {
			await reply("No subscriptions yet. Try /subscribe S1 Wiesbaden");
			return;
		}

		const lines = subs.map((s) => {
			let desc = `• <b>${s.line}</b> → ${s.direction}`;
			if (s.stopId) desc += ` 📍 ${s.stopId}`;
			if (s.timeRanges) desc += ` ⏰ ${s.timeRanges.split(",").join(", ")}`;
			if (s.weekdays) desc += ` 📅 ${formatWeekdays(s.weekdays)}`;
			return desc;
		});
		await reply(`📋 Your subscriptions:\n${lines.join("\n")}`);
		return;
	}

	await reply("Unknown command. Try /help");
}

interface Issue {
	line: string;
	direction: string;
	time: string;
	stop: string;
	stopId: string;
	cancelled: boolean;
	delayMin: number | null;
}

async function notifySubscribers(
	token: string,
	issues: Issue[],
): Promise<void> {
	if (issues.length === 0 || !token) return;

	const issueSlugs = [...new Set(issues.map((i) => i.line))];
	// Extract raw line number from slug (last part) for legacy matching
	const rawLines = issueSlugs.map((s) => parseLineSlug(s).line);

	const subs = await db
		.select()
		.from(telegramSubscriptions)
		.where(
			or(
				inArray(telegramSubscriptions.line, issueSlugs),
				inArray(telegramSubscriptions.line, rawLines),
			),
		);
	if (subs.length === 0) return;

	const subsByLine = new Map<string, typeof subs>();
	for (const sub of subs) {
		const list = subsByLine.get(sub.line) ?? [];
		list.push(sub);
		subsByLine.set(sub.line, list);
	}

	const currentDay = nowBerlin().day();
	const notifications = new Map<string, { lang: Lang; msgs: string[] }>();

	for (const issue of issues) {
		const rawLine = parseLineSlug(issue.line).line;
		// Match against either the composite slug or the raw line
		const lineSubs = [
			...(subsByLine.get(issue.line) ?? []),
			...(subsByLine.get(rawLine) ?? []),
		];
		if (lineSubs.length === 0) continue;

		for (const sub of lineSubs) {
			if (!issue.direction.toLowerCase().includes(sub.direction.toLowerCase()))
				continue;

			if (sub.stopId && sub.stopId !== issue.stopId) continue;

			if (sub.weekdays) {
				const allowedDays = sub.weekdays.split(",").map(Number);
				if (!allowedDays.includes(currentDay)) continue;
			}

			if (sub.timeRanges) {
				const t = issue.time.slice(0, 5);
				const inRange = sub.timeRanges.split(",").some((r) => {
					const [from, to] = r.split("-");
					return t >= from && t <= to;
				});
				if (!inRange) continue;
			}

			const entry = notifications.get(sub.chatId) ?? {
				lang: (sub.lang as Lang) ?? "de",
				msgs: [],
			};
			const labels = ALERT_LABELS[entry.lang];
			const status = issue.cancelled
				? `❌ ${labels.cancelled}`
				: `⏱ +${issue.delayMin} min ${labels.delay}`;
			const stopInfo = issue.stop ? ` @ ${issue.stop}` : "";
			entry.msgs.push(
				`<b>${issue.line}</b> ${issue.time.slice(0, 5)} → ${issue.direction}${stopInfo}: ${status}`,
			);
			notifications.set(sub.chatId, entry);
		}
	}

	await Promise.allSettled(
		[...notifications].map(([chatId, { lang: l, msgs }]) =>
			sendMessage(
				token,
				chatId,
				`🚏 <b>${ALERT_LABELS[l].title}</b>\n${msgs.join("\n")}`,
			),
		),
	);
}

export async function notifyJourneyIssues(
	token: string,
	journeyRef: string,
	dayOfOperation: string,
	rawLine: string,
	destName: string,
): Promise<void> {
	if (!token) return;

	const [run, stops] = await Promise.all([
		db
			.select({ category: normalizedCategorySql.as("category") })
			.from(journeyRuns)
			.where(
				and(
					eq(journeyRuns.journeyRef, journeyRef),
					eq(journeyRuns.dayOfOperation, dayOfOperation),
				),
			)
			.limit(1),
		db
			.select()
			.from(journeyStops)
			.where(
				and(
					eq(journeyStops.journeyRef, journeyRef),
					eq(journeyStops.dayOfOperation, dayOfOperation),
				),
			),
	]);

	const category = run[0]?.category ?? "Bus";
	// Long-distance traffic is ingested but never displayed, so it must not
	// generate alerts either — see DISPLAYED_CATEGORY in queries.ts.
	if (category === "Fernverkehr") return;
	const source = providerFromRef(journeyRef);
	const line = `${source}:${category}:${rawLine}`;

	const issues: Issue[] = [];
	for (const stop of stops) {
		if (stop.cancelled) {
			issues.push({
				line,
				direction: destName,
				time: stop.depTime ?? stop.arrTime ?? "",
				stop: stop.stopName.replace(/Frankfurt \(Main\) /i, ""),
				stopId: stop.stopId,
				cancelled: true,
				delayMin: null,
			});
			continue;
		}
		if (stop.rtDepTime && stop.depTime) {
			const planned = new Date(`${dayOfOperation}T${stop.depTime}`).getTime();
			const actual = new Date(`${dayOfOperation}T${stop.rtDepTime}`).getTime();
			const delayMinVal = (actual - planned) / 60000;
			if (delayMinVal >= DELAY_THRESHOLD_MIN) {
				issues.push({
					line,
					direction: destName,
					time: stop.depTime,
					stop: stop.stopName.replace(/Frankfurt \(Main\) /i, ""),
					stopId: stop.stopId,
					cancelled: false,
					delayMin: Math.round(delayMinVal),
				});
			}
		}
	}

	if (issues.length > 0) {
		await notifySubscribers(token, issues);
	}
}
