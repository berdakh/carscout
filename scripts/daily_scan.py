"""Daily scan. Reads docs/data/watchlist.json, checks every saved listing and saved
search, and writes a report the static site displays:

    docs/reports/<YYYY-MM-DD>.json, docs/reports/latest.json, docs/reports/index.json

Free checks always run: NHTSA recalls for watched cars, whether each saved listing
page still loads, and re-grading at the latest known price. With an AI key it also
reads each listing page for the current price, researches live market prices for the
top picks of each saved search, and writes a short digest.

Run locally:  python scripts/daily_scan.py [--dry-run]
In CI:        .github/workflows/daily-scan.yml runs it every day and commits the report.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pydantic import BaseModel  # noqa: E402

from app import llm  # noqa: E402
from app.config import REPORTS_DIR, WATCHLIST_PATH, settings  # noqa: E402
from app.services import deal, nhtsa, seed  # noqa: E402
from app.services import fetch as fetch_svc  # noqa: E402

KEEP_REPORTS = 90
PAGE_CHARS = 12000


# ----------------------------------------------------------------- AI schemas
class ListingCheck(BaseModel):
    still_listed: bool | None
    sold_or_pending: bool
    price: float | None
    mileage: int | None
    notes: str


class NotableListing(BaseModel):
    title: str
    url: str
    price: float | None
    mileage: int | None
    seller: str | None


class CarMarket(BaseModel):
    year: int
    make: str
    model: str
    price_low: float | None
    price_high: float | None
    typical_price: float | None
    trend: Literal["rising", "falling", "flat", "unknown"]
    notable_listings: list[NotableListing]
    notes: str


class MarketResearch(BaseModel):
    cars: list[CarMarket]
    sources: list[str]


SYSTEM = ("You help a first-time used-car buyer in the United States. Be factual. Never invent "
          "prices, mileage, or URLs: report only what you saw in a page or search result, and "
          "use null when unsure.")


# ----------------------------------------------------------------- helpers
def _key(year: int, make: str, model: str) -> str:
    return f"{year}|{make.strip().lower()}|{model.strip().lower()}"


def _title(x: dict) -> str:
    return " ".join(str(p) for p in (x.get("year"), x.get("make"), x.get("model"), x.get("trim")) if p)


def _pct(new: float | None, old: float | None) -> float | None:
    if not new or not old:
        return None
    return round((new - old) / old * 100, 1)


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


# ----------------------------------------------------------------- listings
async def check_listing(item: dict, prev: dict | None, provider: llm.Provider | None) -> dict:
    saved_price = item.get("price")
    last_price = (prev or {}).get("current_price") or saved_price
    out: dict[str, Any] = {
        "id": item["id"], "title": _title(item), "url": item.get("url"), "saved_price": saved_price,
        "previous_price": last_price, "current_price": None, "status": "not_tracked",
        "change_pct": None, "notes": "",
    }
    url = item.get("url")
    if url:
        try:
            page = await fetch_svc.fetch_page(url, max_chars=PAGE_CHARS)
        except Exception as e:  # noqa: BLE001 - network errors of any kind mean "could not check"
            page = {"error": f"{type(e).__name__}: {e}"}
        status_code = page.get("status")
        if status_code in (404, 410):
            out.update(status="gone", notes="The listing page no longer exists. Probably sold.")
        elif page.get("error"):
            out.update(status="blocked" if status_code else "unreachable", notes=page["error"])
        elif provider is None:
            out.update(status="page_ok", notes="Page loads. Add an AI key to read the current price.")
        else:
            check = await provider.extract(
                f"The buyer saved this listing: {_title(item)}, asking ${saved_price}. Below is the "
                f"text of the listing page fetched today. Is it still for sale, and what is the "
                f"current asking price and mileage?\n\nURL: {url}\nTitle: {page.get('title')}\n\n{page.get('text')}",
                ListingCheck, SYSTEM)
            if check.sold_or_pending or check.still_listed is False:
                out.update(status="gone", notes=check.notes or "Marked sold or pending.")
            else:
                out["current_price"] = check.price
                change = _pct(check.price, last_price)
                out["change_pct"] = change
                if check.price is None:
                    out["status"] = "price_unknown"
                elif change is not None and change <= -0.5:
                    out["status"] = "price_drop"
                elif change is not None and change >= 0.5:
                    out["status"] = "price_up"
                else:
                    out["status"] = "unchanged"
                out["notes"] = check.notes
                if check.mileage:
                    out["mileage"] = check.mileage

    price_for_grade = out["current_price"] or last_price
    if price_for_grade and item.get("year") and item.get("make") and item.get("model"):
        fields = {k: item.get(k) for k in ("year", "make", "model", "trim", "mileage", "seller_type",
                                           "title_status", "location", "vin") if item.get(k) is not None}
        if out.get("mileage"):
            fields["mileage"] = out["mileage"]
        g = deal.grade(deal.Listing(price=price_for_grade, **fields))
        if g["status"] == "ok":
            out["grade"] = {"verdict": g["verdict"], "label": g["verdict_label"], "suggested_offer": g["suggested_offer"],
                            "expected_price": g["market"]["expected_price_for_channel"],
                            "asking_vs_expected_pct": g["market"]["asking_vs_expected_pct"]}
    return out


# ----------------------------------------------------------------- recalls
async def check_recalls(cars: list[tuple[int, str, str]], prev_report: dict | None) -> list[dict]:
    prev_by_key = {r["key"]: set(r.get("campaigns", [])) for r in (prev_report or {}).get("recalls", [])}
    out = []
    for year, make, model in cars:
        key = _key(year, make, model)
        entry: dict[str, Any] = {"key": key, "title": f"{year} {make} {model}"}
        try:
            data = await nhtsa.recalls(year, make, model)
        except Exception as e:  # noqa: BLE001
            entry["error"] = f"{type(e).__name__}: {e}"
            if key in prev_by_key:
                entry["campaigns"] = sorted(prev_by_key[key])  # carry forward so tomorrow's diff still works
            out.append(entry)
            continue
        campaigns = {r["campaign"]: r for r in data["recalls"] if r.get("campaign")}
        entry["count"] = len(campaigns)
        entry["campaigns"] = sorted(campaigns)
        if key in prev_by_key:
            new = [campaigns[c] for c in campaigns if c not in prev_by_key[key]]
            entry["new"] = new
        else:
            entry["new"] = []
            entry["baseline"] = True
        out.append(entry)
    return out


# ----------------------------------------------------------------- searches
async def check_search(search: dict, prev: dict | None, provider: llm.Provider | None, location: str, today: str) -> dict:
    params = dict(search.get("params") or {})
    allowed = {"monthly_payment", "down_payment", "term_months", "credit_tier", "driver_age", "miles_per_year",
               "body_types", "min_reliability", "max_age_years"}
    params = {k: v for k, v in params.items() if k in allowed and v is not None}
    result = seed.budget_search(**params, limit=3)
    picks = [{"year": r["suggested_year"], "make": r["make"], "model": r["model"],
              "expected_retail": r["expected_retail"], "total_monthly_cost": r["total_monthly_cost"]} for r in result["results"]]
    out: dict[str, Any] = {"id": search["id"], "name": search.get("name") or "Saved search",
                           "max_purchase_price": result["max_purchase_price"], "matches": result["count"],
                           "picks": picks, "market": None}
    where = search.get("location") or location
    if provider is None or not picks:
        if provider is None:
            out["notes"] = "Add an AI key to research live prices for these picks."
        return out

    car_lines = "\n".join(f"{i + 1}. {p['year']} {p['make']} {p['model']} (our table expects about "
                          f"${p['expected_retail']:,} at a dealer)" for i, p in enumerate(picks))
    notes = await provider.research(
        f"Today is {today}. Research the current used-car market near {where or 'the United States'} "
        f"for these cars:\n{car_lines}\n\nFor each car: the typical asking price range for that model year "
        f"with average miles, whether prices are rising, falling or flat lately, and up to 3 specific "
        f"listings for sale now near {where or 'the buyer'} with URL, price and mileage. Use CarGurus, "
        f"Autotrader, Cars.com, Edmunds, KBB and local dealer sites. Cite the URLs you used.", SYSTEM)
    market = await provider.extract(
        f"Convert these research notes into a MarketResearch record with one entry per car below. "
        f"Use null where the notes give no number. Include only listings whose URL appears in the notes.\n\n"
        f"Cars:\n{car_lines}\n\nNotes:\n{notes}", MarketResearch, SYSTEM)
    prev_market = {(_key(c["year"], c["make"], c["model"])): c for c in ((prev or {}).get("market") or {}).get("cars", [])}
    cars = []
    for c in market.cars:
        d = c.model_dump()
        d["notable_listings"] = [n for n in d["notable_listings"] if str(n.get("url", "")).startswith(("http://", "https://"))]
        before = prev_market.get(_key(c.year, c.make, c.model))
        d["typical_change_pct"] = _pct(c.typical_price, (before or {}).get("typical_price"))
        cars.append(d)
    out["market"] = {"cars": cars, "sources": [s for s in market.sources if s.startswith(("http://", "https://"))][:12]}
    return out


# ----------------------------------------------------------------- summary
def plain_summary(report: dict) -> list[str]:
    lines = []
    L = report["listings"]
    drops = [x for x in L if x["status"] == "price_drop"]
    ups = [x for x in L if x["status"] == "price_up"]
    gone = [x for x in L if x["status"] == "gone"]
    for x in drops:
        lines.append(f"Price drop: {x['title']} now ${x['current_price']:,.0f} ({x['change_pct']}%).")
    for x in ups:
        lines.append(f"Price up: {x['title']} now ${x['current_price']:,.0f} (+{x['change_pct']}%).")
    for x in gone:
        lines.append(f"No longer listed: {x['title']}.")
    for r in report["recalls"]:
        if r.get("new"):
            lines.append(f"New recall for {r['title']}: {', '.join(n.get('component') or n['campaign'] for n in r['new'])}.")
    for s in report["searches"]:
        for c in ((s.get("market") or {}).get("cars") or []):
            if c.get("typical_change_pct") and abs(c["typical_change_pct"]) >= 2:
                lines.append(f"{c['year']} {c['make']} {c['model']} typical price moved {c['typical_change_pct']:+}% ({s['name']}).")
    if not lines:
        lines.append("No changes since the last scan.")
    return lines


async def run_scan(watchlist: dict, previous: dict | None, provider: llm.Provider | None, today: str) -> dict:
    location = (watchlist.get("settings") or {}).get("location") or ""
    listings = (watchlist.get("listings") or [])[: settings.scan_max_listings]
    searches = (watchlist.get("searches") or [])[: settings.scan_max_searches]
    prev_listings = {x["id"]: x for x in (previous or {}).get("listings", [])}
    prev_searches = {x["id"]: x for x in (previous or {}).get("searches", [])}
    report: dict[str, Any] = {
        "date": today, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "provider": provider.name if provider else None, "model": provider.model if provider else None,
        "location": location, "listings": [], "recalls": [], "searches": [], "errors": [],
    }
    for item in listings:
        try:
            report["listings"].append(await check_listing(item, prev_listings.get(item.get("id")), provider))
        except Exception as e:  # noqa: BLE001 - one bad item must not sink the report
            report["errors"].append({"where": f"listing {_title(item)}", "error": f"{type(e).__name__}: {e}"})
    cars = sorted({(int(x["year"]), x["make"], x["model"]) for x in listings if x.get("year") and x.get("make") and x.get("model")})
    report["recalls"] = await check_recalls(cars, previous)
    for s in searches:
        try:
            report["searches"].append(await check_search(s, prev_searches.get(s.get("id")), provider, location, today))
        except Exception as e:  # noqa: BLE001
            report["errors"].append({"where": f"search {s.get('name')}", "error": f"{type(e).__name__}: {e}"})

    report["highlights"] = plain_summary(report)
    report["digest"] = None
    if provider is not None and (report["listings"] or report["searches"]):
        try:
            compact = json.dumps({k: report[k] for k in ("highlights", "listings", "searches")}, default=str)[:30000]
            report["digest"] = await provider.write(
                "Write a short daily update (at most 120 words, plain sentences, no headings) for a first-time "
                "car buyer about their watchlist. Lead with anything they should act on today, such as a price "
                f"drop on a car graded fair or better. Data:\n{compact}", SYSTEM)
        except Exception as e:  # noqa: BLE001
            report["errors"].append({"where": "digest", "error": f"{type(e).__name__}: {e}"})
    report["counts"] = {
        "listings": len(report["listings"]), "searches": len(report["searches"]),
        "price_drops": sum(x["status"] == "price_drop" for x in report["listings"]),
        "gone": sum(x["status"] == "gone" for x in report["listings"]),
        "new_recalls": sum(len(r.get("new") or []) for r in report["recalls"]),
        "errors": len(report["errors"]),
    }
    return report


def write_report(report: dict, reports_dir: Path = REPORTS_DIR) -> None:
    reports_dir.mkdir(parents=True, exist_ok=True)
    body = json.dumps(report, indent=1, default=str)
    (reports_dir / f"{report['date']}.json").write_text(body)
    (reports_dir / "latest.json").write_text(body)
    index = load_json(reports_dir / "index.json", {"reports": []})
    entries = [e for e in index["reports"] if e["date"] != report["date"]]
    entries.append({"date": report["date"], "highlight": report["highlights"][0], "counts": report["counts"]})
    entries.sort(key=lambda e: e["date"], reverse=True)
    for old in entries[KEEP_REPORTS:]:
        (reports_dir / f"{old['date']}.json").unlink(missing_ok=True)
    (reports_dir / "index.json").write_text(json.dumps({"reports": entries[:KEEP_REPORTS]}, indent=1))


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="print the report instead of writing it")
    args = ap.parse_args()
    watchlist = load_json(WATCHLIST_PATH, {})
    previous = load_json(REPORTS_DIR / "latest.json", None)
    provider = llm.from_settings()
    today = datetime.now(timezone.utc).date().isoformat()
    if previous and previous.get("date") == today:
        # Re-running on the same day: diff against the report before today's, not against itself.
        index = load_json(REPORTS_DIR / "index.json", {"reports": []})
        older = [e["date"] for e in index["reports"] if e["date"] < today]
        previous = load_json(REPORTS_DIR / f"{max(older)}.json", None) if older else None
    print(f"scan {today}: provider={provider.name if provider else 'none'} "
          f"listings={len(watchlist.get('listings') or [])} searches={len(watchlist.get('searches') or [])}", flush=True)
    report = await run_scan(watchlist, previous, provider, today)
    for line in report["highlights"]:
        print(" -", line)
    for err in report["errors"]:
        print(" ! error:", err["where"], err["error"])
    if args.dry_run:
        print(json.dumps(report, indent=1, default=str))
    else:
        write_report(report)


if __name__ == "__main__":
    asyncio.run(main())
