"""Daily scan with a fake AI provider and mocked network, so it runs offline."""
import json
import sys

import pytest

from app import llm
from app.config import ROOT, settings

sys.path.insert(0, str(ROOT / "scripts"))
import daily_scan as scan  # noqa: E402


class FakeProvider:
    name, model = "fake", "fake-1"

    def __init__(self, listing_checks=None, market=None, fail_research=False):
        self.listing_checks = listing_checks or {}
        self.market = market
        self.fail_research = fail_research
        self.calls = []

    async def research(self, prompt, system=""):
        self.calls.append("research")
        if self.fail_research:
            raise RuntimeError("search quota exceeded")
        return "notes with https://example.com/listing-1"

    async def extract(self, prompt, schema, system=""):
        self.calls.append(f"extract:{schema.__name__}")
        if schema is scan.ListingCheck:
            for url, check in self.listing_checks.items():
                if url in prompt:
                    return scan.ListingCheck(**check)
            raise AssertionError("unexpected listing")
        return scan.MarketResearch(**self.market)

    async def write(self, prompt, system=""):
        self.calls.append("write")
        return "Digest: one price drop."


PAGES = {
    "https://dealer.example/camry": {"url": "https://dealer.example/camry", "status": 200, "title": "Camry", "text": "2018 Camry $16,900"},
    "https://dealer.example/sold": {"url": "https://dealer.example/sold", "status": 404, "error": "Page refused the request."},
    "https://facebook.com/x": {"url": "https://facebook.com/x", "status": 403, "error": "Page refused the request."},
}
RECALLS = {("Toyota", "Camry", 2018): ["18V001", "19V002"]}


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    async def fake_fetch(url, max_chars=12000):
        if url == "https://down.example/":
            raise ConnectionError("dns failure")
        return PAGES[url]

    async def fake_recalls(year, make, model):
        camps = RECALLS.get((make, model, year), [])
        return {"recalls": [{"campaign": c, "component": "ENGINE", "summary": "s"} for c in camps]}

    monkeypatch.setattr(scan.fetch_svc, "fetch_page", fake_fetch)
    monkeypatch.setattr(scan.nhtsa, "recalls", fake_recalls)


WATCH = {
    "settings": {"location": "Austin, TX"},
    "listings": [
        {"id": "a", "year": 2018, "make": "Toyota", "model": "Camry", "price": 17500, "mileage": 72000, "seller_type": "dealer", "url": "https://dealer.example/camry"},
        {"id": "b", "year": 2017, "make": "Honda", "model": "Civic", "price": 13900, "url": "https://dealer.example/sold"},
        {"id": "c", "year": 2016, "make": "Mazda", "model": "CX-5", "price": 12000, "url": "https://facebook.com/x"},
        {"id": "d", "year": 2019, "make": "Subaru", "model": "Outback", "price": 19000},
        {"id": "e", "year": 2015, "make": "Ford", "model": "Escape", "price": 8000, "url": "https://down.example/"},
    ],
    "searches": [{"id": "s1", "name": "Cheap and reliable", "params": {"monthly_payment": 300, "down_payment": 1500, "min_reliability": 4.0, "bogus": 1}}],
}
MARKET = {"cars": [{"year": 2020, "make": "Honda", "model": "Fit", "price_low": 13000, "price_high": 16000, "typical_price": 14500, "trend": "falling",
                    "notable_listings": [{"title": "2020 Fit LX", "url": "https://example.com/listing-1", "price": 14200, "mileage": 41000, "seller": "dealer"},
                                         {"title": "fake", "url": "javascript:alert(1)", "price": 1, "mileage": None, "seller": None}],
                    "notes": "Plenty of supply."}],
          "sources": ["https://example.com/listing-1", "not-a-url"]}


async def test_scan_with_ai_detects_changes_and_sanitizes():
    provider = FakeProvider(listing_checks={"https://dealer.example/camry": dict(still_listed=True, sold_or_pending=False, price=16900, mileage=72100, notes="Still listed.")},
                            market=MARKET)
    report = await scan.run_scan(WATCH, None, provider, "2026-11-06")
    by_id = {x["id"]: x for x in report["listings"]}
    assert by_id["a"]["status"] == "price_drop" and by_id["a"]["change_pct"] == -3.4
    assert by_id["a"]["grade"]["verdict"] in {"great", "good", "fair", "high", "overpriced", "suspicious"}
    assert by_id["b"]["status"] == "gone"
    assert by_id["c"]["status"] == "blocked"
    assert by_id["d"]["status"] == "not_tracked" and "grade" in by_id["d"]
    assert by_id["e"]["status"] == "unreachable"
    # recalls: first run is a baseline, nothing flagged as new
    camry = next(r for r in report["recalls"] if r["title"] == "2018 Toyota Camry")
    assert camry["count"] == 2 and camry["new"] == [] and camry["baseline"]
    s = report["searches"][0]
    assert s["picks"] and len(s["picks"]) <= 3
    urls = [n["url"] for n in s["market"]["cars"][0]["notable_listings"]]
    assert urls == ["https://example.com/listing-1"]  # javascript: URL dropped
    assert s["market"]["sources"] == ["https://example.com/listing-1"]
    assert report["digest"] == "Digest: one price drop."
    assert report["counts"]["price_drops"] == 1 and report["counts"]["gone"] == 1
    assert any("Price drop" in h for h in report["highlights"])
    json.dumps(report)


