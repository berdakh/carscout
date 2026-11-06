"""Runtime settings. Everything has a default so the app runs with no .env at all;
only the AI endpoints need ANTHROPIC_API_KEY."""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DOCS_DIR = ROOT / "docs"
WATCHLIST_PATH = DOCS_DIR / "data" / "watchlist.json"
REPORTS_DIR = DOCS_DIR / "reports"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    anthropic_api_key: str = ""
    carscout_model: str = "claude-opus-5-5"
    openai_api_key: str = ""
    openai_model: str = "gpt-5.5"

    # Daily scan: which provider and model to use. Empty provider = Claude if its key
    # is set, else OpenAI. Empty model = carscout_model / openai_model.
    scan_provider: str = ""
    scan_model: str = ""
    scan_max_searches: int = 5
    scan_max_listings: int = 20
    brave_api_key: str = ""
    tavily_api_key: str = ""

    carscout_sales_tax_pct: float = 7.0
    carscout_doc_fees: float = 500.0
    carscout_gas_price: float = 3.40
    carscout_miles_per_year: int = 12000

    @property
    def ai_enabled(self) -> bool:
        return bool(self.anthropic_api_key)


settings = Settings()
