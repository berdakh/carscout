from app.services import seed


def test_seed_loads_and_has_required_fields():
    cars = seed.load()
    assert len(cars) >= 50
    for c in cars:
        for k in ("make", "model", "body", "years", "price_by_age", "reliability", "annual_repair_cost",
                  "insurance_tier", "mpg_combined", "depreciation_yearly_pct", "known_issues", "novice_notes"):
            assert k in c, (c["id"], k)
        assert 1 <= c["reliability"] <= 5
        assert 1 <= c["insurance_tier"] <= 5
        prices = [v for _, v in sorted((int(k), v) for k, v in c["price_by_age"].items())]
        assert prices == sorted(prices, reverse=True), f"{c['id']} prices should fall with age"


def test_find_is_forgiving():
    assert seed.find("toyota", "camry")["model"] == "Camry"
    assert seed.find("Chevrolet", "Silverado")["model"] == "Silverado 1500"
    assert seed.find("Honda", "Civic LX")["model"] == "Civic"
    assert seed.find("Ferrari", "F40") is None


def test_price_interpolates_and_extrapolates():
    car = seed.find("Toyota", "Camry")
    p3, p4, p5 = (seed.price_at_age(car, a) for a in (3, 4, 5))
    assert p3 > p4 > p5
    assert seed.price_at_age(car, 20) < seed.price_at_age(car, 12)
    assert seed.price_at_age(car, 1) == seed.price_at_age(car, 3)  # clamped at the newest point


def test_mileage_and_title_move_the_price():
    car = seed.find("Honda", "Accord")
    year = seed.CURRENT_YEAR - 5
    base = seed.expected_retail_price(car, year)["expected_retail"]
    high = seed.expected_retail_price(car, year, mileage=120000)["expected_retail"]
    low = seed.expected_retail_price(car, year, mileage=30000)["expected_retail"]
    salvage = seed.expected_retail_price(car, year, title="salvage")["expected_retail"]
    assert low > base > high
    assert salvage < base * 0.6


def test_budget_search_respects_budget_and_ranks_by_total_cost():
    out = seed.budget_search(350, 2000, 60, "prime", driver_age=30)
    assert out["max_purchase_price"] > 10000
    assert out["count"] > 5
    for r in out["results"]:
        assert r["expected_retail"] <= out["max_purchase_price"]
        assert r["monthly_payment"] <= 350 + 1
    totals = [r["total_monthly_cost"] for r in out["results"]]
    assert totals == sorted(totals)


def test_budget_search_filters():
    out = seed.budget_search(400, 0, 60, "prime", body_types=["truck"], min_reliability=4.0)
    assert all(r["body"] == "truck" and r["reliability"] >= 4.0 for r in out["results"])


def test_channel_prices_order():
    rows = {r["channel"]: r for r in seed.channel_prices(20000)}
    assert rows["cpo_dealer"]["all_in"] > rows["dealer_retail"]["all_in"] > rows["private_party"]["all_in"]
    assert rows["auction_hammer"]["fees"] > 0
