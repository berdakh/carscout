"""Web search with a free-provider chain: Brave (free tier, key) -> Tavily (free tier,
key) -> DuckDuckGo via the ddgs package (no key, best effort). Returns a uniform
list of {title, url, snippet}."""
from __future__ import annotations

import asyncio

import httpx

from app.config import settings

TIMEOUT = 15.0


async def _brave(query: str, n: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.get("https://api.search.brave.com/res/v1/web/search",
                             params={"q": query, "count": n},
                             headers={"X-Subscription-Token": settings.brave_api_key, "Accept": "application/json"})
        r.raise_for_status()
        items = r.json().get("web", {}).get("results", [])
    return [{"title": i.get("title"), "url": i.get("url"), "snippet": i.get("description")} for i in items[:n]]


async def _tavily(query: str, n: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        r = await client.post("https://api.tavily.com/search",
                              json={"api_key": settings.tavily_api_key, "query": query, "max_results": n})
        r.raise_for_status()
        items = r.json().get("results", [])
    return [{"title": i.get("title"), "url": i.get("url"), "snippet": i.get("content")} for i in items[:n]]


def _ddg_sync(query: str, n: int) -> list[dict]:
    from ddgs import DDGS
    items = DDGS().text(query, max_results=n)
    return [{"title": i.get("title"), "url": i.get("href"), "snippet": i.get("body")} for i in items[:n]]


async def web_search(query: str, max_results: int = 6) -> dict:
    errors = []
    providers = []
    if settings.brave_api_key:
        providers.append(("brave", lambda: _brave(query, max_results)))
    if settings.tavily_api_key:
        providers.append(("tavily", lambda: _tavily(query, max_results)))
    providers.append(("duckduckgo", lambda: asyncio.to_thread(_ddg_sync, query, max_results)))
    for name, fn in providers:
        try:
            results = await fn()
            if results:
                return {"provider": name, "query": query, "results": results}
        except Exception as e:  # noqa: BLE001 - we want to fall through to the next provider
            errors.append(f"{name}: {type(e).__name__}: {e}")
    return {"provider": None, "query": query, "results": [], "errors": errors}
