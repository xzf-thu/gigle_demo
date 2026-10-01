"""① 宏观方式与速度。

决定：用什么教学范式、每个单元计划多少轮、何时进入下一单元、何时插入复习、何时放慢。
掌握学习式的推进规则：掌握度过线 → 下一轮做确认检测（“进阶”）→ 确认通过才前进。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..catalog import APPROACHES, PACES
from ..protocol import BasePacing, Directive, LearnerState, TurnEval, Unit

MASTERY_ALPHA = 0.5   # 掌握度指数平滑系数：新证据占一半

MODE_TEXT = {
    "新授": "开始新单元。先用一两句话说明本单元学什么、为什么有用，再教第一个要点。",
    "巩固": "围绕尚未掌握的目标讲练结合，一次只推进一步。",
    "放慢": "学生最近吃力。放慢：把当前内容拆成更小的步骤，先确认前置知识，只推进一小步。",
    "复习": "插入一次间隔复习：简短回顾之前的单元「{review}」，出 1 道小题检验是否还记得，然后回到当前单元。",
    "进阶": "学生在本单元的掌握度已过线。如果学生刚答对了确认题，简短肯定并预告下一单元，不再出新题；"
            "否则出一道确认性检测题（变式或迁移题），通过即进入下一单元。",
    "超时": "本单元已超出计划轮数。收束：聚焦最核心的一个目标保证最低掌握，其余标记为课后巩固。",
    "结课": "所有单元已完成。做总复盘：请学生总结收获，再给一道综合题检验。",
}


class PacingStrategy(BasePacing):
    DEFAULTS = {"pace": "中", "turns_per_unit": 8, "mastery_threshold": 0.8,
                "slow_down_below": 0.5, "review_every": 5}

    def __init__(self, spec):
        super().__init__({**self.DEFAULTS, **spec})
        self._units = [
            Unit(id=str(u["id"]), title=str(u["title"]), content_type=u["content_type"],
                 objectives=[str(o) for o in u.get("objectives", [])])
            for u in self.spec["units"]
        ]

    def units(self) -> List[Unit]:
        return self._units

    def budget(self) -> int:
        """每单元计划轮数 = turns_per_unit × 速度系数（慢 1.5 / 中 1.0 / 快 0.7）。"""
        return max(2, round(self.spec["turns_per_unit"] * PACES.get(self.spec["pace"], 1.0)))

    def directive(self, state: LearnerState) -> Directive:
        s = self.spec
        if state.finished:
            return self._make(state, self._units[-1], "结课")

        unit = self._units[state.unit_index]
        mastery = state.mastery.get(unit.id, 0.0)
        recent = state.recent_scores[-2:]

        if state.turns_in_unit == 0:
            return self._make(state, unit, "新授")
        if mastery >= s["mastery_threshold"]:
            return self._make(state, unit, "进阶")
        if len(recent) == 2 and sum(recent) / 2 < s["slow_down_below"]:
            return self._make(state, unit, "放慢")
        if (s["review_every"] and state.unit_index > 0
                and state.turns_in_unit % s["review_every"] == 0):
            earlier = self._units[:state.unit_index]
            review = min(earlier, key=lambda u: state.mastery.get(u.id, 0.0))
            return self._make(state, unit, "复习", review)
        if state.turns_in_unit >= self.budget():
            return self._make(state, unit, "超时")
        return self._make(state, unit, "巩固")

    def update(self, state: LearnerState, directive: Directive, prev: Dict[str, Any],
               ev: TurnEval) -> Optional[str]:
        if directive.mode == "结课":
            return None
        unit = directive.unit
        state.turns_in_unit += 1

        # 学生本轮的作答回应的是上一轮的提问：分数记到上一轮的单元（复习时记到被复习的单元）
        if ev.score is not None and prev:
            target = prev.get("review_unit") or prev["unit"]
            old = state.mastery.get(target, 0.0)
            state.mastery[target] = round(old + MASTERY_ALPHA * (ev.score - old), 3)
            if target == unit.id:
                state.recent_scores = (state.recent_scores + [ev.score])[-6:]

        threshold = self.spec["mastery_threshold"]
        confirmed = (prev.get("mode") == "进阶" and prev.get("unit") == unit.id
                     and ev.score is not None and ev.score >= threshold)
        overdue = state.turns_in_unit >= 2 * self.budget()  # 速度控制：不无限卡在一个单元
        if not (confirmed or overdue):
            return None

        note = "达标" if confirmed else "超时，未完全达标，标记为待巩固"
        state.unit_index += 1
        state.turns_in_unit = 0
        state.recent_scores = []
        if state.unit_index >= len(self._units):
            state.unit_index = len(self._units) - 1
            state.finished = True
            return f"单元「{unit.title}」{note}；全部单元完成"
        nxt = self._units[state.unit_index]
        return f"单元「{unit.title}」{note}，进入下一单元「{nxt.title}」"

    def _make(self, state: LearnerState, unit: Unit, mode: str,
              review: Optional[Unit] = None) -> Directive:
        s = self.spec
        idx = self._units.index(unit)
        mastery = state.mastery.get(unit.id, 0.0)
        objectives = "\n".join(f"  - {o}" for o in unit.objectives) or "  - （未列出）"
        mode_text = MODE_TEXT[mode].format(review=review.title if review else "")
        text = (
            f"【宏观】教学范式：{s['approach']}（{APPROACHES.get(s['approach'], '')}）速度：{s['pace']}\n"
            f"【进度】第 {idx + 1}/{len(self._units)} 单元「{unit.title}」（{unit.content_type}），"
            f"掌握度 {mastery:.0%}，本单元第 {state.turns_in_unit + 1} 轮 / 计划 {self.budget()} 轮\n"
            f"【单元目标】\n{objectives}\n"
            f"【本轮安排：{mode}】{mode_text}"
        )
        return Directive(unit=unit, mode=mode, text=text, review_unit=review)
