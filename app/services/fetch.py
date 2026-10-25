"""Fetch a public web page and reduce it to readable text for the model."""
from __future__ import annotations

import re

import httpx
from bs4 import BeautifulSoup

UA = "Mozilla/5.0 (X11; Linux x86_64) CarScout/0.1 (personal research tool)"
TIMEOUT = 20.0
MAX_CHARS = 12000


async def fetch_page(url: str, max_chars: int = MAX_CHARS) -> dict:
    if not url.lower().startswith(("http://", "https://")):
        return {"error": "URL must start with http:// or https://"}
    async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True, headers={"User-Agent": UA}) as client:
        r = await client.get(url)
    ctype = r.headers.get("content-type", "")
    if r.status_code >= 400:
        return {"url": url, "status": r.status_code,
                "error": "Page refused the request. Facebook, Craigslist and some dealers block bots; paste the listing text instead."}
    if "html" not in ctype and "text" not in ctype:
        return {"url": url, "status": r.status_code, "error": f"Unsupported content type {ctype}"}
    soup = BeautifulSoup(r.text, "lxml")
    for tag in soup(["script", "style", "noscript", "svg", "nav", "footer", "header", "iframe"]):
        tag.decompose()
    title = soup.title.string.strip() if soup.title and soup.title.string else ""
    text = soup.get_text("\n")
    text = re.sub(r"\n\s*\n+", "\n", text)
    text = re.sub(r"[ \t]+", " ", text).strip()
    truncated = len(text) > max_chars
    return {"url": str(r.url), "status": r.status_code, "title": title,
            "text": text[:max_chars], "truncated": truncated}
