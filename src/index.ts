const STATION_ID = "3001586";
const STATION_NAME = "Frankfurt (Main) Draisbornstraße";

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

async function getStats(db: D1Database): Promise<{ days: DayStats[]; avgCancelledPerDay: number }> {
  const { results } = await db
    .prepare(
      `SELECT
        date,
        direction,
        COUNT(*) as total,
        SUM(cancelled) as cancelled
      FROM departures
      GROUP BY date, direction
      ORDER BY date DESC, direction`
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

function renderPage(stats: { days: DayStats[]; avgCancelledPerDay: number }): string {
  const today = todayBerlin();
  const todayStats = stats.days.find((d) => d.date === today);

  const rows = stats.days
    .flatMap((d) => {
      const pct = d.total > 0 ? ((d.cancelled / d.total) * 100).toFixed(1) : "0.0";
      const isToday = d.date === today;
      const cls = isToday ? ' class="today"' : "";
      const dirCount = d.directions.length;
      const mainRow = `<tr${cls}>
        <td rowspan="${dirCount + 1}">${d.date}${isToday ? " (today)" : ""}</td>
        <td><strong>All</strong></td>
        <td>${d.total}</td>
        <td>${d.cancelled}</td>
        <td>${pct}%</td>
      </tr>`;
      const dirRows = d.directions.map((dir) => {
        const dirPct = dir.total > 0 ? ((dir.cancelled / dir.total) * 100).toFixed(1) : "0.0";
        return `<tr${cls}>
          <td class="dir">${dir.direction}</td>
          <td>${dir.total}</td>
          <td>${dir.cancelled}</td>
          <td>${dirPct}%</td>
        </tr>`;
      });
      return [mainRow, ...dirRows];
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${STATION_NAME} — Cancellations</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #f5f5f5; color: #1a1a1a; padding: 2rem; max-width: 720px; margin: 0 auto; }
    h1 { font-size: 1.3rem; margin-bottom: 0.3rem; }
    .subtitle { color: #666; margin-bottom: 1.5rem; font-size: 0.9rem; }
    .cards { display: flex; gap: 1rem; margin-bottom: 1.5rem; }
    .card { flex: 1; background: #fff; border-radius: 8px; padding: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card .label { font-size: 0.75rem; text-transform: uppercase; color: #888; letter-spacing: 0.05em; }
    .card .value { font-size: 1.8rem; font-weight: 700; margin-top: 0.2rem; }
    .card .value.warn { color: #d32f2f; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th { background: #fafafa; text-align: left; padding: 0.6rem 0.8rem; font-size: 0.75rem; text-transform: uppercase; color: #888; letter-spacing: 0.05em; border-bottom: 1px solid #eee; }
    td { padding: 0.5rem 0.8rem; border-bottom: 1px solid #f0f0f0; font-variant-numeric: tabular-nums; }
    tr.today { background: #fff8e1; font-weight: 600; }
    td.dir { font-size: 0.85rem; color: #555; padding-left: 1.2rem; }
    tr:last-child td { border-bottom: none; }
  </style>
</head>
<body>
  <h1>${STATION_NAME}</h1>
  <p class="subtitle">Bus departure cancellation tracker — updated hourly</p>
  <div class="cards">
    <div class="card">
      <div class="label">Today cancelled</div>
      <div class="value${(todayStats?.cancelled ?? 0) > 0 ? " warn" : ""}">${todayStats ? `${todayStats.cancelled}<span style="font-size:0.9rem;font-weight:400;color:#888"> / ${todayStats.total}</span>` : '<span style="font-size:0.9rem;color:#888">no data yet</span>'}</div>
    </div>
    <div class="card">
      <div class="label">Avg cancelled / day</div>
      <div class="value">${stats.avgCancelledPerDay.toFixed(1)}</div>
    </div>
    <div class="card">
      <div class="label">Days tracked</div>
      <div class="value">${stats.days.length}</div>
    </div>
  </div>
  <table>
    <thead><tr><th>Date</th><th>Direction</th><th>Total</th><th>Cancelled</th><th>Rate</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5" style="text-align:center;color:#888;padding:1rem">No data yet</td></tr>'}</tbody>
  </table>
</body>
</html>`;
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    const count = await collectDepartures(env);
    console.log(`Upserted ${count} departures for ${todayBerlin()}`);
  },

  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/stats") {
      const stats = await getStats(env.DB);
      return new Response(JSON.stringify(stats), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const stats = await getStats(env.DB);
    return new Response(renderPage(stats), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
} satisfies ExportedHandler<Env>;
