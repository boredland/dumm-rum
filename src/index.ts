const STATION_ID = "3001586";
const STATION_NAME = "Frankfurt (Main) Draisbornstraße";
const COLLECTION_START = "2026-03-27";
const COLLECTION_START_TIME = "11:00:00";

const RELIABLE_DATA_FILTER = `
  (date > '${COLLECTION_START}' OR (date = '${COLLECTION_START}' AND time >= '${COLLECTION_START_TIME}'))`;


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
}

function todayBerlin(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
}

async function collectDepartures(env: Env): Promise<number> {
  const today = todayBerlin();
  const url = `https://www.rmv.de/hapi/departureBoard?accessId=${env.RMV_API_KEY}&id=${STATION_ID}&date=${today}&time=00:00&duration=1439&maxJourneys=-1&format=json`;

  const resp = await fetch(url);
  if (!resp.ok) {
    console.error(`HAFAS API error: ${resp.status}`);
    return 0;
  }

  const data: { Departure?: HafasDeparture[] } = await resp.json();
  const departures = (data.Departure ?? []).filter(
    (d) => d.ProductAtStop?.line && d.ProductAtStop?.num
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
        now
      );
    });
    await env.DB.batch(stmts);
  }

  return departures.length;
}

interface DirectionStats {
  date: string;
  direction: string;
  total: number;
  cancelled: number;
}

interface DayStats {
  date: string;
  total: number;
  cancelled: number;
  directions: { direction: string; total: number; cancelled: number }[];
}

interface DepartureRow {
  date: string;
  time: string;
  rt_date: string | null;
  rt_time: string | null;
  line: string;
  direction: string;
  cancelled: number;
  operator: string;
  category: string;
  journey_num: string;
  fetched_at: string;
}

async function getStats(db: D1Database): Promise<{ days: DayStats[]; avgCancelledPerDay: number }> {
  const { results } = await db
    .prepare(
      `SELECT date, direction, COUNT(*) as total, SUM(cancelled) as cancelled
       FROM departures WHERE ${RELIABLE_DATA_FILTER} GROUP BY date, direction ORDER BY date DESC, direction`
    )
    .all<DirectionStats>();

  const rows = results ?? [];
  const dayMap = new Map<string, DayStats>();
  for (const row of rows) {
    let day = dayMap.get(row.date);
    if (!day) {
      day = { date: row.date, total: 0, cancelled: 0, directions: [] };
      dayMap.set(row.date, day);
    }
    day.total += row.total;
    day.cancelled += row.cancelled;
    day.directions.push({ direction: row.direction, total: row.total, cancelled: row.cancelled });
  }

  const days = [...dayMap.values()];
  const totalCancelled = days.reduce((sum, d) => sum + d.cancelled, 0);
  const avgCancelledPerDay = days.length > 0 ? totalCancelled / days.length : 0;

  return { days, avgCancelledPerDay };
}

async function getDayDepartures(db: D1Database, date: string): Promise<DepartureRow[]> {
  const { results } = await db
    .prepare(
      `SELECT date, time, rt_date, rt_time, line, direction, cancelled, operator, category, journey_num, fetched_at
       FROM departures WHERE date = ? AND ${RELIABLE_DATA_FILTER} ORDER BY time, direction`
    )
    .bind(date)
    .all<DepartureRow>();
  return results ?? [];
}

interface NextDeparture {
  time: string;
  rt_time: string | null;
  direction: string;
  line: string;
}

