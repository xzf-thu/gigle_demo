"""③ 教育技巧。

决定这一轮“具体怎么教”：用哪个教学技巧、怎么反馈、要不要出检测题。

选择规则：
- 宏观模块给出特殊情况（放慢/复习/进阶/结课）时，用对应的专门技巧；
- 否则在该内容类型的候选技巧里挑：没对这个学生试过的先试，试过的挑平均效果最好的，
  并避免同一技巧连用超过两次。
效果归因：学生在第 t+1 轮的作答，是对第 t 轮技巧的反馈，所以分数记到上一条记录上。
"""

from __future__ import annotations

from statistics import mean
from typing import Dict, List, Tuple

from ..catalog import DEFAULT_TECHNIQUES_BY_TYPE, TECHNIQUES
from ..protocol import AbilityView, BaseTechnique, Directive, LearnerState, TechniquePlan, TurnEval

MODE_TO_KEY = {"放慢": "on_struggle", "超时": "on_struggle", "复习": "on_review",
               "进阶": "on_mastery", "结课": "on_mastery"}


class TechniqueStrategy(BaseTechnique):
    DEFAULTS = {"by_content_type": {}, "on_struggle": "支架渐隐", "on_review": "检索练习",
                "on_mastery": "迁移挑战", "assess_every": 2,
                "feedback_style": "先具体肯定做对的一点，再指出最关键的一个问题", "avoid": []}

    def __init__(self, spec):
        super().__init__({**self.DEFAULTS, **spec})

    def choose(self, directive: Directive, ability: AbilityView, state: LearnerState) -> TechniquePlan:
        s = self.spec
        key = MODE_TO_KEY.get(directive.mode)
        if key:
            name, reason = s[key], f"本轮是「{directive.mode}」，使用专门技巧"
        else:
            candidates = (s["by_content_type"].get(ability.content_type)
                          or DEFAULT_TECHNIQUES_BY_TYPE[ability.content_type])
            name, reason = self._pick(candidates, state)

        every = max(1, int(s["assess_every"]))
        assess = directive.mode in ("复习", "进阶", "结课") or (state.turns_in_unit + 1) % every == 0

        lines = [f"【本轮教学技巧：{name}】{TECHNIQUES.get(name, '')}",
                 f"选择理由：{reason}",
                 f"反馈方式：{s['feedback_style']}"]
        if s["avoid"]:
            lines.append(f"避免：{'、'.join(s['avoid'])}")
        if assess:
            lines.append("本轮结尾请出一道检测题（只出一道，等学生作答后再讲评）。")
        return TechniquePlan(name=name, instruction="\n".join(lines), assess=assess, reason=reason)

    def update(self, plan: TechniquePlan, state: LearnerState, ev: TurnEval) -> None:
        if state.technique_log and ev.score is not None:
            state.technique_log[-1]["score"] = ev.score
        state.technique_log.append({"technique": plan.name, "score": None})
        state.technique_log = state.technique_log[-200:]

    @staticmethod
    def _pick(candidates: List[str], state: LearnerState) -> Tuple[str, str]:
        tried = {r["technique"] for r in state.technique_log}
        for c in candidates:
            if c not in tried:
                return c, "还没对这个学生用过，先试一试"

        scores: Dict[str, List[float]] = {}
        for r in state.technique_log:
            if r["score"] is not None:
                scores.setdefault(r["technique"], []).append(r["score"])
        ranked = sorted(candidates, key=lambda c: mean(scores.get(c, [0.5])), reverse=True)

        last_two = [r["technique"] for r in state.technique_log[-2:]]
        best = ranked[0]
        if last_two == [best, best] and len(ranked) > 1:
            return ranked[1], f"「{best}」已连用两次，换一种保持新鲜感"
        return best, f"对这个学生平均效果最好（{mean(scores.get(best, [0.5])):.2f}）"
