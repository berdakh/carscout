from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["seed_models"] >= 50


def test_budget_endpoint():
    r = client.post("/api/budget", json={"monthly_payment": 300, "down_payment": 1500, "term_months": 60, "credit_tier": "prime"})
    assert r.status_code == 200
    body = r.json()
    assert body["count"] > 0
    assert body["results"][0]["total_monthly_cost"] <= body["results"][-1]["total_monthly_cost"]


def test_grade_endpoint():
    r = client.post("/api/grade", json={"listing": {"year": 2019, "make": "Honda", "model": "Civic", "price": 17500,
                                                    "mileage": 70000, "seller_type": "private", "title_status": "clean"}})
    assert r.status_code == 200
    assert r.json()["verdict"] in {"suspicious", "great", "good", "fair", "high", "overpriced"}


def test_finance_endpoint_schedule():
    r = client.post("/api/finance", json={"price": 15000, "down_payment": 1000, "term_months": 36, "apr_pct": 8, "include_schedule": True})
    assert r.status_code == 200
    assert len(r.json()["schedule"]) == 36


def test_chat_without_key_is_503(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    r = client.post("/api/chat", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 503


def test_index_serves_frontend():
    r = client.get("/")
    assert r.status_code == 200
    assert "CarScout" in r.text
