"""Grade a specific listing against the seed table's expected price."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.services import finance, seed
from app.services.finance import rates

SellerType = Literal["dealer", "private", "online_retailer", "auction", "unknown"]
TitleStatus = Literal["clean", "rebuilt", "salvage", "lemon", "unknown"]


class Listing(BaseModel):
    """Structured view of a for-sale listing. Also the schema the AI parser fills
    from pasted text or a screenshot."""
    year: int = Field(description="Model year")
    make: str
    model: str
    trim: str | None = None
    price: float = Field(description="Asking price in USD")
    mileage: int | None = Field(default=None, description="Odometer miles")
    seller_type: SellerType = "unknown"
    title_status: TitleStatus = "unknown"
    location: str | None = None
    vin: str | None = None
    one_owner: bool | None = None
    accident_reported: bool | None = None
    days_listed: int | None = None
    red_flags_in_text: list[str] = Field(default_factory=list, description="Anything suspicious the parser noticed in the listing text")
    url: str | None = None


def grade(listing: Listing, down_payment: float = 0.0, term_months: int = 60,
          credit_tier: str = "prime", driver_age: int = 30) -> dict:
    car = seed.find(listing.make, listing.model)
    flags: list[dict] = []
    if car is None:
        return {
            "status": "unknown_model",
            "message": f"{listing.make} {listing.model} is not in the seed table yet. Ask the assistant to research it live, or add it with scripts/build_seed.py.",
            "listing": listing.model_dump(),
        }

    title = listing.title_status if listing.title_status != "unknown" else "clean"
    exp = seed.expected_retail_price(car, listing.year, listing.mileage, title)
    mult = rates()["channel_price_multipliers"]
    channel_key = {"dealer": "dealer_retail", "private": "private_party", "online_retailer": "online_retailer",
                   "auction": "auction_hammer", "unknown": "dealer_retail"}[listing.seller_type]
    expected_for_channel = exp["expected_retail"] * mult[channel_key]
    diff_pct = (listing.price - expected_for_channel) / expected_for_channel * 100

    if diff_pct <= -20:
        verdict, label = "suspicious", "Far below market. Verify it is real before you get excited."
        flags.append({"level": "danger", "text": "Price is more than 20% under market. Common scam pattern, or an undisclosed salvage title or mechanical problem."})
    elif diff_pct <= -10:
        verdict, label = "great", "Well below market"
    elif diff_pct <= -3:
        verdict, label = "good", "Below market"
    elif diff_pct <= 5:
        verdict, label = "fair", "Around market"
    elif diff_pct <= 12:
        verdict, label = "high", "Above market, negotiate"
    else:
        verdict, label = "overpriced", "Well above market"

    age = exp["age_years"]
    if listing.mileage is not None:
        if listing.mileage > 150000:
            flags.append({"level": "warn", "text": "Over 150k miles. Expect wear items (suspension, mounts, seals). Price should reflect it."})
        if listing.mileage > exp["expected_mileage"] * 1.5 and age >= 2:
            flags.append({"level": "warn", "text": "Mileage is well above average for the age. Probably highway or fleet use; ask."})
        if age >= 3 and listing.mileage < exp["expected_mileage"] * 0.35:
            flags.append({"level": "info", "text": "Unusually low miles. Check for long storage (dry seals, old tires) or odometer issues on the history report."})
    else:
        flags.append({"level": "warn", "text": "No mileage given. Never evaluate a car without it."})
    if listing.title_status in ("rebuilt", "salvage", "lemon"):
        flags.append({"level": "danger", "text": f"{listing.title_status.title()} title. Hard to insure fully, hard to resell, and the expected price already includes a steep discount."})
    if listing.title_status == "unknown":
        flags.append({"level": "info", "text": "Title status not stated. Ask for a photo of the title and run the VIN."})
    if listing.accident_reported:
        flags.append({"level": "warn", "text": "Accident reported. Get the repair records and have a shop check frame and paint thickness."})
    if listing.seller_type in ("private", "unknown") and listing.vin is None:
        flags.append({"level": "info", "text": "No VIN in the listing. Ask for it before meeting; a seller who refuses is a red flag."})
    if listing.seller_type == "auction":
        flags.append({"level": "warn", "text": "Auction purchase: no test drive, sold as-is, buyer fees of roughly 10% plus a broker fee for non-dealers."})
    if age >= 12:
        flags.append({"level": "info", "text": "12+ years old. Rubber, hoses, and electronics age regardless of miles. Budget a maintenance catch-up."})
    for issue in car["known_issues"]:
        flags.append({"level": "model", "text": issue})
    for rf in listing.red_flags_in_text:
        flags.append({"level": "warn", "text": rf})

    offer = min(listing.price, expected_for_channel * (0.93 if listing.seller_type != "online_retailer" else 1.0))
    offer = round(offer / 100) * 100

    apr = finance.apr_for_tier(credit_tier)
    loan = finance.loan_summary(listing.price, down_payment, apr, term_months, car["depreciation_yearly_pct"])
    tco = finance.total_monthly_cost(loan.monthly_payment, car["mpg_combined"], car["insurance_tier"],
                                     car["annual_repair_cost"], driver_age)

    return {
        "status": "ok",
        "listing": listing.model_dump(),
        "car": {k: car[k] for k in ("make", "model", "segment", "reliability", "annual_repair_cost", "mpg_combined", "novice_notes")},
        "market": {
            **exp,
            "channel_assumed": channel_key,
            "expected_price_for_channel": round(expected_for_channel),
            "asking_vs_expected_pct": round(diff_pct, 1),
        },
        "verdict": verdict,
        "verdict_label": label,
        "suggested_offer": offer,
        "flags": flags,
        "channels": seed.channel_prices(exp["expected_retail"]),
        "financing": loan.to_dict(),
        "monthly_cost": tco,
        "disclaimer": "Estimates from a seed table of national averages and planning assumptions, not quotes. Local prices vary 5-10%.",
    }
