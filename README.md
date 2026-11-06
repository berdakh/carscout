# CarScout

An AI research assistant for first-time used-car buyers. Live at **https://berdakh.github.io/carscout/**.

- **Budget search.** Enter a monthly payment, down payment, loan length and rough credit. It works out the maximum price you can pay, then lists cars that fit, ranked by *total* monthly cost (loan + fuel + insurance estimate + typical repairs).
- **Deal grader.** Paste a Facebook Marketplace, Craigslist, Autotrader or dealer listing, or a screenshot. The AI extracts the details; the grader compares the price to what that kind of seller usually asks, flags red flags and known problems, suggests an opening offer, and shows what the same car costs at a dealer, privately, on Facebook and at auction.
- **Ask CarScout.** Chat with Claude or ChatGPT, using your own API key. It searches the web, checks NHTSA recalls, decodes VINs, runs the budget search, grades listings, and reads your watchlist and daily report.
- **Watchlist.** Save searches and listings. "Analyze with AI" ranks them and tells you the next step.
- **Daily report.** A GitHub Actions job scans your watchlist every day: price drops, sold listings, new recalls, and live local prices for the top picks of each saved search. The report shows up on the site.
- **Buyer's guide.** Inspection checklist, scams, paperwork, negotiation, channel comparison.

Everything runs as a static site on GitHub Pages. There is no server to host and no paid data feed; the only cost is your own AI usage.

## Setup

### 1. Use it with AI (two minutes)

1. Get an API key from [console.anthropic.com](https://console.anthropic.com) (Claude) or [platform.openai.com](https://platform.openai.com) (ChatGPT). You can add both and switch.
2. Open the site, click **Settings**, paste the key, pick a model, press **Test connection**, then **Save settings**.

The key is stored only in your browser's localStorage and is sent only to the provider you picked. Anyone using the same browser profile can use it, so set it up on your own device and set a monthly spend limit in the provider's console. Without a key, the budget search, manual grading, financing math and guide all still work.

### 2. Turn on the daily scan (ten minutes)

The scan runs in GitHub Actions (`.github/workflows/daily-scan.yml`) every day at 12:23 UTC, reads `docs/data/watchlist.json`, and commits a report to `docs/reports/`, which the site's **Daily report** tab shows.

1. **Give the scan an AI key.** Repository Settings → Secrets and variables → Actions → *New repository secret*: `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY`. Optional *variables*: `SCAN_PROVIDER` (`anthropic` or `openai`) and `SCAN_MODEL` (for example `claude-sonnet-5-5`). Without a key the scan still runs the free checks: recalls, whether listing pages still exist, and re-grading.
2. **Let the site save your watchlist to the repo.** Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with access to *only this repository* and the permissions **Contents: Read and write** and **Actions: Read and write**. Paste it in the site's Settings under *Daily scan*. From then on every change to your watchlist is saved to the repo, and **Run scan now** on the Daily report tab starts a scan immediately.
   No token? Use **Download JSON** on the Watchlist tab and commit the file as `docs/data/watchlist.json`.
3. Save a search or a listing (with its URL), then press **Run scan now** or wait for the schedule. The report appears a few minutes after the run finishes.

To change the time, edit the `cron` line in the workflow (it is in UTC).

### What the scan does

| Check | Needs AI key | What you see |
|---|---|---|
| Listing page still loads | no | "No longer listed" when the page returns 404 |
| Current asking price on the listing page | yes | Price drop / price up / no change, with the % change |
| Re-grade at today's price | no | Verdict and suggested offer |
| NHTSA recalls for each saved car | no | New recalls since the last scan |
| Live local prices for each saved search's top 3 picks | yes | Price range, trend, up to 3 real listings with links, sources |
| Short written digest | yes | "Act today" summary at the top |

Facebook Marketplace and Craigslist block automated checks, so listings from those show "Site blocks checks". Dealer sites, Autotrader, Cars.com and CarGurus usually work.

### Cost

You pay your AI provider directly. Rough figures per daily scan:

| Item | Claude Opus 5.5 (default) | Claude Sonnet 5.5 | Notes |
|---|---|---|---|
| Each saved search | $0.10 – $0.30 | about half | Web searches plus reading results |
| Each saved listing with a URL | about $0.02 | about $0.01 | Reads one page |
| Digest | about $0.01 | less | |

Two saved searches and five listings is roughly $0.30 – $0.70 a day with Opus, $10 – $20 a month. Set `SCAN_MODEL` to `claude-sonnet-5-5` or `gpt-5.4-mini` to cut that. Limits `SCAN_MAX_SEARCHES` (5) and `SCAN_MAX_LISTINGS` (20) cap a runaway watchlist. Chat costs a few cents per question.

### Privacy

The repository is public, so the committed watchlist and the daily reports are public too. They contain the cars and listings you save and the area you set, nothing else. Make the repository private if that matters (GitHub Pages on a private repo needs a paid GitHub plan).

## How it is built

| Part | Where | Notes |
|---|---|---|
| Static site | `docs/` | Vanilla JS, no build step. Served by GitHub Pages and by the local server. |
| Pricing, grading, finance engine | `docs/engine.js`, `app/services/` | Same logic in JS and Python; a test checks they agree. |
| AI in the browser | `docs/ai.js` | Official Anthropic and OpenAI JS SDKs bundled in `docs/vendor/ai-sdks.js`. Tools run locally; web search runs on the provider. Claude requests use the server-side refusal fallback. |
| Watchlist and GitHub sync | `docs/store.js` | localStorage, plus the GitHub contents API when a token is set. |
| Daily scan | `scripts/daily_scan.py`, `app/llm.py` | One interface over Claude and OpenAI. Every check is isolated; failures are listed in the report. |
| Seed data | `data/seed_cars.json`, `data/rates.json` | 69 models; planning assumptions for APR, insurance and channel prices. Copied to `docs/data/`. |
| Optional JSON API | `app/main.py` | FastAPI; also serves the site locally. |

Rebuild the SDK bundle after changing SDK versions:

```bash
cd web && npm install && npm run build
```

## Run locally

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --reload          # site at http://127.0.0.1:8000
```

Run the daily scan by hand (put keys in `.env`, see `.env.example`):

```bash
python scripts/daily_scan.py --dry-run
```

Tests, all offline:

```bash
pytest
```

The suite covers the finance math, budget search, grading, the API, the scan with a fake AI provider, JS/Python parity, and an end-to-end browser test of the site with every external API mocked. The browser test needs Node and Playwright and is skipped without them.

After editing `data/seed_cars.json` or `data/rates.json`:

```bash
cp data/seed_cars.json data/rates.json docs/data/
```

## Accuracy, honestly

- Seed prices are approximate national dealer asking prices for 2026. Expect them to be off by 5-10%, more in high- or low-cost areas. The AI research and the daily scan use live local data on top of them. `python scripts/build_seed.py --refresh` re-researches the whole table with Claude.
- Insurance is a tier estimate scaled by driver age, for comparing cars, not budgeting to the dollar. Get a real quote.
- APRs are tier averages. A credit union pre-approval beats any number here.
- The AI is told never to invent prices or links and to cite sources, and the scan drops any link that is not a plain web address. Still check a listing yourself before acting on it.
