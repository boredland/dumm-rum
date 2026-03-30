import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { departures, telegramSubscriptions } from "../db/schema";

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

async function fetchDirections(db: Db, line: string) {
	return db
		.selectDistinct({ direction: departures.direction })
		.from(departures)
		.where(and(eq(departures.line, line), isNotNull(departures.direction)));
}

export async function handleTelegramWebhook(
	db: Db,
	token: string,
	body: TelegramUpdate,
): Promise<void> {
	const msg = body.message;
	if (!msg?.text) return;

	const chatId = String(msg.chat.id);
	const lang = detectLang(msg.from?.language_code);
	const text = msg.text.trim();
	const reply = (t: string) => sendMessage(token, chatId, t);

	if (text.startsWith("/start subscribe_")) {
		const line = decodeURIComponent(text.slice("/start subscribe_".length));
		await reply(
			`🚏 To subscribe to <b>${line}</b> alerts, send:\n\n<code>/subscribe ${line}</code> — to see destinations\n<code>/subscribe ${line} &lt;direction&gt;</code> — to subscribe\n\nOptions: time range, weekdays, multiple directions with +\n<code>/subscribe ${line} Wiesbaden+Ober-Roden 06:00-09:00,16:00-19:00 Mo-Fr</code>`,
		);
		return;
	}

	if (text === "/start" || text === "/help") {
		await reply(
			"🚏 <b>DummRum Alerts</b>\n\n" +
				"Get notified about cancellations & delays on Frankfurt public transport.\n\n" +
				"<b>Commands:</b>\n" +
				"/subscribe S1 — show destinations for S1\n" +
				"/subscribe S1 Wiesbaden — alerts for S1 towards Wiesbaden\n" +
				"/subscribe S1 Wiesbaden+Ober-Roden — both directions\n" +
				"/unsubscribe — list your subscriptions to remove\n" +
				"/unsubscribe all — remove all subscriptions\n" +
				"/list — show all subscriptions\n" +
				"/lang de|en — change notification language\n\n" +
				"<b>Options (add after direction):</b>\n" +
				"Time: <code>7:50-8:30</code> or <code>06:00-09:00,16:00-19:00</code>\n" +
				"Days: <code>Mo-Fr</code> or <code>Mo,Mi,Fr</code> or <code>Mo-We,Fr</code>\n\n" +
				"<b>Example:</b>\n" +
				"<code>/subscribe S1 Wiesbaden+Ober-Roden 06:00-09:00,16:00-19:00 Mo-Fr</code>\n\n" +
				"Direction is matched as a substring (e.g. 'Wiesbaden' matches 'Wiesbaden Hauptbahnhof').",
		);
		return;
	}

	if (text.startsWith("/subscribe ")) {
		const args = text.slice("/subscribe ".length).trim().split(" ");
		if (args.length < 2) {
			const line = args[0];
			const knownDirs = await fetchDirections(db, line);
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
		const timeRanges: string[] = [];
		let weekdays: string | null = null;

		for (const arg of remaining) {
			if (
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
				Object.keys(WEEKDAY_NAMES).includes(arg.toLowerCase())
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
		const knownDirs = await fetchDirections(db, line);
		const unmatched: string[] = [];
		const matched: string[] = [];
		for (const dir of directions) {
			const low = dir.toLowerCase();
			if (knownDirs.some((d) => d.direction.toLowerCase().includes(low))) {
				matched.push(dir);
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

		const tr = timeRanges.length > 0 ? timeRanges.join(",") : null;
		for (const dir of matched) {
			await db
				.insert(telegramSubscriptions)
				.values({
					chatId,
					lang,
					line,
					direction: dir,
					timeRanges: tr,
					weekdays,
					createdAt: new Date().toISOString(),
				})
				.onConflictDoUpdate({
					target: [
						telegramSubscriptions.chatId,
						telegramSubscriptions.line,
						telegramSubscriptions.direction,
					],
					set: { timeRanges: tr, weekdays },
				});
		}

		let details = `<b>${line}</b> → ${matched.join(" + ")}`;
		if (timeRanges.length > 0) details += `\n⏰ ${timeRanges.join(", ")}`;
		if (weekdays) details += `\n📅 ${formatWeekdays(weekdays)}`;
		await reply(`✅ Subscribed:\n${details}`);
		return;
	}

	if (text === "/unsubscribe all") {
		const deleted = await db
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
	cancelled: boolean;
	delayMin: number | null;
}

export async function notifySubscribers(
	db: Db,
	token: string,
	issues: Issue[],
): Promise<void> {
	if (issues.length === 0 || !token) return;

	const issueLines = [...new Set(issues.map((i) => i.line))];
	const subs = await db
		.select()
		.from(telegramSubscriptions)
		.where(inArray(telegramSubscriptions.line, issueLines));
	if (subs.length === 0) return;

	const subsByLine = new Map<string, typeof subs>();
	for (const sub of subs) {
		const list = subsByLine.get(sub.line) ?? [];
		list.push(sub);
		subsByLine.set(sub.line, list);
	}

	const currentDay = new Date().getDay();
	const notifications = new Map<string, { lang: Lang; msgs: string[] }>();

	for (const issue of issues) {
		const lineSubs = subsByLine.get(issue.line);
		if (!lineSubs) continue;

		for (const sub of lineSubs) {
			if (!issue.direction.toLowerCase().includes(sub.direction.toLowerCase()))
				continue;

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
			entry.msgs.push(
				`<b>${issue.line}</b> ${issue.time.slice(0, 5)} → ${issue.direction}: ${status}`,
			);
			notifications.set(sub.chatId, entry);
		}
	}

	for (const [chatId, { lang: l, msgs }] of notifications) {
		await sendMessage(
			token,
			chatId,
			`🚏 <b>${ALERT_LABELS[l].title}</b>\n${msgs.join("\n")}`,
		);
	}
}
