"""EduMemory：基于 mem0 开源版的教育记忆库。

两个作用域：
- 学生记忆   user_id=学生ID。上课对话交给 mem0 自动抽取，每条以【类别】开头
- 教学经验   agent_id=edu_teacher。跨学生可复用，由课后总结或种子文件直接写入

所有读写都经过这里，harness 只依赖这个类的几个方法：
remember_turns / add_note / add_experience / recall / recall_experience / digest / wait

线程：所有 mem0 调用都在一个专用后台线程里执行（本地 Qdrant 要求始终在创建它的线程里访问）。
上课时的记忆写入不必等待（学生不会感到卡顿），之后的读取会自动排在写入后面，读到的总是最新的。
"""

from __future__ import annotations

import logging
import os
import re
import sys
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from settings import Settings

from .config import build_mem0_config
from .prompts import EDU_MEMORY_INSTRUCTIONS, EXPERIENCE_CATEGORY, LEARNER_CATEGORIES

logger = logging.getLogger(__name__)

TEACHER_ID = "edu_teacher"
SEED_FILE = Path(__file__).parent / "seed_experiences.yaml"


@dataclass
class MemoryItem:
    id: str
    text: str
    category: str
    score: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    created_at: str = ""


def _category(text: str) -> str:
    m = re.match(r"\s*【(.+?)】", text)
    return m.group(1) if m else "其他"


def _with_tag(text: str, category: str) -> str:
    text = text.strip()
    return text if text.startswith("【") else f"【{category}】{text}"


def _to_items(result: Any) -> List[MemoryItem]:
    rows = result.get("results", []) if isinstance(result, dict) else (result or [])
    items = []
    for r in rows:
        text = r.get("memory", "")
        if not text:
            continue
        items.append(MemoryItem(id=r.get("id", ""), text=text, category=_category(text),
                                score=r.get("score"), metadata=r.get("metadata") or {},
                                created_at=r.get("created_at") or ""))
    return items


class EduMemory:
    def __init__(self, settings: Optional[Settings] = None, config: Optional[Dict[str, Any]] = None):
        settings = settings or Settings.load()
        # mem0 在 import 时读取这两个环境变量：关闭遥测，数据目录放进项目里
        os.environ.setdefault("MEM0_TELEMETRY", "False")
        os.environ.setdefault("MEM0_DIR", str(settings.data_dir / "mem0"))
        if sys.platform == "darwin" and settings.embed_provider == "fastembed":
            # ONNX Runtime's macOS telemetry worker can abort during process exit.
            import onnxruntime
            onnxruntime.disable_telemetry_events()
        from mem0 import Memory

        self._worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="edu-memory")
        self._pending: List[Future] = []
        self.m = self._call(Memory.from_config, config or build_mem0_config(settings))

    def _call(self, fn, *args, **kwargs):
        """在记忆线程里执行并等待结果。"""
        return self._worker.submit(fn, *args, **kwargs).result()

    def wait(self) -> None:
        """等所有未完成的后台写入结束（下课时调用）。"""
        pending, self._pending = self._pending, []
        for fut in pending:
            try:
                fut.result()
            except Exception as exc:
                logger.warning("后台写入记忆失败：%s", exc)

    # ── 写 ──

    def remember_turns(self, learner_id: str, messages: List[Dict[str, str]],
                       metadata: Optional[Dict[str, Any]] = None, focus: str = "",
                       wait: bool = True) -> List[MemoryItem]:
        """把一段上课对话交给 mem0，自动抽取成学生记忆。wait=False 时后台写入、立即返回。"""
        prompt = EDU_MEMORY_INSTRUCTIONS
        if focus:
            prompt += f"\n本项目特别需要记住：{focus}"
        fut = self._worker.submit(self.m.add, messages, user_id=learner_id,
                                  metadata=metadata or {}, prompt=prompt)
        if not wait:
            self._pending.append(fut)
            return []
        return _to_items(fut.result())

    def add_note(self, learner_id: str, text: str, category: str = "学习进度",
                 metadata: Optional[Dict[str, Any]] = None) -> None:
        """直接写一条学生记忆（不经过模型抽取）。"""
        self._call(self.m.add, _with_tag(text, category), user_id=learner_id,
                   metadata={**(metadata or {}), "category": category}, infer=False)

    def add_experience(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """写一条跨学生的教学经验。"""
        self._call(self.m.add, _with_tag(text, EXPERIENCE_CATEGORY), agent_id=TEACHER_ID,
                   metadata={**(metadata or {}), "category": EXPERIENCE_CATEGORY}, infer=False)

    def seed_experiences(self, path: Path = SEED_FILE) -> int:
        """导入内置的教学经验（基于学习科学的常见结论），返回导入条数。"""
        rows = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or []
        for row in rows:
            self.add_experience(row["text"], metadata={"source": "seed",
                                                       "content_type": row.get("content_type", "通用")})
        return len(rows)

    # ── 读 ──

    def recall(self, learner_id: str, query: str, k: int = 5) -> List[MemoryItem]:
        if not query.strip():
            return []
        return _to_items(self._call(self.m.search, query, filters={"user_id": learner_id}, top_k=k))

    def recall_experience(self, query: str, k: int = 3) -> List[MemoryItem]:
        if not query.strip():
            return []
        return _to_items(self._call(self.m.search, query, filters={"agent_id": TEACHER_ID}, top_k=k))

    def list(self, learner_id: Optional[str] = None, limit: int = 100) -> List[MemoryItem]:
        """列出某个学生的全部记忆；不传 learner_id 则列出教学经验。"""
        filters = {"user_id": learner_id} if learner_id else {"agent_id": TEACHER_ID}
        return _to_items(self._call(self.m.get_all, filters=filters, top_k=limit))

    def profile(self, learner_id: str, limit: int = 200) -> Dict[str, List[str]]:
        """按类别归组的学生画像。"""
        groups: Dict[str, List[str]] = {}
        for item in self.list(learner_id, limit=limit):
            groups.setdefault(item.category, []).append(re.sub(r"^\s*【.+?】", "", item.text))
        order = list(LEARNER_CATEGORIES) + ["其他"]
        return {c: groups[c] for c in sorted(groups, key=lambda c: order.index(c) if c in order else 99)}

    def digest(self, learner_id: str, per_category: int = 5) -> str:
        """给 harness 生成用的学生记忆摘要。"""
        groups = self.profile(learner_id)
        lines = []
        for category, texts in groups.items():
            lines.append(f"【{category}】")
            lines += [f"- {t}" for t in texts[-per_category:]]
        return "\n".join(lines)

    # ── 删 ──

    def delete(self, memory_id: str) -> None:
        self._call(self.m.delete, memory_id)

    def forget_learner(self, learner_id: str) -> None:
        self._call(self.m.delete_all, user_id=learner_id)
