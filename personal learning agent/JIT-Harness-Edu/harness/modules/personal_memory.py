"""④ 个人记忆。

两层记忆：
- 工作记忆：最近 history_turns 轮原始对话（在 LearnerState.history 里）；
- 长期记忆：memory/ 下基于 mem0 的记忆库。每轮按当前单元+学生发言检索这个学生的记忆，
  再检索跨学生的“教学经验”；每 write_every 轮把对话交给 mem0 抽取成教育记忆。

长期记忆出错不影响上课：记录警告，退化为只用工作记忆。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from ..protocol import BasePersonalMemory, Directive, LearnerState, MemoryView

logger = logging.getLogger(__name__)


class PersonalMemoryStrategy(BasePersonalMemory):
    DEFAULTS = {"recall_top_k": 5, "experience_top_k": 2, "history_turns": 8,
                "write_every": 2, "focus": ""}

    def __init__(self, spec):
        super().__init__({**self.DEFAULTS, **spec})
        self.store = None            # memory.EduMemory，由 runtime 注入
        self.learner_id = ""
        self._pending: List[Tuple[str, str, Dict[str, Any]]] = []

    def bind(self, store: Optional[Any], learner_id: str) -> None:
        self.store = store
        self.learner_id = learner_id

    def recall(self, query: str, directive: Directive, state: LearnerState) -> MemoryView:
        recalled: List[str] = []
        experiences: List[str] = []
        if self.store is not None:
            try:
                q = f"{directive.unit.title} {query}".strip()
                recalled = [m.text for m in self.store.recall(
                    self.learner_id, q, k=int(self.spec["recall_top_k"]))]
                k_exp = int(self.spec["experience_top_k"])
                if k_exp > 0:
                    eq = f"{directive.unit.content_type} {directive.unit.title}"
                    experiences = [m.text for m in self.store.recall_experience(eq, k=k_exp)]
            except Exception as exc:  # 长期记忆故障不应打断上课
                logger.warning("记忆检索失败，本轮只用工作记忆：%s", exc)

        history = state.history[-2 * int(self.spec["history_turns"]):]
        parts = []
        if recalled:
            parts.append("【关于这个学生，你记得】\n" + "\n".join(f"- {t}" for t in recalled))
        if experiences:
            parts.append("【可参考的教学经验】\n" + "\n".join(f"- {t}" for t in experiences))
        return MemoryView(recalled=recalled, experiences=experiences,
                          history=history, text="\n".join(parts))

    def record(self, user_msg: str, reply: str, state: LearnerState,
               metadata: Dict[str, Any]) -> None:
        self._pending.append((user_msg, reply, metadata))
        if len(self._pending) >= int(self.spec["write_every"]):
            self.flush()

    def flush(self, wait: bool = False) -> None:
        """把待写的对话交给 mem0 抽取成长期记忆。上课中后台写入；下课时 wait=True 等写完。"""
        pending, self._pending = self._pending, []
        if self.store is None:
            return
        if not pending:
            if wait:
                self.store.wait()
            return
        messages = []
        for user_msg, reply, _ in pending:
            messages += [{"role": "user", "content": user_msg},
                         {"role": "assistant", "content": reply}]
        try:
            self.store.remember_turns(self.learner_id, messages, metadata=pending[-1][2],
                                      focus=self.spec["focus"], wait=False)
            if wait:
                self.store.wait()
        except Exception as exc:
            logger.warning("写入长期记忆失败：%s", exc)

    def save_experiences(self, experiences: List[str], metadata: Dict[str, Any]) -> None:
        if self.store is None:
            return
        for text in experiences:
            try:
                self.store.add_experience(text, metadata=metadata)
            except Exception as exc:
                logger.warning("写入教学经验失败：%s", exc)

    def save_note(self, text: str, category: str, metadata: Dict[str, Any]) -> None:
        if self.store is None:
            return
        try:
            self.store.add_note(self.learner_id, text, category=category, metadata=metadata)
        except Exception as exc:
            logger.warning("写入学习记录失败：%s", exc)
