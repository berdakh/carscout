# CarScout

An AI research assistant for first-time used-car buyers. It answers four questions:

1. **What can I afford?** Enter a monthly payment, down payment, loan length and rough credit. It reverses that into a maximum price, then lists cars that fit, ranked by *total* monthly cost (loan + fuel + insurance estimate + typical repairs), not sticker price.
2. **Is this listing a good deal?** Paste the text of a Facebook Marketplace, Craigslist, Autotrader or dealer listing (or a screenshot). It extracts the details, compares the asking price to the expected price for that kind of seller, flags red flags and known problems for that model, suggests an opening offer, and shows what the same car typically costs at a dealer, from a private seller, on Facebook, and at auction.
3. **Ask anything.** A conversational agent that can search the web, read pages, check NHTSA recalls and complaints, pull EPA fuel economy, run the budget search and grade listings.
4. **How do I actually buy a car?** A built-in playbook: inspection checklist, scams, paperwork, negotiation, channel comparison.

## Design decision: no paid data APIs

There is no listings feed. Instead:

| Need | Source | Cost |
|---|---|---|
| Which cars fit a budget | `data/seed_cars.json`, 69 popular models with price-by-age, reliability, repair cost, insurance tier, mpg, known issues | free, refresh with `scripts/build_seed.py` |
| Market price of a specific car | seed table + live web search of CarGurus / Edmunds / KBB / iSeeCars pages by the agent | free |
| Recalls, complaints, VIN decode | NHTSA public APIs | free, no key |
| Fuel economy | fueleconomy.gov | free, no key |
| Loan math, depreciation, negative equity | `app/services/finance.py`, deterministic | free |
| APR by credit tier, insurance by class, channel multipliers | `data/rates.json`, editable planning assumptions | free |
| Web search | Brave or Tavily free tier if you add a key, DuckDuckGo otherwise | free |
| The model | Anthropic API, `claude-opus-5-5` by default | pay per use, a few cents per research run |

Facebook Marketplace and Craigslist cannot be fetched by a bot. The app generates nothing from them directly; the user pastes the listing text or a screenshot and the AI parses it.

## Run it

```bash
cd carscout
python -m venv .venv && . .venv/bin/activate     # or: uv venv && . .venv/bin/activate
pip install -e ".[dev]"                           # or: uv pip install -e ".[dev]"
cp .env.example .env                              # add ANTHROPIC_API_KEY for the AI features
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000. Budget search, manual grading, the finance calculator and the guide work with no API key at all. The chat assistant and the paste-a-listing parser need `ANTHROPIC_API_KEY`.

Tests (no network, no key):

```bash
pytest
```

## Project layout

```
app/
  main.py              FastAPI routes + serves the frontend
  config.py            settings from .env (all optional)
  agent/
    agent.py           tool-runner loop for chat; structured-output listing parser
    tools.py           the 10 tools the model can call
    prompts.py         system prompts
  services/
    finance.py         amortization, reverse budget, depreciation, total cost of ownership
    seed.py            seed table lookup, price interpolation, budget search, channel prices
    deal.py            Listing schema and the deal grader
    nhtsa.py           VIN decode, recalls, complaints
    fueleconomy.py     EPA mpg
    search.py          Brave -> Tavily -> DuckDuckGo chain
    fetch.py           page fetch to readable text
data/
  seed_cars.json       the model table (generated from scripts/_seed_source.py)
  rates.json           APRs, insurance tiers, channel multipliers, mileage and title adjustments
frontend/              single-page UI, vanilla JS, no build step
scripts/
  _seed_source.py      compact hand-maintained source for seed_cars.json
  build_seed.py        research a model with the agent and add/refresh it in the seed table
tests/                 28+ tests covering finance math, seed search, grading, API, agent loop
```

## API

| Method | Path | What |
|---|---|---|
| GET | `/api/health` | AI enabled, model, search provider, seed size |
| POST | `/api/budget` | `{monthly_payment, down_payment, term_months, credit_tier, driver_age, body_types?, min_reliability?, max_age_years?}` |
| POST | `/api/grade` | `{listing: {year, make, model, price, mileage?, seller_type?, title_status?, ...}, down_payment?, term_months?, credit_tier?, driver_age?}` |
| POST | `/api/finance` | `{price, down_payment, term_months, credit_tier|apr_pct, depreciation_yearly_pct, include_schedule}` |
| POST | `/api/listing/parse` | multipart: `text` and/or `image`, parses with the model then grades (needs key) |
| POST | `/api/chat` | `{messages:[...]}` full history ending with a user turn; returns `text`, `new_messages` to append, `tool_calls` (needs key) |
| GET | `/api/vin/{vin}`, `/api/recalls`, `/api/complaints`, `/api/mpg`, `/api/search`, `/api/fetch` | free-data passthroughs |

## Accuracy, honestly

- Seed prices are approximate national dealer asking prices for 2026, written from general market knowledge. Expect them to be off by 5-10% in either direction, more in high- or low-cost regions. Run `python scripts/build_seed.py --refresh` with a key to replace them with researched numbers and sources.
- Insurance is a tier-based estimate scaled by driver age. It is for ranking cars against each other, not for budgeting to the dollar. Get a real quote.
- APRs are tier averages. A credit union pre-approval beats any number here.
- The grader's verdict thresholds (great under -10%, fair within -3% to +5%, overpriced above +12%) are opinions, tune them in `app/services/deal.py`.

## Roadmap ideas

- Save searches and graded listings (SQLite), with price-drop alerts via re-grading.
- Region adjustment: ask for a ZIP and scale seed prices with a regional index.
- Insurance quote hand-off to a comparison site, deep links to Autotrader / Cars.com / CarGurus / Craigslist / Facebook with prefilled filters.
- Streaming chat responses with visible tool progress.
- Mobile wrapper once the web flow settles.
