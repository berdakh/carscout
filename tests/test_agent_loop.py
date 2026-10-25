"""Exercises the chat() loop with a fake SDK runner so the history mirroring and
refusal handling are covered without network or an API key."""
import json
from types import SimpleNamespace

import pytest

from app.agent import agent


class FakeBlock(SimpleNamespace):
    def model_dump(self, exclude_none=True):
        return {k: v for k, v in vars(self).items() if v is not None}


class FakeRunner:
    """Yields two assistant turns: one tool call, then a final text answer."""
    def __init__(self):
        self.turn = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        self.turn += 1
        if self.turn == 1:
            return SimpleNamespace(stop_reason="tool_use", content=[
                FakeBlock(type="tool_use", id="toolu_1", name="budget_search", input={"monthly_payment": 300})])
        if self.turn == 2:
            return SimpleNamespace(stop_reason="end_turn", content=[FakeBlock(type="text", text="Here are your options.")])
        raise StopAsyncIteration

    async def generate_tool_call_response(self):
        if self.turn == 1:
            return {"role": "user", "content": [FakeBlock(type="tool_result", tool_use_id="toolu_1", content=json.dumps({"ok": 1}))]}
        return None


class RefusingRunner(FakeRunner):
    async def __anext__(self):
        self.turn += 1
        if self.turn == 1:
            return SimpleNamespace(stop_reason="refusal", content=[])
        raise StopAsyncIteration


def _patch(monkeypatch, runner_cls):
    from app.config import settings
    monkeypatch.setattr(settings, "anthropic_api_key", "test-key")
    fake_client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(tool_runner=lambda **kw: runner_cls())))
    monkeypatch.setattr(agent.anthropic, "AsyncAnthropic", lambda api_key: fake_client)


@pytest.mark.asyncio
async def test_chat_mirrors_history_and_returns_text(monkeypatch):
    _patch(monkeypatch, FakeRunner)
    out = await agent.chat([{"role": "user", "content": "I can pay $300 a month"}])
    assert out["text"] == "Here are your options."
    assert out["stop_reason"] == "end_turn"
    assert [m["role"] for m in out["new_messages"]] == ["assistant", "user", "assistant"]
    assert out["new_messages"][1]["content"][0]["type"] == "tool_result"
    assert out["tool_calls"] == [{"name": "budget_search", "input": {"monthly_payment": 300}}]
    json.dumps(out)  # everything must be JSON-serializable for the browser


@pytest.mark.asyncio
async def test_chat_handles_refusal(monkeypatch):
    _patch(monkeypatch, RefusingRunner)
    out = await agent.chat([{"role": "user", "content": "x"}])
    assert "can't help" in out["text"]
    assert out["new_messages"] == []


def test_chat_requires_key(monkeypatch):
    from app.config import settings
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    with pytest.raises(RuntimeError):
        agent._client()
