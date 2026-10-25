"""The GitHub Pages demo (docs/engine.js) must produce the same numbers as the
Python services. Skipped when node is not installed."""
import json
import shutil
import subprocess

import pytest

from app.config import ROOT
from app.services import deal, seed

node = shutil.which("node")

CASES = [
    ("budget", dict(monthly_payment=350, down_payment=2000, term_months=60, credit_tier="prime", driver_age=30, min_reliability=3.5, max_age_years=10)),
    ("grade", dict(listing=dict(year=2018, make="Toyota", model="Camry", price=17500, mileage=72000, seller_type="dealer", title_status="clean"), down_payment=2000, term_months=60, credit_tier="prime", driver_age=30)),
    ("grade", dict(listing=dict(year=2012, make="BMW", model="3 Series", price=6000, mileage=160000, seller_type="auction", title_status="salvage"), down_payment=500, term_months=36, credit_tier="deep_subprime", driver_age=45)),
]

JS = """
const fs = require("fs"); const CS = require(process.argv[1] + "/docs/engine.js");
CS.init(JSON.parse(fs.readFileSync(process.argv[1] + "/data/rates.json")), JSON.parse(fs.readFileSync(process.argv[1] + "/data/seed_cars.json")));
const cases = JSON.parse(fs.readFileSync(0, "utf8"));
console.log(JSON.stringify(cases.map(([kind, a]) => kind === "budget" ? CS.budgetSearch(a) : CS.grade(a.listing, a.down_payment, a.term_months, a.credit_tier, a.driver_age))));
"""


def _strip(o):
    if isinstance(o, dict):
        return {k: _strip(v) for k, v in o.items() if k not in ("message", "listing", "schedule")}
    if isinstance(o, list):
        return [_strip(x) for x in o]
    if isinstance(o, float):
        return round(o, 2)
    return o


@pytest.mark.skipif(node is None, reason="node not installed")
def test_js_engine_matches_python():
    py = []
    for kind, a in CASES:
        if kind == "budget":
            py.append(seed.budget_search(**a))
        else:
            py.append(deal.grade(deal.Listing(**a["listing"]), a["down_payment"], a["term_months"], a["credit_tier"], a["driver_age"]))
    out = subprocess.run([node, "-e", JS, str(ROOT)], input=json.dumps(CASES), capture_output=True, text=True, check=True)
    js = json.loads(out.stdout)
    assert _strip(js) == _strip(json.loads(json.dumps(py, default=str)))


def test_docs_data_is_in_sync_with_source():
    for name in ("rates.json", "seed_cars.json"):
        assert (ROOT / "docs" / "data" / name).read_bytes() == (ROOT / "data" / name).read_bytes(), f"run: cp data/{name} docs/data/"
