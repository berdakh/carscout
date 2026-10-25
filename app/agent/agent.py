"""Conversational agent built on the Anthropic SDK tool runner, plus a structured
listing parser. The API is stateless, so the caller keeps the message history and
sends it back each turn."""
from __future__ import annotations

import base64
from typing import Any

import anthropic

from app.agent.prompts import LISTING_PARSER_PROMPT, SYSTEM_PROMPT
from app.agent.tools import ALL_TOOLS
from app.config import settings
from app.services.deal import Listing

MAX_RESTARTS = 3


def _client() -> anthropic.AsyncAnthropic:
    if not settings.ai_enabled:
        raise RuntimeError("ANTHROPIC_API_KEY is not set. Add it to .env to enable the assistant.")
    return anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)


def _serializable(content: Any) -> Any:
    """Convert SDK content blocks to plain dicts so they survive a JSON round trip to the browser."""
    out = []
    for block in content:
        if hasattr(block, "model_dump"):
            out.append(block.model_dump(exclude_none=True))
        else:
            out.append(block)
    return out


async def chat(messages: list[dict]) -> dict:
    """Run one assistant turn. `messages` is the full history ending in a user message.
    Returns the final text plus the new messages (assistant turns and tool results) to append."""
    client = _client()
    history = list(messages)
    new_messages: list[dict] = []
    final_text = ""
    tool_calls: list[dict] = []
    restarts = 0

    while True:
        runner = client.beta.messages.tool_runner(
            model=settings.carscout_model,
            max_tokens=16000,
            system=[{"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}}],
            tools=ALL_TOOLS,
            messages=history,
            max_iterations=12,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        last = None
        async for message in runner:
            last = message
            if message.stop_reason == "refusal":
                final_text = "I can't help with that part of the request."
                break
            assistant_msg = {"role": "assistant", "content": _serializable(message.content)}
            history.append(assistant_msg)
            new_messages.append(assistant_msg)
            for block in message.content:
                if block.type == "tool_use":
                    tool_calls.append({"name": block.name, "input": block.input})
            tool_response = await runner.generate_tool_call_response()
            if tool_response is not None:
                tr = {"role": "user", "content": _serializable(tool_response["content"])}
                history.append(tr)
                new_messages.append(tr)
        if last is None or last.stop_reason != "pause_turn":
            break
        restarts += 1
        if restarts > MAX_RESTARTS:
            break

    if last is not None and last.stop_reason != "refusal":
        final_text = "\n".join(b.text for b in last.content if b.type == "text").strip()
    return {"text": final_text, "new_messages": new_messages, "tool_calls": tool_calls,
            "stop_reason": last.stop_reason if last else None}


async def parse_listing(text: str = "", image_b64: str | None = None, image_media_type: str = "image/png") -> Listing:
    """Turn pasted listing text and/or a screenshot into a Listing using structured outputs."""
    client = _client()
    content: list[dict] = []
    if image_b64:
        content.append({"type": "image", "source": {"type": "base64", "media_type": image_media_type, "data": image_b64}})
    content.append({"type": "text", "text": text or "Extract the listing from the screenshot."})
    response = await client.beta.messages.parse(
        model=settings.carscout_model,
        max_tokens=4000,
        system=LISTING_PARSER_PROMPT,
        messages=[{"role": "user", "content": content}],
        output_format=Listing,
        betas=["server-side-fallback-2026-07-01"],
        fallbacks="default",
    )
    if response.stop_reason == "refusal" or response.parsed_output is None:
        raise ValueError("Could not extract a listing from that input.")
    return response.parsed_output


def encode_image(data: bytes) -> str:
    return base64.standard_b64encode(data).decode("utf-8")
