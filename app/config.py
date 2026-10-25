"""Runtime settings. Everything has a default so the app runs with no .env at all;
only the AI endpoints need ANTHROPIC_API_KEY."""
from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
FRONTEND_DIR = ROOT / "frontend"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / ".env", extra="ignore")

    anthropic_api_key: str = ""
    carscout_model: str = "claude-opus-5-5"
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
