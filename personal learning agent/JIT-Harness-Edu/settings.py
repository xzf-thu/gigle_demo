"""统一配置：从 .env / 环境变量读取。

三个模型角色（可以是同一个模型）：
- JIT_MODEL     生成模型：每个教育项目创建时生成一次 harness
- TUTOR_MODEL   执行模型：按 harness 上课
- MEMORY_MODEL  记忆模型：mem0 用它从对话中抽取教育体验
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent

try:  # python-dotenv 可选；已导出的环境变量优先
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env", override=False)
except ImportError:
    pass


def _env(key: str, default: str = "") -> str:
    """空值（如 .env 里写了 KEY=）也当作没配置，用默认值。"""
    return os.environ.get(key, "").strip() or default


def _path(key: str, default: str) -> Path:
    p = Path(_env(key, default)).expanduser()
    return p if p.is_absolute() else ROOT / p


@dataclass(frozen=True)
class Settings:
    llm_base_url: str
    llm_api_key: str
    jit_model: str
    tutor_model: str
    memory_model: str

    embed_provider: str
    embed_base_url: str
    embed_api_key: str
    embed_model: str
    embed_dims: int
    embed_send_dims: bool

    data_dir: Path
    projects_dir: Path

    @classmethod
    def load(cls) -> "Settings":
        # 默认阿里云百炼：一个 Key 同时提供对话模型和向量模型
        base_url = _env("LLM_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
        api_key = _env("LLM_API_KEY")
        default_model = _env("TUTOR_MODEL", "qwen-plus")
        return cls(
            llm_base_url=base_url,
            llm_api_key=api_key,
            jit_model=_env("JIT_MODEL", default_model),
            tutor_model=default_model,
            memory_model=_env("MEMORY_MODEL", default_model),
            embed_provider=_env("EMBED_PROVIDER", "openai"),
            embed_base_url=_env("EMBED_BASE_URL", base_url),
            embed_api_key=_env("EMBED_API_KEY", api_key),
            embed_model=_env("EMBED_MODEL", "text-embedding-v3"),
            embed_dims=int(_env("EMBED_DIMS", "1024")),
            embed_send_dims=_env("EMBED_SEND_DIMS", "false").lower() in ("1", "true", "yes"),
            data_dir=_path("EDU_DATA_DIR", "data"),
            projects_dir=_path("EDU_PROJECTS_DIR", "projects"),
        )
