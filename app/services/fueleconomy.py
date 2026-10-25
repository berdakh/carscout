"""Free EPA fuel economy data from fueleconomy.gov (XML, no key)."""
from __future__ import annotations

import httpx
from bs4 import BeautifulSoup

BASE = "https://www.fueleconomy.gov/ws/rest"
TIMEOUT = 20.0


async def fuel_economy(year: int, make: str, model: str) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"{BASE}/vehicle/menu/options", params={"year": year, "make": make, "model": model})
        r.raise_for_status()
        menu = BeautifulSoup(r.text, "xml")
        options = [(m.find("text").text, m.find("value").text) for m in menu.find_all("menuItem")]
        if not options:
            # fueleconomy.gov model names often include trim; try prefix match over the model list
            r2 = await client.get(f"{BASE}/vehicle/menu/model", params={"year": year, "make": make})
            r2.raise_for_status()
            models = [m.find("text").text for m in BeautifulSoup(r2.text, "xml").find_all("menuItem")]
            cands = [m for m in models if m.lower().startswith(model.lower())]
            if not cands:
                return {"error": f"No EPA record for {year} {make} {model}", "available_models": models[:40]}
            r = await client.get(f"{BASE}/vehicle/menu/options", params={"year": year, "make": make, "model": cands[0]})
            menu = BeautifulSoup(r.text, "xml")
            options = [(m.find("text").text, m.find("value").text) for m in menu.find_all("menuItem")]
        variants = []
        for text, vid in options[:6]:
            v = await client.get(f"{BASE}/vehicle/{vid}")
            doc = BeautifulSoup(v.text, "xml")
            get = lambda tag: (doc.find(tag).text if doc.find(tag) else None)
            variants.append({
                "variant": text, "mpg_city": get("city08"), "mpg_highway": get("highway08"),
                "mpg_combined": get("comb08"), "fuel": get("fuelType"), "annual_fuel_cost_usd": get("fuelCost08"),
                "co2_g_per_mile": get("co2TailpipeGpm"),
            })
    return {"year": year, "make": make, "model": model, "variants": variants}
