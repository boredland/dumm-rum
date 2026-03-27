import dayjs from "dayjs";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = "Europe/Berlin";
const STATION_ID = "3001586";
const STATION_NAME = "Frankfurt (Main) Draisbornstraße";
const COLLECTION_START = "2026-03-27";
const COLLECTION_START_TIME = "11:00:00";

const DATA_FILTER = `(date > '${COLLECTION_START}' OR (date = '${COLLECTION_START}' AND time >= '${COLLECTION_START_TIME}'))`;

const UPSERT_SQL = `
INSERT INTO departures (date, time, rt_date, rt_time, line, direction, journey_status, cancelled, operator, category, journey_num, reachable, stop, stop_ext_id, fetched_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(date, time, line, direction, journey_num)
DO UPDATE SET
  rt_date = COALESCE(excluded.rt_date, departures.rt_date),
  rt_time = COALESCE(excluded.rt_time, departures.rt_time),
  journey_status = excluded.journey_status,
  cancelled = MAX(departures.cancelled, excluded.cancelled),
  reachable = CASE WHEN excluded.cancelled THEN 0 ELSE excluded.reachable END,
  fetched_at = excluded.fetched_at`;

interface HafasDeparture {
	date: string;
	time: string;
	rtDate?: string;
	rtTime?: string;
	direction: string;
	JourneyStatus: string;
	cancelled?: boolean;
	reachable?: boolean;
	stopExtId?: string;
	stop?: string;
	ProductAtStop: {
		line: string;
		operator: string;
		catOut: string;
		num: string;
	};
}

interface Env {
	DB: D1Database;
	RMV_API_KEY: string;
	AI: Ai;
}

function nowBerlin() {
	return dayjs().tz(TZ);
}

function todayBerlin(): string {
	return nowBerlin().format("YYYY-MM-DD");
}

// --- Data collection ---

async function collectDepartures(env: Env): Promise<number> {
	const oneHourAgo = nowBerlin().subtract(1, "hour");
	const url = `https://www.rmv.de/hapi/departureBoard?accessId=${env.RMV_API_KEY}&id=${STATION_ID}&date=${oneHourAgo.format("YYYY-MM-DD")}&time=${oneHourAgo.format("HH:mm")}&duration=120&maxJourneys=-1&format=json`;

	const resp = await fetch(url, {
		cf: { cacheTtl: 300, cacheEverything: true },
	});
	if (!resp.ok) {
		console.error(`HAFAS API error: ${resp.status}`);
		return 0;
	}

	const data: { Departure?: HafasDeparture[] } = await resp.json();
	const departures = (data.Departure ?? []).filter(
		(d) => d.ProductAtStop?.line && d.ProductAtStop?.num,
	);
	if (departures.length === 0) return 0;

	const now = new Date().toISOString();
	const BATCH_SIZE = 50;

	for (let i = 0; i < departures.length; i += BATCH_SIZE) {
		const stmts = departures.slice(i, i + BATCH_SIZE).map((dep) => {
			const p = dep.ProductAtStop;
			return env.DB.prepare(UPSERT_SQL).bind(
				dep.date,
				dep.time,
				dep.rtDate ?? null,
				dep.rtTime ?? null,
				p.line,
				dep.direction,
				dep.JourneyStatus,
				dep.cancelled ? 1 : 0,
				p.operator,
				p.catOut,
				p.num,
				dep.reachable ? 1 : 0,
				dep.stop ?? null,
				dep.stopExtId ?? null,
				now,
			);
		});
		await env.DB.batch(stmts);
	}

	return departures.length;
}

async function generateDailyHaiku(env: Env): Promise<void> {
	const today = todayBerlin();
	const existing = await env.DB.prepare("SELECT 1 FROM haikus WHERE date = ?")
		.bind(today)
		.first();
	if (existing) return;

	// @ts-expect-error model not yet in workers-types
	const response = await env.AI.run("@cf/ibm/granite-4.0-h-micro", {
		messages: [
			{
				role: "system",
				content:
					"You write single-line haikus. Respond with ONLY the haiku, nothing else. No quotes, no explanation.",
			},
			{
				role: "user",
				content:
					"Write a haiku about waiting at a bus stop, not knowing if the bus was cancelled or if it ever existed. Theme: missing buses, uncertainty, urban melancholy. One line, separated by slashes.",
			},
		],
		max_tokens: 50,
	});

	const haiku = (response as { response?: string }).response?.trim();
	if (!haiku) return;

	await env.DB.prepare(
		"INSERT OR IGNORE INTO haikus (date, haiku) VALUES (?, ?)",
	)
		.bind(today, haiku)
		.run();
}