async def test_second_run_flags_new_recall_and_price_trend():
    provider = FakeProvider(listing_checks={"https://dealer.example/camry": dict(still_listed=True, sold_or_pending=False, price=16900, mileage=None, notes="")},
                            market=MARKET)
    first = await scan.run_scan(WATCH, None, provider, "2026-11-05")
    RECALLS[("Toyota", "Camry", 2018)].append("26V999")
    market2 = json.loads(json.dumps(MARKET)); market2["cars"][0]["typical_price"] = 13775
    try:
        second = await scan.run_scan(WATCH, first, FakeProvider(listing_checks={"https://dealer.example/camry": dict(still_listed=True, sold_or_pending=False, price=16900, mileage=None, notes="")}, market=market2), "2026-11-06")
    finally:
        RECALLS[("Toyota", "Camry", 2018)].pop()
    camry = next(r for r in second["recalls"] if r["title"] == "2018 Toyota Camry")
    assert [n["campaign"] for n in camry["new"]] == ["26V999"]
    assert second["counts"]["new_recalls"] == 1
    a = next(x for x in second["listings"] if x["id"] == "a")
    assert a["previous_price"] == 16900 and a["status"] == "unchanged"
    assert second["searches"][0]["market"]["cars"][0]["typical_change_pct"] == -5.0
    assert any("New recall" in h for h in second["highlights"])


async def test_scan_without_ai_runs_free_checks():
    report = await scan.run_scan(WATCH, None, None, "2026-11-06")
    a = next(x for x in report["listings"] if x["id"] == "a")
    assert a["status"] == "page_ok" and a["current_price"] is None and "grade" in a
    assert report["searches"][0]["market"] is None and "AI key" in report["searches"][0]["notes"]
    assert report["digest"] is None and report["provider"] is None


async def test_failures_are_recorded_not_fatal():
    report = await scan.run_scan(WATCH, None, FakeProvider(listing_checks={"https://dealer.example/camry": dict(still_listed=True, sold_or_pending=False, price=17500, mileage=None, notes="")}, fail_research=True), "2026-11-06")
    assert report["searches"] == []
    assert any("search" in e["where"] and "quota" in e["error"] for e in report["errors"])
    assert len(report["listings"]) == 5


async def test_limits_are_applied(monkeypatch):
    monkeypatch.setattr(settings, "scan_max_listings", 2)
    report = await scan.run_scan(WATCH, None, None, "2026-11-06")
    assert len(report["listings"]) == 2


def test_write_report_keeps_index_and_prunes(tmp_path, monkeypatch):
    monkeypatch.setattr(scan, "KEEP_REPORTS", 3)
    for day in range(1, 6):
        rep = {"date": f"2026-11-0{day}", "highlights": [f"day {day}"], "counts": {}}
        scan.write_report(rep, tmp_path)
    index = json.loads((tmp_path / "index.json").read_text())
    assert [e["date"] for e in index["reports"]] == ["2026-11-05", "2026-11-04", "2026-11-03"]
    assert not (tmp_path / "2026-11-01.json").exists()
    assert json.loads((tmp_path / "latest.json").read_text())["date"] == "2026-11-05"


def test_provider_selection(monkeypatch):
    for k, v in dict(anthropic_api_key="", openai_api_key="", scan_provider="", scan_model="").items():
        monkeypatch.setattr(settings, k, v)
    assert llm.from_settings() is None
    monkeypatch.setattr(settings, "openai_api_key", "sk-test")
    p = llm.from_settings(); assert p.name == "openai" and p.model == settings.openai_model
    monkeypatch.setattr(settings, "anthropic_api_key", "sk-ant-test")
    p = llm.from_settings(); assert p.name == "anthropic" and p.model == settings.carscout_model
    monkeypatch.setattr(settings, "scan_provider", "openai")
    monkeypatch.setattr(settings, "scan_model", "gpt-5.4-mini")
    p = llm.from_settings(); assert p.name == "openai" and p.model == "gpt-5.4-mini"


def test_claude_provider_request_shape(monkeypatch):
    p = llm.ClaudeProvider("sk-ant-test", "claude-opus-5-5")
    extra = p._extra("sys")
    assert extra == {"system": "sys", "betas": [llm.FALLBACK_BETA], "fallbacks": "default"}
    assert p._web_tools()[0]["type"] == "web_search_20260209"
    h = llm.ClaudeProvider("sk-ant-test", "claude-haiku-5-5")
    assert h._extra("") == {} and h._web_tools()[0]["type"] == "web_search_20250305"


def test_committed_watchlist_is_valid():
    w = json.loads((ROOT / "docs" / "data" / "watchlist.json").read_text())
    assert {"settings", "searches", "listings"} <= set(w)
