import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { departures, telegramSubscriptions } from "../db/schema";

interface TelegramUpdate {
	message?: {
		chat: { id: number };
		text?: string;
	};
}

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

function parseWeekdays(input: string): string | null {
	const days = input.split(",").map((d) => {
		const n = WEEKDAY_NAMES[d.trim().toLowerCase()];
		return n !== undefined ? n : -1;
	});
	if (days.some((d) => d === -1)) return null;
	return days.sort().join(",");
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
	const text = msg.text.trim();
	const reply = (t: string) => sendMessage(token, chatId, t);

	if (text.startsWith("/start subscribe_")) {
		const line = decodeURIComponent(text.slice("/start subscribe_".length));
		await reply(
			`🚏 To subscribe to <b>${line}</b> alerts, send:\n\n<code>/subscribe ${line} &lt;direction&gt;</code>\n\nExample: <code>/subscribe ${line} Wiesbaden</code>\n\nAdd optional time/days:\n<code>/subscribe ${line} Wiesbaden 06:00-09:00,16:00-19:00 Mo,Di,Mi,Do,Fr</code>`,
		);
		return;
	}

	if (text === "/start" || text === "/help") {
		await reply(
			"🚏 <b>DummRum Alerts</b>\n\n" +
				"Subscribe to cancellation & delay alerts for Frankfurt public transport lines.\n\n" +
				"<b>Commands:</b>\n" +
				"/subscribe S1 Wiesbaden — alerts for S1 towards Wiesbaden\n" +
				"/subscribe S1 Wiesbaden 06:00-09:00,16:00-19:00 Mo,Di,Mi,Do,Fr — commute hours\n" +
				"/unsubscribe S1 Wiesbaden — stop alerts\n" +
				"/list — show your subscriptions\n\n" +
				"<b>Options:</b>\n" +
				"Time range: HH:MM-HH:MM (e.g. 06:00-09:00)\n" +
				"Weekdays: Mo,Di,Mi,Do,Fr,Sa,So (or Mon,Tue,Wed,Thu,Fri,Sat,Sun)\n\n" +
				"Direction is matched as a substring.",
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

		const knownDirs = await fetchDirections(db, line);
		const dirLower = direction.toLowerCase();
		const match = knownDirs.some((d) =>
			d.direction.toLowerCase().includes(dirLower),
		);
		if (!match) {
			if (knownDirs.length === 0) {
				await reply(
					`Unknown line <b>${line}</b>. Check the line name and try again.`,
				);
			} else {
				const list = knownDirs.map((d) => `• ${d.direction}`).join("\n");
				await reply(
					`No direction matching "${direction}" for <b>${line}</b>.\n\nKnown destinations:\n${list}`,
				);
			}
			return;
		}

		await db
			.insert(telegramSubscriptions)
			.values({
				chatId,
				line,
				direction,
				timeRanges: timeRanges.length > 0 ? timeRanges.join(",") : null,
				weekdays,
				createdAt: new Date().toISOString(),
			})
			.onConflictDoUpdate({
				target: [
					telegramSubscriptions.chatId,
					telegramSubscriptions.line,
					telegramSubscriptions.direction,
				],
				set: {
					timeRanges: timeRanges.length > 0 ? timeRanges.join(",") : null,
					weekdays,
				},
			});

		let details = `<b>${line}</b> → ${direction}`;
		if (timeRanges.length > 0) details += `\n⏰ ${timeRanges.join(", ")}`;
		if (weekdays) details += `\n📅 ${formatWeekdays(weekdays)}`;
		await reply(`✅ Subscribed:\n${details}`);
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
	const notifications = new Map<string, string[]>();

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

			const msgs = notifications.get(sub.chatId) ?? [];
			const status = issue.cancelled
				? "❌ cancelled"
				: `⏱ +${issue.delayMin} min`;
			msgs.push(
				`<b>${issue.line}</b> ${issue.time.slice(0, 5)} → ${issue.direction}: ${status}`,
			);
			notifications.set(sub.chatId, msgs);
		}
	}

	for (const [chatId, msgs] of notifications) {
		await sendMessage(
			token,
			chatId,
			`🚏 <b>DummRum Alert</b>\n${msgs.join("\n")}`,
		);
	}
}
