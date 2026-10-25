"""FastAPI app: JSON API plus the static single-page frontend."""
from __future__ import annotations

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.config import FRONTEND_DIR, settings
from app.services import deal, finance, fueleconomy, nhtsa, seed
from app.services import search as search_svc
from app.services import fetch as fetch_svc

app = FastAPI(title="CarScout", version="0.1.0")


class BudgetRequest(BaseModel):
    monthly_payment: float = Field(gt=0)
    down_payment: float = 0
    term_months: int = Field(default=60, ge=12, le=96)
    credit_tier: str = "prime"
    driver_age: int = Field(default=30, ge=16, le=100)
    miles_per_year: int | None = None
    body_types: list[str] | None = None
    min_reliability: float = 0
    max_age_years: int = 12
    limit: int = 15


class GradeRequest(BaseModel):
    listing: deal.Listing
    down_payment: float = 0
    term_months: int = 60
    credit_tier: str = "prime"
    driver_age: int = 30


class FinanceRequest(BaseModel):
    price: float
    down_payment: float = 0
    term_months: int = 60
    credit_tier: str = "prime"
    apr_pct: float | None = None
    depreciation_yearly_pct: float = 12
    include_schedule: bool = False


class ChatRequest(BaseModel):
    messages: list[dict]


@app.get("/api/health")
def health():
    return {"ok": True, "ai_enabled": settings.ai_enabled, "model": settings.carscout_model,
            "seed_models": len(seed.load()), "search_provider": "brave" if settings.brave_api_key
            else "tavily" if settings.tavily_api_key else "duckduckgo"}


@app.get("/api/rates")
def get_rates():
    return finance.rates()


@app.get("/api/seed")
def list_seed():
    return [{k: c[k] for k in ("id", "make", "model", "body", "segment", "years", "reliability")} for c in seed.load()]


@app.post("/api/budget")
def budget(req: BudgetRequest):
    return seed.budget_search(**req.model_dump())


@app.post("/api/finance")
def finance_calc(req: FinanceRequest):
    apr = req.apr_pct if req.apr_pct is not None else finance.apr_for_tier(req.credit_tier)
    return finance.loan_summary(req.price, req.down_payment, apr, req.term_months,
                                req.depreciation_yearly_pct).to_dict(include_schedule=req.include_schedule)


@app.post("/api/grade")
def grade(req: GradeRequest):
    return deal.grade(req.listing, req.down_payment, req.term_months, req.credit_tier, req.driver_age)


@app.post("/api/listing/parse")
async def listing_parse(text: str = Form(""), image: UploadFile | None = File(None),
                        down_payment: float = Form(0), term_months: int = Form(60),
                        credit_tier: str = Form("prime"), driver_age: int = Form(30)):
    """Paste listing text and/or upload a screenshot. Parses with the model, then grades."""
    if not settings.ai_enabled:
        raise HTTPException(503, "Set ANTHROPIC_API_KEY to use the listing parser. You can still grade a listing by filling the fields manually.")
    from app.agent import agent
    img_b64 = None
    media = "image/png"
    if image is not None:
        data = await image.read()
        img_b64 = agent.encode_image(data)
        media = image.content_type or media
    if not text and img_b64 is None:
        raise HTTPException(400, "Provide listing text or a screenshot.")
    try:
        listing = await agent.parse_listing(text, img_b64, media)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return deal.grade(listing, down_payment, term_months, credit_tier, driver_age)


@app.post("/api/chat")
async def chat(req: ChatRequest):
    if not settings.ai_enabled:
        raise HTTPException(503, "Set ANTHROPIC_API_KEY in .env to enable the assistant.")
    if not req.messages or req.messages[-1].get("role") != "user":
        raise HTTPException(400, "messages must end with a user message")
    from app.agent import agent
    return await agent.chat(req.messages)


# Free data passthroughs, handy for the UI and for debugging without the model.
@app.get("/api/vin/{vin}")
async def vin(vin: str):
    return await nhtsa.decode_vin(vin)


@app.get("/api/recalls")
async def recalls(year: int, make: str, model: str):
    return await nhtsa.recalls(year, make, model)


@app.get("/api/complaints")
async def complaints(year: int, make: str, model: str):
    return await nhtsa.complaints(year, make, model)


@app.get("/api/mpg")
async def mpg(year: int, make: str, model: str):
    return await fueleconomy.fuel_economy(year, make, model)


@app.get("/api/search")
async def search(q: str, n: int = 6):
    return await search_svc.web_search(q, n)


@app.get("/api/fetch")
async def fetch(url: str):
    return await fetch_svc.fetch_page(url)


@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
