"""OpenAI 兼容的对话模型客户端 + 输出解析小工具。

任何兼容 /v1/chat/completions 的服务都能用（DeepSeek、通义、智谱、Kimi、vLLM……）。
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, Iterator, List, Optional

from openai import OpenAI


class LLM:
    def __init__(self, model: str, base_url: str, api_key: str,
                 temperature: float = 0.7, max_tokens: int = 4096, timeout: float = 120):
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.client = OpenAI(base_url=base_url, api_key=api_key or "EMPTY", timeout=timeout)
        self.total_tokens = 0  # 累计 token，作为 harness 的“成本”信号

    def chat(self, messages: List[Dict[str, str]], temperature: Optional[float] = None,
             json_mode: bool = False) -> str:
        kwargs: Dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature if temperature is None else temperature,
            "max_tokens": self.max_tokens,
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        resp = self.client.chat.completions.create(**kwargs)
        if resp.usage is not None:
            self.total_tokens += int(resp.usage.total_tokens or 0)
        return strip_think(resp.choices[0].message.content or "")

    def chat_json(self, messages: List[Dict[str, str]], temperature: float = 0.2) -> Dict[str, Any]:
        """要一个 JSON 对象；服务不支持 json_mode 时退回普通模式再解析。"""
        try:
            text = self.chat(messages, temperature=temperature, json_mode=True)
        except Exception:
            text = self.chat(messages, temperature=temperature)
        return extract_json(text)

    def chat_stream(self, messages: List[Dict[str, Any]]) -> Iterator[str]:
        stream = self.client.chat.completions.create(
            model=self.model, messages=messages, temperature=self.temperature,
            max_tokens=self.max_tokens, stream=True,
        )
        for chunk in stream:
            if chunk.choices:
                content = chunk.choices[0].delta.content
                if content:
                    yield content


def strip_think(text: str) -> str:
    """去掉推理模型输出里的 <think>…</think>。"""
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()


def extract_tagged(text: str, tag: str) -> Optional[str]:
    """取 <<<TAG>>> … <<<END_TAG>>> 之间的内容。

    与 JIT 一样取“最后一个”匹配：模型常在分析里先写一个骨架，真正的块在最后。
    """
    pattern = re.compile(rf"<<<{re.escape(tag)}>>>(.*?)<<<END_{re.escape(tag)}>>>", re.DOTALL)
    matches = pattern.findall(text)
    if not matches:
        return None
    block = matches[-1].strip("\n")
    return block if block.strip() else None


def strip_tagged(text: str, tag: str) -> str:
    pattern = re.compile(rf"<<<{re.escape(tag)}>>>.*?<<<END_{re.escape(tag)}>>>", re.DOTALL)
    return pattern.sub("", text).strip()


def extract_json(text: str) -> Dict[str, Any]:
    """从模型输出里尽力解析出一个 JSON 对象，失败返回 {}。"""
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        pass
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            data = json.loads(m.group(0))
            return data if isinstance(data, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}
