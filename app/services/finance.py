"""Deterministic money math. Nothing here calls a model or the network, so the
numbers the app shows a buyer are always reproducible."""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from functools import lru_cache

from app.config import DATA_DIR, settings


@lru_cache(maxsize=1)
def rates() -> dict:
    with open(DATA_DIR / "rates.json") as f:
        return json.load(f)


def apr_for_tier(credit_tier: str) -> float:
    """Average used-car APR for a credit tier. Values live in data/rates.json so
    they can be refreshed from Experian's quarterly report without code changes."""
    table = rates()["used_car_apr_by_credit_tier"]
    return float(table.get(credit_tier, table["prime"]))


def monthly_payment(principal: float, apr_pct: float, months: int) -> float:
    if months <= 0:
        raise ValueError("months must be positive")
    if principal <= 0:
        return 0.0
    r = apr_pct / 100 / 12
    if r == 0:
        return principal / months
    return principal * r / (1 - (1 + r) ** -months)


def max_loan_for_payment(payment: float, apr_pct: float, months: int) -> float:
    """Inverse of monthly_payment: the largest principal this payment supports."""
    if months <= 0:
        raise ValueError("months must be positive")
    if payment <= 0:
        return 0.0
    r = apr_pct / 100 / 12
    if r == 0:
        return payment * months
    return payment * (1 - (1 + r) ** -months) / r


def max_purchase_price(
    payment: float,
    down: float,
    apr_pct: float,
    months: int,
    sales_tax_pct: float | None = None,
    fees: float | None = None,
) -> float:
    """What sticker price fits the budget once tax and fees are rolled in.
    loan = price*(1+tax) + fees - down  =>  price = (loan + down - fees)/(1+tax)"""
    tax = (settings.carscout_sales_tax_pct if sales_tax_pct is None else sales_tax_pct) / 100
    fees = settings.carscout_doc_fees if fees is None else fees
    loan = max_loan_for_payment(payment, apr_pct, months)
    return max(0.0, (loan + down - fees) / (1 + tax))


def amount_financed(price: float, down: float, sales_tax_pct: float | None = None, fees: float | None = None) -> float:
    tax = (settings.carscout_sales_tax_pct if sales_tax_pct is None else sales_tax_pct) / 100
    fees = settings.carscout_doc_fees if fees is None else fees
    return max(0.0, price * (1 + tax) + fees - down)


@dataclass
class ScheduleRow:
    month: int
    payment: float
    interest: float
    principal: float
    balance: float
    est_value: float
    equity: float


@dataclass
class LoanSummary:
    price: float
    amount_financed: float
    apr_pct: float
    months: int
    monthly_payment: float
    total_interest: float
    total_cost: float
    months_underwater: int
    worst_negative_equity: float
    schedule: list[ScheduleRow] = field(default_factory=list)

    def to_dict(self, include_schedule: bool = False) -> dict:
        d = asdict(self)
        if not include_schedule:
            d.pop("schedule")
        return d


def depreciation_curve(price: float, months: int, yearly_pct: float) -> list[float]:
    """Estimated resale value at the end of each month, geometric decay."""
    monthly_factor = (1 - yearly_pct / 100) ** (1 / 12)
    return [price * monthly_factor ** m for m in range(1, months + 1)]


def loan_summary(
    price: float,
    down: float,
    apr_pct: float,
    months: int,
    depreciation_yearly_pct: float = 12.0,
    sales_tax_pct: float | None = None,
    fees: float | None = None,
) -> LoanSummary:
    financed = amount_financed(price, down, sales_tax_pct, fees)
    pay = monthly_payment(financed, apr_pct, months)
    r = apr_pct / 100 / 12
    balance = financed
    values = depreciation_curve(price, months, depreciation_yearly_pct)
    rows: list[ScheduleRow] = []
    total_interest = 0.0
    underwater = 0
    worst = 0.0
    for m in range(1, months + 1):
        interest = balance * r
        principal = min(pay - interest, balance)
        balance = max(0.0, balance - principal)
        total_interest += interest
        equity = values[m - 1] - balance
        if equity < 0:
            underwater += 1
            worst = min(worst, equity)
        rows.append(ScheduleRow(m, round(pay, 2), round(interest, 2), round(principal, 2),
                                round(balance, 2), round(values[m - 1], 2), round(equity, 2)))
    return LoanSummary(
        price=round(price, 2),
        amount_financed=round(financed, 2),
        apr_pct=apr_pct,
        months=months,
        monthly_payment=round(pay, 2),
        total_interest=round(total_interest, 2),
        total_cost=round(down + pay * months, 2),
        months_underwater=underwater,
        worst_negative_equity=round(worst, 2),
        schedule=rows,
    )


def monthly_fuel_cost(mpg: float, miles_per_year: int | None = None, gas_price: float | None = None) -> float:
    miles = settings.carscout_miles_per_year if miles_per_year is None else miles_per_year
    gas = settings.carscout_gas_price if gas_price is None else gas_price
    if mpg <= 0:
        return 0.0
    return miles / mpg * gas / 12


def monthly_insurance_estimate(insurance_tier: int, driver_age: int = 30) -> float:
    """Rough full-coverage monthly premium. This is a planning number, not a quote.
    Tiers and age factors are in data/rates.json."""
    base = rates()["insurance_monthly_by_tier"][str(int(insurance_tier))]
    factor = 1.0
    for band in rates()["insurance_driver_age_factor"]:
        if band["min_age"] <= driver_age <= band["max_age"]:
            factor = band["factor"]
            break
    return base * factor


def total_monthly_cost(
    payment: float,
    mpg: float,
    insurance_tier: int,
    annual_repair_cost: float,
    driver_age: int = 30,
    miles_per_year: int | None = None,
) -> dict:
    fuel = monthly_fuel_cost(mpg, miles_per_year)
    ins = monthly_insurance_estimate(insurance_tier, driver_age)
    repairs = annual_repair_cost / 12
    return {
        "payment": round(payment, 2),
        "fuel": round(fuel, 2),
        "insurance": round(ins, 2),
        "maintenance_repairs": round(repairs, 2),
        "total": round(payment + fuel + ins + repairs, 2),
    }
