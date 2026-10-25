"""Seed table of popular used models. Lets budget search answer instantly without a
paid listings API; the agent then live-researches only the shortlist."""
from __future__ import annotations

import json
from datetime import date
from functools import lru_cache

from app.config import DATA_DIR
from app.services import finance
from app.services.finance import rates

CURRENT_YEAR = date.today().year


@lru_cache(maxsize=1)
def load() -> list[dict]:
    with open(DATA_DIR / "seed_cars.json") as f:
        return json.load(f)["cars"]


def _norm(s: str) -> str:
    return "".join(ch for ch in s.lower() if ch.isalnum())


def find(make: str, model: str) -> dict | None:
    """Fuzzy-ish lookup: exact normalized match first, then prefix/containment."""
    m, mo = _norm(make), _norm(model)
    cars = load()
    for c in cars:
        if _norm(c["make"]) == m and _norm(c["model"]) == mo:
            return c
    for c in cars:
        if _norm(c["make"]) == m and (_norm(c["model"]).startswith(mo) or mo.startswith(_norm(c["model"]))):
            return c
    for c in cars:
        if _norm(c["make"]) == m and (mo in _norm(c["model"]) or _norm(c["model"]) in mo):
            return c
    return None


def price_at_age(car: dict, age: float) -> float | None:
    """Linear interpolation across the age->price points, extrapolating with the
    model's depreciation rate beyond the oldest point and clamping at the newest."""
    pts = sorted((int(k), float(v)) for k, v in car["price_by_age"].items())
    if not pts:
        return None
    if age <= pts[0][0]:
        return pts[0][1]
    for (a0, p0), (a1, p1) in zip(pts, pts[1:]):
        if a0 <= age <= a1:
            return p0 + (p1 - p0) * (age - a0) / (a1 - a0)
    a_last, p_last = pts[-1]
    return p_last * (1 - car["depreciation_yearly_pct"] / 100) ** (age - a_last)


def expected_retail_price(car: dict, year: int, mileage: int | None = None, title: str = "clean") -> dict:
    """Expected dealer retail asking price for a specific year, mileage and title."""
    age = max(0, CURRENT_YEAR - year)
    base = price_at_age(car, age)
    if base is None:
        raise ValueError("no price data")
    adj = rates()["mileage_adjustment"]
    expected_miles = adj["expected_miles_per_year"] * max(age, 0.5)
    mileage_pct = 0.0
    if mileage is not None:
        mileage_pct = (mileage - expected_miles) / 10000 * adj["pct_per_10k_miles"]
        mileage_pct = max(-45.0, min(25.0, mileage_pct))
    title_mult = rates()["title_multipliers"].get(title, 1.0)
    price = base * (1 + mileage_pct / 100) * title_mult
    return {
        "age_years": age,
        "base_price_for_age": round(base),
        "expected_mileage": round(expected_miles),
        "mileage_adjustment_pct": round(mileage_pct, 1),
        "title_multiplier": title_mult,
        "expected_retail": round(price),
    }


def channel_prices(retail: float) -> list[dict]:
    mult = rates()["channel_price_multipliers"]
    fee_pct = rates()["auction_buyer_fee_pct"]
    broker = rates()["auction_broker_fee"]
    rows = []
    labels = {
        "cpo_dealer": ("Certified pre-owned at a dealer", "Warranty included, inspected, highest price."),
        "dealer_retail": ("Dealer retail", "Baseline. Negotiable, adds doc fees, may offer financing."),
        "online_retailer": ("Carvana / CarMax / Vroom style", "No-haggle, 7-day return, delivery fee."),
        "private_party": ("Private seller (Craigslist, Autotrader private)", "Cheapest clean-title route. No warranty, you handle title and payment safety."),
        "facebook_marketplace": ("Facebook Marketplace", "Similar to private party, more scams. Meet at a bank or police station."),
        "auction_hammer": ("Public or broker auction (Copart, IAAI, GovDeals)", "Sold as-is, often salvage. Buyer fee and broker fee added; no test drive."),
    }
    for key in ["cpo_dealer", "dealer_retail", "online_retailer", "private_party", "facebook_marketplace", "auction_hammer"]:
        if key.startswith("_"):
            continue
        price = retail * mult[key]
        extra = 0.0
        if key == "auction_hammer":
            extra = price * fee_pct / 100 + broker
        label, note = labels[key]
        rows.append({
            "channel": key, "label": label, "note": note,
            "typical_price": round(price), "fees": round(extra),
            "all_in": round(price + extra),
            "vs_dealer_pct": round((price + extra - retail) / retail * 100, 1),
        })
    return rows


def budget_search(
    monthly_payment: float,
    down_payment: float = 0.0,
    term_months: int = 60,
    credit_tier: str = "prime",
    driver_age: int = 30,
    miles_per_year: int | None = None,
    body_types: list[str] | None = None,
    min_reliability: float = 0.0,
    max_age_years: int = 12,
    include_total_cost: bool = True,
    limit: int = 15,
) -> dict:
    """Reverse the budget into a max price, then propose the newest year of each
    seed model that fits. Ranks by total monthly cost (payment + fuel + insurance
    + repairs) so a cheap-to-buy but thirsty car does not win by sticker alone."""
    apr = finance.apr_for_tier(credit_tier)
    max_price = finance.max_purchase_price(monthly_payment, down_payment, apr, term_months)
    results = []
    for car in load():
        if body_types and car["body"] not in [b.lower() for b in body_types]:
            continue
        if car["reliability"] < min_reliability:
            continue
        newest = min(car["years"][1], CURRENT_YEAR)
        oldest = max(car["years"][0], CURRENT_YEAR - max_age_years)
        chosen = None
        for year in range(newest, oldest - 1, -1):
            exp = expected_retail_price(car, year)
            if exp["expected_retail"] <= max_price:
                chosen = (year, exp["expected_retail"])
                break
        if not chosen:
            continue
        year, price = chosen
        loan = finance.loan_summary(price, down_payment, apr, term_months, car["depreciation_yearly_pct"])
        tco = finance.total_monthly_cost(loan.monthly_payment, car["mpg_combined"], car["insurance_tier"],
                                         car["annual_repair_cost"], driver_age, miles_per_year)
        results.append({
            "id": car["id"], "make": car["make"], "model": car["model"], "body": car["body"],
            "segment": car["segment"], "suggested_year": year, "age_years": CURRENT_YEAR - year,
            "expected_retail": price, "private_party_estimate": round(price * rates()["channel_price_multipliers"]["private_party"]),
            "reliability": car["reliability"], "mpg_combined": car["mpg_combined"],
            "monthly_payment": loan.monthly_payment, "total_monthly_cost": tco["total"],
            "cost_breakdown": tco, "months_underwater": loan.months_underwater,
            "known_issues": car["known_issues"], "novice_notes": car["novice_notes"],
        })
    results.sort(key=lambda r: (r["total_monthly_cost"] if include_total_cost else r["monthly_payment"], -r["reliability"]))
    return {
        "inputs": {"monthly_payment": monthly_payment, "down_payment": down_payment, "term_months": term_months,
                   "credit_tier": credit_tier, "apr_pct": apr, "driver_age": driver_age},
        "max_purchase_price": round(max_price),
        "count": len(results),
        "results": results[:limit],
    }
