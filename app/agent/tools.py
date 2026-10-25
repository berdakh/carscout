"""Tools the agent can call. Each is a thin async wrapper over a service so the
same code path serves the REST API and the model."""
from __future__ import annotations

import json

from anthropic import beta_async_tool

from app.services import deal, fueleconomy, nhtsa, seed
from app.services import fetch as fetch_svc
from app.services import finance
from app.services import search as search_svc


def _j(obj) -> str:
    return json.dumps(obj, default=str)


@beta_async_tool
async def web_search(query: str, max_results: int = 6) -> str:
    """Search the web. Use for current used-car price ranges, reliability write-ups, known problems, insurance cost articles, and auction sold prices.

    Args:
        query: Search query. Be specific: include year, make, model, and the thing you want (price, problems, reliability).
        max_results: Number of results, 1 to 10.
    """
    return _j(await search_svc.web_search(query, max(1, min(10, max_results))))


@beta_async_tool
async def fetch_page(url: str) -> str:
    """Fetch a public web page and return its readable text. Works for most dealer sites, CarGurus, Edmunds, RepairPal, news and forums. Fails on Facebook Marketplace and Craigslist; ask the user to paste the text instead.

    Args:
        url: Full http(s) URL.
    """
    return _j(await fetch_svc.fetch_page(url))


@beta_async_tool
async def decode_vin(vin: str) -> str:
    """Decode a 17-character VIN with the free NHTSA database: year, make, model, trim, engine, body, plant.

    Args:
        vin: The 17-character vehicle identification number.
    """
    return _j(await nhtsa.decode_vin(vin))


@beta_async_tool
async def vehicle_recalls(year: int, make: str, model: str) -> str:
    """List NHTSA safety recalls for a model year. Free and authoritative. Call this for any car the user is seriously considering.

    Args:
        year: Model year.
        make: Manufacturer, e.g. Toyota.
        model: Model name, e.g. Camry.
    """
    return _j(await nhtsa.recalls(year, make, model))


@beta_async_tool
async def vehicle_complaints(year: int, make: str, model: str) -> str:
    """Owner complaints filed with NHTSA for a model year, grouped by component. Good for spotting pattern failures (transmission, engine, electrical).

    Args:
        year: Model year.
        make: Manufacturer.
        model: Model name.
    """
    return _j(await nhtsa.complaints(year, make, model))


@beta_async_tool
async def fuel_economy(year: int, make: str, model: str) -> str:
    """Official EPA fuel economy (city, highway, combined mpg and annual fuel cost) for a model year.

    Args:
        year: Model year.
        make: Manufacturer.
        model: Model name.
    """
    return _j(await fueleconomy.fuel_economy(year, make, model))


@beta_async_tool
async def budget_search(
    monthly_payment: float,
    down_payment: float = 0,
    term_months: int = 60,
    credit_tier: str = "prime",
    driver_age: int = 30,
    body_types: list[str] | None = None,
    min_reliability: float = 0,
    max_age_years: int = 12,
) -> str:
    """Turn a monthly payment into a maximum purchase price and list seed-table cars that fit, ranked by total monthly cost (payment + fuel + insurance estimate + typical repairs).

    Args:
        monthly_payment: What the user can pay per month for the car loan itself, in USD.
        down_payment: Cash down in USD.
        term_months: Loan length in months, usually 36, 48, 60 or 72.
        credit_tier: One of super_prime, prime, nonprime, subprime, deep_subprime. Ask the user for a rough credit score if unknown; prime is the default.
        driver_age: Age of the main driver, affects the insurance estimate.
        body_types: Optional filter, any of sedan, hatchback, suv, truck, minivan, wagon, coupe.
        min_reliability: Minimum reliability score 1 to 5.
        max_age_years: Oldest car to consider.
    """
    return _j(seed.budget_search(monthly_payment, down_payment, term_months, credit_tier, driver_age,
                                 body_types=body_types, min_reliability=min_reliability, max_age_years=max_age_years))


@beta_async_tool
async def finance_calc(price: float, down_payment: float = 0, term_months: int = 60,
                       credit_tier: str = "prime", apr_pct: float | None = None,
                       depreciation_yearly_pct: float = 12) -> str:
    """Monthly payment, total interest, and how many months the buyer would owe more than the car is worth, for a given price.

    Args:
        price: Purchase price in USD before tax and fees.
        down_payment: Cash down in USD.
        term_months: Loan length in months.
        credit_tier: Used to look up an average APR when apr_pct is not given.
        apr_pct: Exact APR if the user has a real quote.
        depreciation_yearly_pct: Expected yearly value loss, 8 for Toyota trucks up to 16 for German luxury.
    """
    apr = apr_pct if apr_pct is not None else finance.apr_for_tier(credit_tier)
    return _j(finance.loan_summary(price, down_payment, apr, term_months, depreciation_yearly_pct).to_dict())


@beta_async_tool
async def seed_lookup(make: str, model: str) -> str:
    """Look up a model in the seed table: typical prices by age, reliability, repair cost, insurance tier, mpg, known issues. Returns null if the model is not in the table yet.

    Args:
        make: Manufacturer.
        model: Model name.
    """
    return _j(seed.find(make, model))


@beta_async_tool
async def grade_listing(
    year: int, make: str, model: str, price: float,
    mileage: int | None = None, trim: str | None = None,
    seller_type: str = "unknown", title_status: str = "unknown",
    location: str | None = None, vin: str | None = None,
    accident_reported: bool | None = None,
    red_flags_in_text: list[str] | None = None,
    down_payment: float = 0, term_months: int = 60, credit_tier: str = "prime", driver_age: int = 30,
) -> str:
    """Grade a specific listing: asking price vs expected price for its channel, verdict, suggested offer, red flags, what the same car costs at a dealer, private party, Facebook Marketplace and auction, plus financing and total monthly cost.

    Args:
        year: Model year.
        make: Manufacturer.
        model: Model name.
        price: Asking price in USD.
        mileage: Odometer miles.
        trim: Trim level if known.
        seller_type: dealer, private, online_retailer, auction, or unknown.
        title_status: clean, rebuilt, salvage, lemon, or unknown.
        location: City or state.
        vin: VIN if the listing shows one.
        accident_reported: True if the listing or history report mentions an accident.
        red_flags_in_text: Suspicious things noticed in the listing text.
        down_payment: Buyer's cash down.
        term_months: Loan length.
        credit_tier: super_prime, prime, nonprime, subprime, deep_subprime.
        driver_age: Main driver's age for the insurance estimate.
    """
    listing = deal.Listing(year=year, make=make, model=model, price=price, mileage=mileage, trim=trim,
                           seller_type=seller_type, title_status=title_status, location=location, vin=vin,
                           accident_reported=accident_reported, red_flags_in_text=red_flags_in_text or [])
    return _j(deal.grade(listing, down_payment, term_months, credit_tier, driver_age))


ALL_TOOLS = [web_search, fetch_page, decode_vin, vehicle_recalls, vehicle_complaints, fuel_economy,
             budget_search, finance_calc, seed_lookup, grade_listing]