// --- Queries ---

interface DirRow {
	date: string;
	direction: string;
	total: number;
	cancelled: number;
	avg_delay: number | null;
	rt_count: number;
	first_time: string;
	last_time: string;
}

interface DayStats {
	date: string;
	total: number;
	cancelled: number;
	avgDelay: number | null;
	plannedFreq: number | null;
	actualFreq: number | null;
}

interface DepartureRow {
	time: string;
	rt_time: string | null;
	line: string;
	direction: string;
	cancelled: number;
	fetched_at: string;
}

interface NextDeparture {
	time: string;
	rt_time: string | null;
	direction: string;
	line: string;
}

interface Stats {
	days: DayStats[];
	avgCancelledPerDay: number;
	lastChange: string | null;
	haiku: string | null;
}

function timeToMinutes(t: string): number {
	const [h, m] = t.split(":").map(Number);
	return h * 60 + m;
}

function freqMinutes(
	count: number,
	firstTime: string,
	lastTime: string,
): number | null {
	const span = timeToMinutes(lastTime) - timeToMinutes(firstTime);
	return span > 0 && count > 1 ? span / (count - 1) : null;
}

function blendedDelay(row: DirRow): number | null {
	if (row.rt_count === 0 && row.cancelled === 0) return null;
	const rtSum = (row.avg_delay ?? 0) * row.rt_count;
	const freq = freqMinutes(row.total, row.first_time, row.last_time);
	const cancelledDelay = freq !== null ? row.cancelled * freq : 0;
	const total = row.rt_count + row.cancelled;
	return total > 0 ? (rtSum + cancelledDelay) / total : null;
}

function weightedAvg(
	items: { value: number | null; weight: number }[],
): number | null {
	const valid = items.filter(
		(i): i is { value: number; weight: number } => i.value !== null,
	);
	const totalWeight = valid.reduce((s, i) => s + i.weight, 0);
	return totalWeight > 0
		? valid.reduce((s, i) => s + i.value * i.weight, 0) / totalWeight
		: null;
}

function avgNonNull(nums: (number | null)[]): number | null {
	const valid = nums.filter((n): n is number => n !== null);
	return valid.length > 0
		? valid.reduce((a, b) => a + b, 0) / valid.length
		: null;
}

async function getStats(db: D1Database): Promise<Stats> {
	const [statsResult, lastChangeResult, haikuResult] = await db.batch([
		db.prepare(
			`SELECT date, direction, COUNT(*) as total, SUM(cancelled) as cancelled,
        AVG(CASE WHEN cancelled = 0 AND rt_time IS NOT NULL THEN
          (strftime('%s', rt_time) - strftime('%s', time)) / 60.0
        END) as avg_delay,
        SUM(CASE WHEN cancelled = 0 AND rt_time IS NOT NULL THEN 1 ELSE 0 END) as rt_count,
        MIN(time) as first_time, MAX(time) as last_time
       FROM departures WHERE ${DATA_FILTER}
       GROUP BY date, direction ORDER BY date DESC, direction`,
		),
		db.prepare(
			`SELECT fetched_at FROM departures ORDER BY fetched_at DESC LIMIT 1`,
		),
		db.prepare("SELECT haiku FROM haikus WHERE date = ?").bind(todayBerlin()),
	]);

	const rows = (statsResult.results as DirRow[]) ?? [];
	const dayMap = new Map<string, { dirs: DirRow[] }>();
	for (const row of rows) {
		const entry = dayMap.get(row.date) ?? { dirs: [] };
		entry.dirs.push(row);
		dayMap.set(row.date, entry);
	}

	const days: DayStats[] = [...dayMap.entries()].map(([date, { dirs }]) => {
		const total = dirs.reduce((s, d) => s + d.total, 0);
		const cancelled = dirs.reduce((s, d) => s + d.cancelled, 0);
		const avgDelay = weightedAvg(
			dirs.map((d) => ({ value: blendedDelay(d), weight: d.total })),
		);
		const plannedFreq = avgNonNull(
			dirs.map((d) => freqMinutes(d.total, d.first_time, d.last_time)),
		);
		const actualFreq = avgNonNull(
			dirs.map((d) =>
				freqMinutes(d.total - d.cancelled, d.first_time, d.last_time),
			),
		);
		return { date, total, cancelled, avgDelay, plannedFreq, actualFreq };
	});

	const totalCancelled = days.reduce((s, d) => s + d.cancelled, 0);
	const lastChange =
		(lastChangeResult.results?.[0] as { fetched_at: string } | undefined)
			?.fetched_at ?? null;
	const haiku =
		(haikuResult.results?.[0] as { haiku: string } | undefined)?.haiku ?? null;

	return {
		days,
		avgCancelledPerDay: days.length > 0 ? totalCancelled / days.length : 0,
		lastChange,
		haiku,
	};
}

