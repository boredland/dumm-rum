import csv
import json
import time
import urllib.request
import urllib.error
from datetime import date, timedelta

API_KEY = "ddd808ab-68df-4630-a566-db570dc011d9"
STATION_ID = "3001586"
BASE_URL = "https://www.rmv.de/hapi/departureBoard"
START_DATE = date(2025, 1, 1)
END_DATE = date(2026, 3, 26)
OUTPUT_FILE = "/home/jonass/Documents/draisbornelend/departures.csv"
DELAY_BETWEEN_REQUESTS = 0.5

CSV_FIELDS = [
    "date", "time", "rtDate", "rtTime",
    "line", "direction", "journeyStatus",
    "operator", "category", "reachable",
    "stopExtId", "stop", "journeyNum",
]


def fetch_day(d: date) -> list[dict]:
    params = (
        f"?accessId={API_KEY}"
        f"&id={STATION_ID}"
        f"&date={d.isoformat()}"
        f"&time=00:00"
        f"&duration=1439"
        f"&maxJourneys=-1"
        f"&format=json"
    )
    url = BASE_URL + params
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code} for {d}")
        return []
    except Exception as e:
        print(f"  Error for {d}: {e}")
        return []

    departures = data.get("Departure", [])
    rows = []
    for dep in departures:
        product = dep.get("ProductAtStop", {})
        rows.append({
            "date": dep.get("date", ""),
            "time": dep.get("time", ""),
            "rtDate": dep.get("rtDate", ""),
            "rtTime": dep.get("rtTime", ""),
            "line": product.get("line", ""),
            "direction": dep.get("direction", ""),
            "journeyStatus": dep.get("JourneyStatus", ""),
            "operator": product.get("operator", ""),
            "category": product.get("catOut", ""),
            "reachable": dep.get("reachable", ""),
            "stopExtId": dep.get("stopExtId", ""),
            "stop": dep.get("stop", ""),
            "journeyNum": product.get("num", ""),
        })
    return rows


def main():
    total_days = (END_DATE - START_DATE).days + 1
    print(f"Collecting departures for {total_days} days: {START_DATE} to {END_DATE}")

    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()

        total_departures = 0
        cancelled = 0
        current = START_DATE
        day_num = 0

        while current <= END_DATE:
            day_num += 1
            rows = fetch_day(current)
            day_cancelled = sum(1 for r in rows if r["journeyStatus"] == "C")
            cancelled += day_cancelled
            total_departures += len(rows)
            writer.writerows(rows)
            f.flush()

            status = f"[{day_num}/{total_days}] {current}: {len(rows)} departures"
            if day_cancelled:
                status += f" ({day_cancelled} cancelled)"
            print(status)

            current += timedelta(days=1)
            time.sleep(DELAY_BETWEEN_REQUESTS)

    print(f"\nDone. {total_departures} departures total, {cancelled} cancelled.")
    print(f"Saved to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
