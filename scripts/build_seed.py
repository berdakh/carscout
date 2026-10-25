"""Research a model with the agent's tools and append it to data/seed_cars.json.

Usage:
    python scripts/build_seed.py "Toyota" "Avalon"
    python scripts/build_seed.py --refresh            # re-research every existing row

Each run makes several web searches and one model call per car, so a full refresh
of ~70 models costs a few dollars and a few minutes. Needs ANTHROPIC_API_KEY.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import anthropic  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from app.agent.tools import fetch_page, vehicle_complaints, web_search  # noqa: E402
from app.config import DATA_DIR, settings  # noqa: E402

SEED_PATH = DATA_DIR / "seed_cars.json"


class SeedCar(BaseModel):
    make: str
    model: str
    body: str = Field(description="one of sedan, hatchback, suv, truck, minivan, wagon, coupe")
    segment: str
    first_year: int = Field(description="first model year of the generation range worth buying used")
    last_year: int = Field(description="last model year sold, or the current year if still on sale")
    price_age_3: float | None = Field(description="typical US dealer retail asking price for a 3-year-old example with average miles, USD")
    price_age_5: float | None
    price_age_8: float | None
    price_age_12: float | None
    reliability: float = Field(ge=1, le=5, description="1-5, 5 is Toyota-grade")
    annual_repair_cost: float = Field(description="typical annual repair and maintenance USD, RepairPal-style")
    insurance_tier: int = Field(ge=1, le=5, description="1 cheapest to insure, 5 sports/luxury/EV")
    mpg_combined: float = Field(description="EPA combined mpg for the common powertrain, MPGe for EVs")
    depreciation_yearly_pct: float = Field(description="typical yearly value loss percent for a used example")
    known_issues: list[str] = Field(description="3-5 short, specific, year-ranged known problems")
    novice_notes: str = Field(description="two sentences a first-time buyer should hear")
    sources: list[str] = Field(description="URLs you relied on")


PROMPT = """Research the used {make} {model} for a US first-time buyer and fill the SeedCar record.
Use web_search for: current used price ranges by model year (CarGurus, Edmunds, KBB, iSeeCars),
reliability and typical repair cost (RepairPal, Consumer Reports summaries, CarComplaints),
common problems by year (forums, CarComplaints), fuel economy, and insurance cost articles.
Call vehicle_complaints for two representative model years. Prices are dealer retail asking,
not private party. Prefer ranges you saw in at least two sources. Set a price to null only if
no example of that age exists."""


async def research(make: str, model: str) -> SeedCar:
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
    messages = [{"role": "user", "content": PROMPT.format(make=make, model=model)}]
    runner = client.beta.messages.tool_runner(
        model=settings.carscout_model, max_tokens=16000,
        tools=[web_search, fetch_page, vehicle_complaints], messages=messages, max_iterations=15,
        betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    final = await runner.until_done()
    notes = "\n".join(b.text for b in final.content if b.type == "text")
    parsed = await client.beta.messages.parse(
        model=settings.carscout_model, max_tokens=4000,
        messages=[{"role": "user", "content": f"Convert these research notes into the SeedCar record:\n\n{notes}"}],
        output_format=SeedCar, betas=["server-side-fallback-2026-07-01"], fallbacks="default",
    )
    if parsed.parsed_output is None:
        raise RuntimeError("no structured output")
    return parsed.parsed_output


def to_row(c: SeedCar) -> dict:
    prices = {str(a): p for a, p in ((3, c.price_age_3), (5, c.price_age_5), (8, c.price_age_8), (12, c.price_age_12)) if p}
    return {
        "id": f"{c.make}-{c.model}".lower().replace(" ", "-"), "make": c.make, "model": c.model, "body": c.body,
        "segment": c.segment, "years": [c.first_year, c.last_year], "price_by_age": prices,
        "reliability": c.reliability, "annual_repair_cost": c.annual_repair_cost, "insurance_tier": c.insurance_tier,
        "mpg_combined": c.mpg_combined, "depreciation_yearly_pct": c.depreciation_yearly_pct,
        "known_issues": c.known_issues, "novice_notes": c.novice_notes, "sources": c.sources,
    }


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("make", nargs="?")
    ap.add_argument("model", nargs="?")
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    if not settings.ai_enabled:
        sys.exit("ANTHROPIC_API_KEY is required")
    data = json.loads(SEED_PATH.read_text())
    targets = [(c["make"], c["model"]) for c in data["cars"]] if args.refresh else [(args.make, args.model)]
    if not targets or targets[0][0] is None:
        ap.error("give MAKE MODEL or --refresh")
    for make, model in targets:
        print(f"researching {make} {model} ...", flush=True)
        row = to_row(await research(make, model))
        data["cars"] = [c for c in data["cars"] if c["id"] != row["id"]] + [row]
        SEED_PATH.write_text(json.dumps(data, indent=1))
        print(f"  saved: {row['price_by_age']} reliability {row['reliability']}")


if __name__ == "__main__":
    asyncio.run(main())
