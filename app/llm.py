"""Provider-neutral wrapper used by the daily scan: one interface, two backends
(Anthropic Claude and OpenAI). Each backend exposes three calls:

    research(prompt)          free-form answer using the provider's hosted web search
    extract(prompt, Model)    structured output validated against a pydantic model
    write(prompt)             plain text, no tools

The chat UI on the static site has its own browser-side equivalent in docs/ai.js.
"""
from __future__ import annotations

from typing import Protocol, TypeVar

from pydantic import BaseModel

from app.config import settings

T = TypeVar("T", bound=BaseModel)

FALLBACK_BETA = "server-side-fallback-2026-07-01"
# Models that accept the server-side refusal fallback in its "default" form.
FALLBACK_MODELS = ("claude-opus-5", "claude-sonnet-5-5", "claude-fable-5")
MAX_PAUSE_RESUMES = 4


class ProviderError(RuntimeError):
    pass


class Provider(Protocol):
    name: str
    model: str

    async def research(self, prompt: str, system: str = "") -> str: ...
    async def extract(self, prompt: str, schema: type[T], system: str = "") -> T: ...
    async def write(self, prompt: str, system: str = "") -> str: ...


# ---------------------------------------------------------------- Claude
class ClaudeProvider:
    name = "anthropic"

    def __init__(self, api_key: str, model: str):
        import anthropic

        self.model = model
        self.client = anthropic.AsyncAnthropic(api_key=api_key)

    def _extra(self, system: str = "") -> dict:
        extra: dict = {"system": system} if system else {}
        if self.model.startswith(FALLBACK_MODELS):
            extra.update(betas=[FALLBACK_BETA], fallbacks="default")
        return extra

    def _web_tools(self) -> list[dict]:
        # Haiku takes the basic server-tool versions; the others get dynamic filtering.
        if self.model.startswith("claude-haiku"):
            return [{"type": "web_search_20250305", "name": "web_search", "max_uses": 6},
                    {"type": "web_fetch_20250910", "name": "web_fetch", "max_uses": 4}]
        return [{"type": "web_search_20260209", "name": "web_search", "max_uses": 6},
                {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 4}]

    @staticmethod
    def _text(response) -> str:
        return "\n".join(b.text for b in response.content if b.type == "text").strip()

    def _check(self, response) -> None:
        if response.stop_reason == "refusal":
            raise ProviderError("The model declined this request.")

    async def research(self, prompt: str, system: str = "") -> str:
        messages: list[dict] = [{"role": "user", "content": prompt}]
        response = None
        for _ in range(MAX_PAUSE_RESUMES + 1):
            response = await self.client.beta.messages.create(
                model=self.model, max_tokens=16000,
                messages=messages, tools=self._web_tools(),
                output_config={"effort": "medium"}, **self._extra(system),
            )
            self._check(response)
            if response.stop_reason != "pause_turn":
                break
            # Server tool loop hit its iteration limit: resend with the paused turn appended.
            messages.append({"role": "assistant", "content": response.content})
        return self._text(response)

    async def extract(self, prompt: str, schema: type[T], system: str = "") -> T:
        response = await self.client.beta.messages.parse(
            model=self.model, max_tokens=8000,
            messages=[{"role": "user", "content": prompt}],
            output_format=schema, output_config={"effort": "low"}, **self._extra(system),
        )
        self._check(response)
        if response.parsed_output is None:
            raise ProviderError("No structured output returned.")
        return response.parsed_output

    async def write(self, prompt: str, system: str = "") -> str:
        response = await self.client.beta.messages.create(
            model=self.model, max_tokens=4000,
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": "low"}, **self._extra(system),
        )
        self._check(response)
        return self._text(response)


# ---------------------------------------------------------------- OpenAI
class OpenAIProvider:
    name = "openai"

    def __init__(self, api_key: str, model: str):
        import openai

        self.model = model
        self.client = openai.AsyncOpenAI(api_key=api_key)

    async def research(self, prompt: str, system: str = "") -> str:
        response = await self.client.responses.create(
            model=self.model, instructions=system or None, input=prompt,
            tools=[{"type": "web_search"}],
        )
        return (response.output_text or "").strip()

    async def extract(self, prompt: str, schema: type[T], system: str = "") -> T:
        response = await self.client.responses.parse(
            model=self.model, instructions=system or None, input=prompt, text_format=schema,
        )
        if response.output_parsed is None:
            raise ProviderError("No structured output returned.")
        return response.output_parsed

    async def write(self, prompt: str, system: str = "") -> str:
        response = await self.client.responses.create(model=self.model, instructions=system or None, input=prompt)
        return (response.output_text or "").strip()


def from_settings() -> Provider | None:
    """Pick the scan provider from settings. Returns None when no key is configured,
    in which case the scan still runs its free checks (recalls, page status, grading)."""
    choice = settings.scan_provider.lower().strip()
    has_claude, has_openai = bool(settings.anthropic_api_key), bool(settings.openai_api_key)
    if choice in ("", "anthropic", "claude") and has_claude:
        return ClaudeProvider(settings.anthropic_api_key, settings.scan_model or settings.carscout_model)
    if choice in ("", "openai", "chatgpt") and has_openai:
        return OpenAIProvider(settings.openai_api_key, settings.scan_model or settings.openai_model)
    if choice in ("anthropic", "claude") and has_openai:
        return OpenAIProvider(settings.openai_api_key, settings.openai_model)
    if choice in ("openai", "chatgpt") and has_claude:
        return ClaudeProvider(settings.anthropic_api_key, settings.carscout_model)
    return None
