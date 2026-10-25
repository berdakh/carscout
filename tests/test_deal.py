from app.services import deal, seed


def _listing(**kw):
    base = dict(year=seed.CURRENT_YEAR - 5, make="Toyota", model="Camry", price=20000, mileage=60000,
                seller_type="dealer", title_status="clean")
    base.update(kw)
    return deal.Listing(**base)


def test_fair_dealer_price_is_fair():
    car = seed.find("Toyota", "Camry")
    exp = seed.expected_retail_price(car, seed.CURRENT_YEAR - 5, 60000)["expected_retail"]
    g = deal.grade(_listing(price=exp))
    assert g["status"] == "ok"
    assert g["verdict"] == "fair"
    assert g["suggested_offer"] <= exp


def test_private_party_expectation_is_lower_than_dealer():
    g_dealer = deal.grade(_listing(seller_type="dealer"))
    g_private = deal.grade(_listing(seller_type="private"))
    assert g_private["market"]["expected_price_for_channel"] < g_dealer["market"]["expected_price_for_channel"]
    # same asking price looks worse from a private seller
    assert g_private["market"]["asking_vs_expected_pct"] > g_dealer["market"]["asking_vs_expected_pct"]


def test_too_good_to_be_true_is_flagged():
    g = deal.grade(_listing(price=9000))
    assert g["verdict"] == "suspicious"
    assert any(f["level"] == "danger" for f in g["flags"])


def test_overpriced():
    g = deal.grade(_listing(price=40000))
    assert g["verdict"] == "overpriced"


def test_salvage_title_flagged_and_discounted():
    clean = deal.grade(_listing())
    salvage = deal.grade(_listing(title_status="salvage"))
    assert salvage["market"]["expected_retail"] < clean["market"]["expected_retail"]
    assert any("Salvage" in f["text"] for f in salvage["flags"])


def test_unknown_model_returns_guidance_not_crash():
    g = deal.grade(_listing(make="Ferrari", model="F40", price=1500000))
    assert g["status"] == "unknown_model"


def test_grade_includes_financing_and_channels():
    g = deal.grade(_listing(), down_payment=2000, term_months=48, credit_tier="nonprime")
    assert g["financing"]["months"] == 48
    assert g["financing"]["apr_pct"] == 14.0
    assert len(g["channels"]) == 6
    assert g["monthly_cost"]["total"] > g["financing"]["monthly_payment"]
