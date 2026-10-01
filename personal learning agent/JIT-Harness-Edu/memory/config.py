"""把 settings 转成 mem0 的配置。

默认：LLM 走 OpenAI 兼容接口；向量库用本地 Qdrant（落盘到 data/mem0/qdrant）；
历史记录 SQLite 落在 data/mem0/history.db。换向量库/嵌入服务只需改这里。
"""

from __future__ import annotations

from typing import Any, Dict

from settings import Settings

from .prompts import EDU_MEMORY_INSTRUCTIONS


def build_mem0_config(s: Settings) -> Dict[str, Any]:
    root = s.data_dir / "mem0"
    root.mkdir(parents=True, exist_ok=True)

    embedder: Dict[str, Any] = {"model": s.embed_model}
    if s.embed_provider == "openai":          # 任何 OpenAI 兼容的 /v1/embeddings
        embedder.update(api_key=s.embed_api_key or "EMPTY", openai_base_url=s.embed_base_url)
        if s.embed_send_dims:
            embedder["embedding_dims"] = s.embed_dims
    elif s.embed_provider == "ollama":
        embedder.update(ollama_base_url=s.embed_base_url, embedding_dims=s.embed_dims)
    elif s.embed_provider == "huggingface":   # 本地 sentence-transformers，如 BAAI/bge-small-zh-v1.5
        embedder.update(embedding_dims=s.embed_dims)
    elif s.embed_provider == "fastembed":
        embedder.update(embedding_dims=s.embed_dims)

    return {
        "llm": {
            "provider": "openai",
            "config": {
                "model": s.memory_model,
                "api_key": s.llm_api_key or "EMPTY",
                "openai_base_url": s.llm_base_url,
                "temperature": 0.1,
                "max_tokens": 2000,
            },
        },
        "embedder": {"provider": s.embed_provider, "config": embedder},
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": "edu_memory",
                "path": str(root / "qdrant"),
                "on_disk": True,
                "embedding_model_dims": s.embed_dims,
            },
        },
        "history_db_path": str(root / "history.db"),
        "custom_instructions": EDU_MEMORY_INSTRUCTIONS,
    }