async function getDayDepartures(
	db: D1Database,
	date: string,
): Promise<DepartureRow[]> {
	const { results } = await db
		.prepare(
			`SELECT time, rt_time, line, direction, cancelled, fetched_at FROM departures WHERE date = ? AND ${DATA_FILTER} ORDER BY time, direction`,
		)
		.bind(date)
		.all<DepartureRow>();
	return results ?? [];
}

async function getNextDepartures(db: D1Database): Promise<NextDeparture[]> {
	const { results } = await db
		.prepare(
			`SELECT time, rt_time, direction, line FROM departures
       WHERE date = ? AND cancelled = 0 AND time >= ?
       GROUP BY direction HAVING time = MIN(time)
       ORDER BY time`,
		)
		.bind(todayBerlin(), nowBerlin().format("HH:mm:ss"))
		.all<NextDeparture>();
	return results ?? [];
}

// --- Rendering helpers ---

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function pct(cancelled: number, total: number): string {
	return total > 0 ? ((cancelled / total) * 100).toFixed(1) : "0.0";
}

function fmtFreq(freq: number | null): string {
	return freq !== null ? `~${freq.toFixed(0)} min` : "&mdash;";
}

function fmtDelay(delay: number | null): string {
	if (delay === null) return "&mdash;";
	return `${delay >= 0 ? "+" : ""}${delay.toFixed(1)} min`;
}

function shortDir(dir: string): string {
	return dir.replace(/^Frankfurt \(Main\)\s*/i, "");
}

function fmtTimestamp(iso: string | null): string {
	if (!iso) return "";
	return dayjs(iso).tz(TZ).format("DD.MM.YYYY, HH:mm");
}

function dayAvgDelay(departures: DepartureRow[]): number | null {
	const byDir = Map.groupBy(departures, (d) => d.direction);
	let totalDelay = 0;
	let count = 0;
	for (const [, deps] of byDir) {
		const sorted = deps.toSorted((a, b) => a.time.localeCompare(b.time));
		const freq = freqMinutes(
			sorted.length,
			sorted[0].time,
			sorted[sorted.length - 1].time,
		);
		for (const d of sorted) {
			if (d.cancelled && freq !== null) {
				totalDelay += freq;
				count++;
			} else if (!d.cancelled && d.rt_time) {
				totalDelay += timeToMinutes(d.rt_time) - timeToMinutes(d.time);
				count++;
			}
		}
	}
	return count > 0 ? totalDelay / count : null;
}

// --- CSS ---