async function getNextDepartures(db: D1Database): Promise<NextDeparture[]> {
  const today = todayBerlin();
  const now = new Date().toLocaleTimeString("sv-SE", { timeZone: "Europe/Berlin", hour12: false });
  const { results } = await db
    .prepare(
      `SELECT time, rt_time, direction, line FROM departures
       WHERE date = ? AND cancelled = 0 AND time >= ?
       ORDER BY time`
    )
    .bind(today, now)
    .all<NextDeparture>();
  const rows = results ?? [];
  const seen = new Set<string>();
  const out: NextDeparture[] = [];
  for (const r of rows) {
    if (!seen.has(r.direction)) {
      seen.add(r.direction);
      out.push(r);
    }
  }
  return out;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function pct(cancelled: number, total: number): string {
  return total > 0 ? ((cancelled / total) * 100).toFixed(1) : "0.0";
}

function shortDirection(dir: string): string {
  return dir.replace(/^Frankfurt \(Main\)\s*/i, "");
}

const CSS = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0f1117; color: #e1e4e8; min-height: 100vh; }
.wrap { max-width: 800px; margin: 0 auto; padding: 2rem 1.5rem; }
header { margin-bottom: 2rem; }
h1 { font-size: 1.5rem; font-weight: 700; color: #fff; display: flex; align-items: center; gap: 0.5rem; }
h1 .icon { font-size: 1.2rem; }
.subtitle { color: #7d8590; font-size: 0.85rem; margin-top: 0.3rem; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 1.2rem; }
.card .label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.08em; color: #7d8590; margin-bottom: 0.4rem; }
.card .value { font-size: 2rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.card .value.warn { color: #f85149; }
.card .value.ok { color: #3fb950; }
.card .detail { font-size: 0.8rem; color: #7d8590; margin-top: 0.2rem; }
.section-title { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; color: #7d8590; margin-bottom: 0.75rem; font-weight: 600; }
table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 12px; overflow: hidden; }
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
.bar-fill { height: 100%; border-radius: 4px; background: #f85149; transition: width 0.3s; }
.back { display: inline-flex; align-items: center; gap: 0.4rem; color: #7d8590; font-size: 0.85rem; margin-bottom: 1.5rem; }
.back:hover { color: #58a6ff; }
.dir-label { font-size: 0.8rem; color: #7d8590; }
.empty { text-align: center; color: #484f58; padding: 2rem; }
.chart-container { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 1.2rem 1.2rem 0.8rem; margin-bottom: 2rem; overflow-x: auto; }
.chart-container svg { display: block; width: 100%; height: auto; }
.chart-container svg text { font-family: -apple-system, system-ui, sans-serif; }
@media (max-width: 600px) {
  .wrap { padding: 1rem; }
  .cards { grid-template-columns: 1fr; }
  .bar-cell { display: none; }
  td, th { padding: 0.5rem 0.6rem; font-size: 0.8rem; }
}`;

function renderChart(days: DayStats[]): string {
  const sorted = [...days].reverse();
  if (sorted.length === 0) return "";

  const chartWidth = 760;
  const leftPad = 36;
  const chartHeight = 120;
  const labelHeight = 40;
  const topPadding = 16;
  const usable = chartWidth - leftPad;
  const gap = Math.max(1, Math.floor(usable / sorted.length * 0.15));
  const barWidth = Math.max(2, Math.floor((usable - gap * sorted.length) / sorted.length));
  const svgWidth = chartWidth;
  const svgHeight = chartHeight + labelHeight + topPadding;
  const maxRate = Math.max(10, ...sorted.map((d) => d.total > 0 ? (d.cancelled / d.total) * 100 : 0));

  const bars = sorted
    .map((d, i) => {
      const rate = d.total > 0 ? (d.cancelled / d.total) * 100 : 0;
      const barH = maxRate > 0 ? (rate / maxRate) * chartHeight : 0;
      const x = leftPad + i * (barWidth + gap) + gap;
      const y = topPadding + chartHeight - barH;
      const color = rate > 0 ? "#f85149" : "#21262d";
      const label = d.date.slice(5);
      const maxLabels = Math.floor(usable / 40);
      const showLabel = sorted.length <= maxLabels || i % Math.ceil(sorted.length / maxLabels) === 0;
      return `<rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(barH, 1)}" rx="3" fill="${color}" opacity="${rate > 0 ? 0.85 : 0.4}">
        <title>${d.date}: ${rate.toFixed(1)}% (${d.cancelled}/${d.total})</title>
      </rect>
      ${rate > 0 && barWidth >= 14 ? `<text x="${x + barWidth / 2}" y="${y - 3}" text-anchor="middle" font-size="8" fill="#7d8590">${rate.toFixed(0)}%</text>` : ""}
      ${showLabel ? `<text x="${x + barWidth / 2}" y="${topPadding + chartHeight + 12}" text-anchor="middle" font-size="8" fill="#484f58" transform="rotate(45 ${x + barWidth / 2} ${topPadding + chartHeight + 12})">${label}</text>` : ""}`;
    })
    .join("\n");

  const gridLines = [0, 25, 50, 75, 100]
    .filter((v) => v <= maxRate * 1.1)
    .map((v) => {
      const y = topPadding + chartHeight - (v / maxRate) * chartHeight;
      return `<line x1="${leftPad - 2}" x2="${svgWidth}" y1="${y}" y2="${y}" stroke="#21262d" stroke-width="1"/>
      <text x="${leftPad - 4}" y="${y + 3}" text-anchor="end" font-size="8" fill="#484f58">${v}%</text>`;
    })
    .join("\n");

  return `<div class="chart-container">
    <svg viewBox="0 0 ${svgWidth} ${svgHeight}" preserveAspectRatio="xMinYMid meet">
      ${gridLines}
      ${bars}
    </svg>
  </div>`;
}

function renderOverview(stats: { days: DayStats[]; avgCancelledPerDay: number }, nextDeps: NextDeparture[]): string {
  const today = todayBerlin();
  const todayStats = stats.days.find((d) => d.date === today);
  const todayCancelled = todayStats?.cancelled ?? 0;
  const todayTotal = todayStats?.total ?? 0;
  const todayRate = pct(todayCancelled, todayTotal);
  const avgRate = stats.days.length > 0
    ? pct(
        stats.days.reduce((s, d) => s + d.cancelled, 0),
        stats.days.reduce((s, d) => s + d.total, 0)
      )
    : "0.0";

  const tableRows = stats.days
    .map((d) => {
      const rate = pct(d.cancelled, d.total);
      const isToday = d.date === today;
      const dirSummary = d.directions
        .map((dir) => `<span class="dir-label">${esc(shortDirection(dir.direction))}: ${dir.cancelled}/${dir.total}</span>`)
        .join("&nbsp;&nbsp;");
      return `<tr>
        <td><a href="/day/${d.date}">${d.date}${isToday ? " (today)" : ""}</a></td>
        <td>${d.total}</td>
        <td>${d.cancelled > 0 ? `<span class="badge cancelled">${d.cancelled}</span>` : `<span class="badge ok">0</span>`}</td>
        <td>${rate}%</td>
        <td class="bar-cell"><div class="bar-wrap"><div class="bar-fill" style="width:${Math.min(parseFloat(rate) * 2, 100)}%"></div></div></td>
        <td>${dirSummary}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${STATION_NAME}</title>
  <style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1><span class="icon">🚌</span> ${STATION_NAME}</h1>
    <p class="subtitle">Bus M43 cancellation tracker &mdash; collecting data since 2026-03-27 &mdash; updated every 5 min</p>
  </header>
  <div class="cards">
    <div class="card">
      <div class="label">Today</div>
      <div class="value${todayCancelled > 0 ? " warn" : " ok"}">${todayStats ? todayCancelled : "&mdash;"}</div>
      <div class="detail">${todayStats ? `of ${todayTotal} departures (${todayRate}%)` : "no data yet"}</div>
    </div>
    <div class="card">
      <div class="label">Avg / day</div>
      <div class="value">${stats.avgCancelledPerDay.toFixed(1)}</div>
      <div class="detail">cancelled (${avgRate}% rate)</div>
    </div>
    <div class="card">
      <div class="label">Days tracked</div>
      <div class="value">${stats.days.length}</div>
      <div class="detail">${stats.days.length > 0 ? `since ${stats.days[stats.days.length - 1].date}` : ""}</div>
    </div>
  </div>
  ${nextDeps.length > 0 ? `
  <div class="section-title">Next departures</div>
  <div class="cards">
    ${nextDeps.map((d) => {
      const time = d.time.slice(0, 5);
      const rt = d.rt_time ? d.rt_time.slice(0, 5) : null;
      const delay = rt && rt !== time ? ` <span style="color:#d29922">&rarr; ${rt}</span>` : "";
      return `<div class="card">
      <div class="label">${esc(shortDirection(d.direction))}</div>
      <div class="value" style="font-size:1.5rem">${time}${delay}</div>
      <div class="detail">${esc(d.line)}</div>
    </div>`;
    }).join("\n")}
  </div>` : ""}
  <div class="section-title">Cancellation rate</div>
  ${renderChart(stats.days)}
  <div class="section-title">Daily breakdown</div>
  <table>
    <thead><tr><th>Date</th><th>Total</th><th>Cancelled</th><th>Rate</th><th class="bar-cell"></th><th>By direction</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="6" class="empty">No data yet</td></tr>'}</tbody>
  </table>
</div>
</body>
</html>`;
}

function renderDayDetail(date: string, departures: DepartureRow[]): string {
  const isToday = date === todayBerlin();
  const nowTime = new Date().toLocaleTimeString("sv-SE", { timeZone: "Europe/Berlin", hour12: false });
  const currentHour = nowTime.slice(0, 2);
  const cancelled = departures.filter((d) => d.cancelled);
  const rate = pct(cancelled.length, departures.length);

  let anchorPlaced = false;
  const tableRows = departures
    .map((d) => {
      const time = d.time.slice(0, 5);
      const hour = d.time.slice(0, 2);
      const rtTime = d.rt_time ? d.rt_time.slice(0, 5) : null;
      const delay = rtTime && rtTime !== time ? rtTime : null;
      let id = "";
      if (isToday && !anchorPlaced && hour >= currentHour) {
        id = ' id="now"';
        anchorPlaced = true;
      }
      return `<tr${id}>
        <td>${time}${delay ? ` <span style="color:#d29922">&rarr; ${delay}</span>` : ""}</td>
        <td>${esc(d.line)}</td>
        <td>${esc(shortDirection(d.direction))}</td>
        <td>${d.cancelled ? '<span class="badge cancelled">cancelled</span>' : '<span class="badge ok">ok</span>'}</td>
        <td class="dir-label">${d.fetched_at.slice(0, 16).replace("T", " ")}</td>
      </tr>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${date} &mdash; ${STATION_NAME}</title>
  <style>${CSS}</style>
</head>
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
      <div class="value${cancelled.length > 0 ? " warn" : " ok"}">${cancelled.length}</div>
      <div class="detail">${rate}% cancellation rate</div>
    </div>
  </div>
  <div class="section-title">All departures</div>
  <table>
    <thead><tr><th>Time</th><th>Line</th><th>Direction</th><th>Status</th><th>Last checked</th></tr></thead>
    <tbody>${tableRows || '<tr><td colspan="5" class="empty">No departures</td></tr>'}</tbody>
  </table>
</div>
${isToday ? `<script>document.getElementById("now")?.scrollIntoView({behavior:"smooth",block:"center"})</script>` : ""}
</body>
</html>`;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const count = await collectDepartures(env);
    console.log(`Upserted ${count} departures for ${todayBerlin()}`);
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/api/stats") {
      const stats = await getStats(env.DB);
      return new Response(JSON.stringify(stats), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const dayMatch = url.pathname.match(/^\/day\/(\d{4}-\d{2}-\d{2})$/);
    if (dayMatch) {
      const departures = await getDayDepartures(env.DB, dayMatch[1]);
      return new Response(renderDayDetail(dayMatch[1], departures), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    await collectDepartures(env);
    const [stats, nextDeps] = await Promise.all([getStats(env.DB), getNextDepartures(env.DB)]);
    return new Response(renderOverview(stats, nextDeps), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
