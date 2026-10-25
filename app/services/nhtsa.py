"""Free, keyless US government vehicle data (NHTSA). Three endpoints:
VIN decode (vPIC), recalls, and owner complaints."""
from __future__ import annotations

import httpx

VPIC = "https://vpic.nhtsa.dot.gov/api/vehicles"
NHTSA_API = "https://api.nhtsa.gov"
TIMEOUT = 20.0

KEEP_FIELDS = ["Make", "Model", "ModelYear", "Trim", "BodyClass", "DriveType", "EngineCylinders",
               "DisplacementL", "FuelTypePrimary", "TransmissionStyle", "PlantCountry", "VehicleType",
               "ErrorText"]


async def decode_vin(vin: str) -> dict:
    vin = vin.strip().upper()
    if len(vin) != 17:
        return {"error": "A VIN is 17 characters."}
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"{VPIC}/DecodeVinValues/{vin}", params={"format": "json"})
        r.raise_for_status()
        row = r.json()["Results"][0]
    out = {k: row.get(k) for k in KEEP_FIELDS if row.get(k)}
    out["vin"] = vin
    return out


async def recalls(year: int, make: str, model: str) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"{NHTSA_API}/recalls/recallsByVehicle",
                             params={"make": make, "model": model, "modelYear": year})
        r.raise_for_status()
        data = r.json()
    items = [{
        "campaign": x.get("NHTSACampaignNumber"), "date": x.get("ReportReceivedDate"),
        "component": x.get("Component"), "summary": x.get("Summary"), "remedy": x.get("Remedy"),
    } for x in data.get("results", [])]
    return {"year": year, "make": make, "model": model, "count": len(items), "recalls": items}


async def complaints(year: int, make: str, model: str, limit: int = 25) -> dict:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get(f"{NHTSA_API}/complaints/complaintsByVehicle",
                             params={"make": make, "model": model, "modelYear": year})
        r.raise_for_status()
        data = r.json()
    results = data.get("results", [])
    by_component: dict[str, int] = {}
    for c in results:
        comp = (c.get("components") or "UNKNOWN").split(",")[0].strip()
        by_component[comp] = by_component.get(comp, 0) + 1
    top = sorted(by_component.items(), key=lambda kv: -kv[1])[:10]
    samples = [{"date": c.get("dateOfIncident"), "component": c.get("components"),
                "summary": (c.get("summary") or "")[:300]} for c in results[:limit]]
    return {"year": year, "make": make, "model": model, "total_complaints": len(results),
            "top_components": [{"component": k, "count": v} for k, v in top], "samples": samples}
