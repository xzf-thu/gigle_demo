"""② 内容学习能力。

同一个学生在不同类型内容上的能力不同（概念懂得快、记忆差……）。本模块按内容类型
分别维护能力估计，据此给出本轮的难度目标、呈现方式和可用学习活动。
"""

from __future__ import annotations

from ..catalog import CONTENT_TYPE_DESC
from ..protocol import AbilityView, BaseAbility, LearnerState, TurnEval

LEVELS = [(0.8, "精通"), (0.6, "熟练"), (0.4, "基础"), (0.0, "入门")]
DIFFICULTY_WORDS = [(0.7, "有挑战：综合题、变式题、需要多步推理"),
                    (0.5, "中等：两三步推理，情境略有变化"),
                    (0.3, "基础：步骤少，与例子结构相同"),
                    (0.0, "非常基础：一步一题，给足提示")]


def _pick(table, value):
    return next(label for bound, label in table if value >= bound)


class AbilityStrategy(BaseAbility):
    DEFAULTS = {"learning_rate": 0.2, "stretch": 0.1, "initial": {}, "profiles": {}}

    def __init__(self, spec):
        super().__init__({**self.DEFAULTS, **spec})

    def level(self, content_type: str, state: LearnerState) -> float:
        if content_type in state.ability:
            return state.ability[content_type]
        return float(self.spec["initial"].get(content_type, 0.5))

    def view(self, content_type: str, state: LearnerState) -> AbilityView:
        lv = self.level(content_type, state)
        target = min(1.0, lv + self.spec["stretch"])
        profile = self.spec["profiles"].get(content_type, {}) or {}
        reps = list(profile.get("representations", []))
        acts = list(profile.get("activities", []))
        label = _pick(LEVELS, lv)

        lines = [
            f"【内容与能力】本单元属于「{content_type}」：{CONTENT_TYPE_DESC.get(content_type, '')}",
            f"学生在此类内容上的水平：{label}（{lv:.2f}）；本轮难度目标 {target:.2f} → "
            f"{_pick(DIFFICULTY_WORDS, target)}（略高于现有水平，保持在最近发展区）",
        ]
        if reps:
            lines.append(f"优先的呈现方式：{'、'.join(reps)}")
        if acts:
            lines.append(f"可用的学习活动：{'、'.join(acts)}")
        if profile.get("note"):
            lines.append(f"注意：{profile['note']}")
        return AbilityView(content_type=content_type, level=lv, label=label,
                           target_difficulty=target, representations=reps,
                           activities=acts, text="\n".join(lines))

    def update(self, content_type: str, state: LearnerState, ev: TurnEval) -> None:
        if ev.score is None:
            return
        lv = self.level(content_type, state)
        state.ability[content_type] = round(lv + self.spec["learning_rate"] * (ev.score - lv), 3)
