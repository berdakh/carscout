import math

from app.services import finance


def test_payment_matches_known_amortization():
    # $20,000 at 6% for 60 months is the textbook $386.66
    assert math.isclose(finance.monthly_payment(20000, 6.0, 60), 386.66, abs_tol=0.01)


def test_zero_apr_is_straight_division():
    assert finance.monthly_payment(12000, 0, 48) == 250


def test_max_loan_inverts_payment():
    p = finance.monthly_payment(15000, 9.5, 60)
    assert math.isclose(finance.max_loan_for_payment(p, 9.5, 60), 15000, rel_tol=1e-9)


def test_max_price_accounts_for_tax_and_fees():
    price = finance.max_purchase_price(350, 2000, 9.5, 60, sales_tax_pct=7, fees=500)
    loan = finance.max_loan_for_payment(350, 9.5, 60)
    assert math.isclose(price * 1.07 + 500 - 2000, loan, rel_tol=1e-9)


def test_loan_summary_pays_off_and_tracks_equity():
    s = finance.loan_summary(18000, 1000, 9.5, 60, depreciation_yearly_pct=12, sales_tax_pct=7, fees=500)
    assert s.schedule[-1].balance == 0
    assert s.total_interest > 0
    assert s.months_underwater > 0  # financing tax and fees with little down starts underwater
    assert s.monthly_payment == round(finance.monthly_payment(s.amount_financed, 9.5, 60), 2)


def test_apr_tier_lookup_falls_back_to_prime():
    assert finance.apr_for_tier("prime") == finance.apr_for_tier("nonsense")
    assert finance.apr_for_tier("subprime") > finance.apr_for_tier("super_prime")


def test_insurance_estimate_scales_with_age_and_tier():
    young = finance.monthly_insurance_estimate(3, 19)
    adult = finance.monthly_insurance_estimate(3, 35)
    assert young > adult
    assert finance.monthly_insurance_estimate(5, 35) > finance.monthly_insurance_estimate(1, 35)


def test_total_monthly_cost_sums():
    t = finance.total_monthly_cost(300, 30, 2, 480, 30, miles_per_year=12000)
    assert math.isclose(t["total"], t["payment"] + t["fuel"] + t["insurance"] + t["maintenance_repairs"], abs_tol=0.02)