const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0f1117; color: #e1e4e8; min-height: 100vh; }
.wrap { max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; }
header { margin-bottom: 2rem; }
h1 { font-size: 1.5rem; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 0.5rem; }
.subtitle { color: #7d8590; font-size: 0.85rem; margin-top: 0.3rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 1.2rem; }
.card .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #7d8590; margin-bottom: 0.4rem; }
.card .value { font-size: 2rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.card .value.warn { color: #f85149; }
.card .value.ok { color: #3fb950; }
.card .detail { font-size: 0.8rem; color: #7d8590; margin-top: 0.2rem; }
.section-title { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #7d8590; margin-bottom: 0.75rem; font-weight: 600; }
table { width: 100%; border-collapse: separate; border-spacing: 0; background: #161b22; border: 1px solid #30363d; border-radius: 12px; overflow: hidden; }
th { text-align: left; padding: 0.7rem 1rem; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em; color: #7d8590; background: #1c2129; border-bottom: 1px solid #30363d; font-weight: 600; }
td { padding: 0.6rem 1rem; border-bottom: 1px solid #21262d; font-variant-numeric: tabular-nums; font-size: 0.9rem; }
tr:last-child td { border-bottom: none; }
tr:hover { background: #1c2129; }
a { color: #58a6ff; text-decoration: none; }
a:hover { text-decoration: underline; }
.badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
.badge.cancelled { background: rgba(248,81,73,0.15); color: #f85149; }
.badge.ok { background: rgba(63,185,80,0.1); color: #3fb950; }
.bar-cell { width: 120px; }
.bar-wrap { background: #21262d; border-radius: 4px; height: 6px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 4px; background: #f85149; }
.back { display: inline-flex; align-items: center; gap: 0.4rem; color: #7d8590; font-size: 0.85rem; margin-bottom: 1.5rem; }
.back:hover { color: #58a6ff; }
.muted { font-size: 0.8rem; color: #7d8590; }
.empty { text-align: center; color: #484f58; padding: 2rem; }
.chart-wrap { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 1.2rem 1.2rem 0.8rem; margin-bottom: 2rem; overflow-x: auto; }
.chart-wrap svg { display: block; width: 100%; height: auto; }
.chart-wrap svg text { font-family: -apple-system, system-ui, sans-serif; }
@media (max-width: 600px) {
  .wrap { padding: 1rem; }
  .cards { grid-template-columns: 1fr; }
  .bar-cell { display: none; }
  td, th { padding: 0.5rem 0.6rem; font-size: 0.8rem; }
}`;

const FAVICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🚌</text></svg>">`;

function head(title: string) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  ${FAVICON}
  <style>${CSS}</style>
</head>`;
}

// --- Chart ---

function renderChart(days: DayStats[]): string {
	const sorted = [...days].reverse();
	if (sorted.length === 0) return "";

	const W = 760,
		L = 36,
		H = 120,
		labelH = 40,
		top = 16;
	const usable = W - L;
	const gap = Math.max(1, Math.floor((usable / sorted.length) * 0.15));
	const bw = Math.max(
		2,
		Math.floor((usable - gap * sorted.length) / sorted.length),
	);
	const svgH = H + labelH + top;
	const maxRate = Math.max(
		10,
		...sorted.map((d) => (d.total > 0 ? (d.cancelled / d.total) * 100 : 0)),
	);
	const maxLabels = Math.floor(usable / 40);

	const bars = sorted
		.map((d, i) => {
			const rate = d.total > 0 ? (d.cancelled / d.total) * 100 : 0;
			const barH = (rate / maxRate) * H;
			const x = L + i * (bw + gap) + gap;
			const y = top + H - barH;
			const showLabel =
				sorted.length <= maxLabels ||
				i % Math.ceil(sorted.length / maxLabels) === 0;
			return `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(barH, 1)}" rx="3" fill="${rate > 0 ? "#f85149" : "#21262d"}" opacity="${rate > 0 ? 0.85 : 0.4}">
      <title>${d.date}: ${rate.toFixed(1)}% (${d.cancelled}/${d.total})</title>
    </rect>
    ${rate > 0 && bw >= 14 ? `<text x="${x + bw / 2}" y="${y - 3}" text-anchor="middle" font-size="8" fill="#7d8590">${rate.toFixed(0)}%</text>` : ""}
    ${showLabel ? `<text x="${x + bw / 2}" y="${top + H + 12}" text-anchor="middle" font-size="8" fill="#484f58" transform="rotate(45 ${x + bw / 2} ${top + H + 12})">${d.date.slice(5)}</text>` : ""}`;
		})
		.join("\n");

	const grid = [0, 25, 50, 75, 100]
		.filter((v) => v <= maxRate * 1.1)
		.map((v) => {
			const y = top + H - (v / maxRate) * H;
			return `<line x1="${L - 2}" x2="${W}" y1="${y}" y2="${y}" stroke="#21262d"/>
    <text x="${L - 4}" y="${y + 3}" text-anchor="end" font-size="8" fill="#484f58">${v}%</text>`;
		})
		.join("\n");

	return `<div class="chart-wrap">
    <svg viewBox="0 0 ${W} ${svgH}" preserveAspectRatio="xMinYMid meet">${grid}\n${bars}</svg>
  </div>`;
}

// --- Pages ---

function renderOverview(stats: Stats, nextDeps: NextDeparture[]): string {
	const today = todayBerlin();
	const todayStats = stats.days.find((d) => d.date === today);
	const todayCancelled = todayStats?.cancelled ?? 0;
	const todayTotal = todayStats?.total ?? 0;

	const tableRows = stats.days
		.map((d) => {
			const rate = pct(d.cancelled, d.total);
			return `<tr>
      <td><a href="/day/${d.date}">${d.date}${d.date === today ? " (today)" : ""}</a></td>
      <td>${d.total}</td>
      <td>${d.cancelled > 0 ? `<span class="badge cancelled">${d.cancelled}</span>` : `<span class="badge ok">0</span>`}</td>
      <td>${rate}%</td>
      <td class="bar-cell"><div class="bar-wrap"><div class="bar-fill" style="width:${Math.min(parseFloat(rate) * 2, 100)}%"></div></div></td>
      <td>${fmtDelay(d.avgDelay)}</td>
      <td>${fmtFreq(d.plannedFreq)}</td>
      <td>${fmtFreq(d.actualFreq)}</td>
    </tr>`;
		})
		.join("\n");

	const nextCards = nextDeps
		.map((d) => {
			const time = d.time.slice(0, 5);
			const rt = d.rt_time?.slice(0, 5);
			const delay =
				rt && rt !== time
					? ` <span style="color:#d29922">&rarr; ${rt}</span>`
					: "";
			return `<div class="card">
      <div class="label">${esc(shortDir(d.direction))}</div>
      <div class="value" style="font-size:1.5rem">${time}${delay}</div>
      <div class="detail">${esc(d.line)}</div>
    </div>`;
		})
		.join("\n");

	return `${head(STATION_NAME)}
<body>
<div class="wrap">
  <header>
    <h1>🚌 ${STATION_NAME}</h1>
    <p class="subtitle">Bus M43 cancellation tracker &mdash; collecting since ${COLLECTION_START}${stats.lastChange ? ` &mdash; last updated ${fmtTimestamp(stats.lastChange)}` : ""}</p>
    ${stats.haiku ? `<p class="subtitle" style="margin-top:0.5rem;font-style:italic;color:#8b949e">${esc(stats.haiku)}</p>` : ""}
  </header>
  <div class="cards">
    <div class="card">
      <div class="label">Today</div>
      <div class="value${todayCancelled > 0 ? " warn" : " ok"}">${todayStats ? todayCancelled : "&mdash;"}</div>
      <div class="detail">${todayStats ? `of ${todayTotal} departures (${pct(todayCancelled, todayTotal)}%)` : "no data yet"}</div>
    </div>
    <div class="card">
      <div class="label">Avg / day</div>
      <div class="value">${stats.avgCancelledPerDay.toFixed(1)}</div>
      <div class="detail">cancelled (${
				stats.days.length > 0
					? pct(
							stats.days.reduce((s, d) => s + d.cancelled, 0),
							stats.days.reduce((s, d) => s + d.total, 0),
						)
					: "0.0"
			}% rate)</div>
    </div>
    <div class="card">
      <div class="label">Days tracked</div>
      <div class="value">${stats.days.length}</div>
      <div class="detail">${stats.days.length > 0 ? `since ${COLLECTION_START}` : ""}</div>
    </div>
  </div>
  ${nextDeps.length > 0 ? `<div class="section-title">Next departures</div><div class="cards">${nextCards}</div>` : ""}
  <div class="section-title">Cancellation rate</div>
  ${renderChart(stats.days)}
  <div class="section-title">Daily breakdown</div>
  <table>
    <thead><tr><th>Date</th><th>Total</th><th>Cancelled</th><th>Rate</th><th class="bar-cell"></th><th>Avg delay</th><th>Planned freq</th><th>Actual freq</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="8" class="empty">No data yet</td></tr>'}</tbody>
  </table>
</div>
</body></html>`;
}

function renderDayDetail(date: string, departures: DepartureRow[]): string {
	const isToday = date === todayBerlin();
	const currentHour = nowBerlin().format("HH");
	const cancelledCount = departures.filter((d) => d.cancelled).length;
	const avgDel = dayAvgDelay(departures);

	let anchorPlaced = false;
	const tableRows = departures
		.map((d) => {
			const time = d.time.slice(0, 5);
			const rtTime = d.rt_time?.slice(0, 5) ?? null;
			const delayMin = rtTime
				? timeToMinutes(rtTime) - timeToMinutes(time)
				: null;
			let id = "";
			if (isToday && !anchorPlaced && d.time.slice(0, 2) >= currentHour) {
				id = ' id="now"';
				anchorPlaced = true;
			}
			const delayCell =
				delayMin !== null && delayMin !== 0
					? `<span style="color:${delayMin > 0 ? "#d29922" : "#3fb950"}">${delayMin > 0 ? "+" : ""}${delayMin} min</span>`
					: '<span class="muted">on time</span>';
			return `<tr${id}>
      <td>${time}${rtTime && rtTime !== time ? ` <span style="color:#d29922">&rarr; ${rtTime}</span>` : ""}</td>
      <td>${esc(d.line)}</td>
      <td>${esc(shortDir(d.direction))}</td>
      <td>${d.cancelled ? '<span class="badge cancelled">cancelled</span>' : '<span class="badge ok">ok</span>'}</td>
      <td>${delayCell}</td>
      <td class="muted">${d.fetched_at.slice(0, 16).replace("T", " ")}</td>
    </tr>`;
		})
		.join("\n");

	return `${head(`${date} — ${STATION_NAME}`)}
<body>
<div class="wrap">
  <a href="/" class="back">&larr; Back to overview</a>
  <header>
    <h1>${date}</h1>
    <p class="subtitle">${STATION_NAME}</p>
  </header>
  <div class="cards">
    <div class="card">
      <div class="label">Departures</div>
      <div class="value">${departures.length}</div>
    </div>
    <div class="card">
      <div class="label">Cancelled</div>
      <div class="value${cancelledCount > 0 ? " warn" : " ok"}">${cancelledCount}</div>
      <div class="detail">${pct(cancelledCount, departures.length)}% cancellation rate</div>
    </div>
    <div class="card">
      <div class="label">Avg delay</div>
      <div class="value" style="font-size:1.5rem">${fmtDelay(avgDel)}</div>
      <div class="detail">cancelled = planned freq</div>
    </div>
  </div>
  <div class="section-title">All departures</div>
  <table>
    <thead><tr><th>Time</th><th>Line</th><th>Direction</th><th>Status</th><th>Delay</th><th>Last checked</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="6" class="empty">No departures</td></tr>'}</tbody>
  </table>
</div>
${isToday ? '<script>document.getElementById("now")?.scrollIntoView({behavior:"smooth",block:"center"})</script>' : ""}
</body></html>`;
}

// --- Worker ---

export default {
	async scheduled(_controller: ScheduledController, env: Env) {
		const [count] = await Promise.all([
			collectDepartures(env),
			generateDailyHaiku(env),
		]);
		console.log(`Upserted ${count} departures for ${todayBerlin()}`);
	},

	async fetch(request: Request, env: Env) {
		const { pathname } = new URL(request.url);

		if (pathname === "/api/stats") {
			return Response.json(await getStats(env.DB));
		}

		const dayMatch = pathname.match(/^\/day\/(\d{4}-\d{2}-\d{2})$/);
		if (dayMatch) {
			const departures = await getDayDepartures(env.DB, dayMatch[1]);
			return new Response(renderDayDetail(dayMatch[1], departures), {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		}

		const [stats, nextDeps] = await Promise.all([
			getStats(env.DB),
			getNextDepartures(env.DB),
		]);
		return new Response(renderOverview(stats, nextDeps), {
			headers: { "Content-Type": "text/html; charset=utf-8" },
		});
	},
} satisfies ExportedHandler<Env>;
