"""Gigle 本机服务的单次调用入口。JSON 从 stdin 读入，结果从 stdout 返回。"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import replace
from pathlib import Path

from agent import EduAgent
from memory import EduMemory
from settings import Settings

GIGLE_ROOT = Path(__file__).resolve().parents[2]

def settings_for(atom_dir: Path) -> Settings:
    settings = Settings.load()
    data_dir = Path(os.environ.get("EDU_DATA_DIR", GIGLE_ROOT / "data/user/learning_agent_data"))
    os.environ.setdefault("FASTEMBED_CACHE_PATH", str(GIGLE_ROOT / ".cache/fastembed"))
    if "EMBED_PROVIDER" not in os.environ and "EMBED_API_KEY" not in os.environ:
        settings = replace(settings, embed_provider="fastembed",
                           embed_model="BAAI/bge-small-zh-v1.5", embed_dims=512)
    elif settings.embed_provider == "fastembed":
        settings = replace(settings,
                           embed_model=os.environ.get("EMBED_MODEL") or "BAAI/bge-small-zh-v1.5",
                           embed_dims=int(os.environ.get("EMBED_DIMS") or "512"))
    return replace(settings, data_dir=data_dir, projects_dir=atom_dir / "learning-agent")


def memory_configured(settings: Settings) -> bool:
    return settings.embed_provider != "openai" or bool(os.environ.get("EMBED_API_KEY"))


def main() -> None:
    payload = json.load(sys.stdin)
    atom_dir = Path(payload["atom_dir"]).resolve()
    project_id = payload["project_id"]
    settings = settings_for(atom_dir)
    if not settings.llm_api_key:
        raise RuntimeError("请先设置 DeepSeek API 密钥，再创建项目")

    if payload["action"] == "create":
        if not memory_configured(settings):
            raise RuntimeError("mem0 缺少向量模型密钥。请设置 EMBED_API_KEY，或移除 EMBED_PROVIDER 以使用本机中文模型。")
        agent = EduAgent(settings, use_memory=True)
        if agent.memory is None:
            raise RuntimeError(f"mem0 初始化失败：{agent.memory_error}")
        project, harness, report = agent.create_project(
            title=payload["title"], subject=payload["subject"], goal=payload["goal"],
            learner_id=os.environ.get("GIGLE_LEARNER_ID", "gigle-local-learner"),
            materials=payload.get("materials", ""), project_id=project_id,
        )
        if not report.get("valid"):
            raise RuntimeError("项目专属 harness 校验失败，请重试")
        result = {"project_id": project.id, "harness_path": str(agent.project_dir(project.id) / "harness.yaml"),
                  "memory_available": agent.memory is not None}
    elif payload["action"] == "remember":
        if not memory_configured(settings):
            raise RuntimeError("mem0 需要向量模型。请在启动前设置 EMBED_API_KEY、EMBED_BASE_URL、EMBED_MODEL 和 EMBED_DIMS，或配置本地向量模型。")
        memory = EduMemory(settings)
        memory.add_note(
            os.environ.get("GIGLE_LEARNER_ID", "gigle-local-learner"),
            payload["experience"], category="学习进度",
            metadata={"project_id": project_id, "atom_id": project_id,
                      "study_seconds": payload["study_seconds"], "source": "gigle-whiteboard"},
        )
        result = {"saved": True}
    else:
        raise ValueError("未知操作")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        sys.exit(1)
