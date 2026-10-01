"""TutorRuntime：固定编排器，把四个模块接起来上课。

每一轮：
    ① pacing.directive      本轮在哪个单元、做什么（新授/巩固/复习/放慢/进阶/结课）
    ② ability.view          这类内容学生水平如何、难度与活动
    ③ technique.choose      用什么教学技巧、要不要出检测题
    ④ memory.recall         想起这个学生的什么、有哪些可参考的教学经验
    → 拼成系统提示，调用导师模型 → 解析回复与 <<<EVAL>>> 评估块
    → 四个模块各自更新（分数记到上一轮的提问上）→ 持久化
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from llm import LLM, extract_json, extract_tagged, strip_tagged

from .modules import AbilityStrategy, PacingStrategy, PersonalMemoryStrategy, TechniqueStrategy
from .protocol import (AbilityView, Directive, LearnerState, MemoryView, Project,
                       TechniquePlan, TurnEval)

EVAL_FORMAT = """【输出格式】
先正常回复学生：简体中文、口语化、简洁，一次只推进一步，不要一次讲完整个单元。
回复最后另起一行附上评估块（学生看不到，系统会自动去掉）：
<<<EVAL>>>
{"score": 学生最新一条消息里作答/尝试的正确程度，0~1 的数字；没有作答就填 null,
 "misconception": "发现的具体误解，没有就填空字符串",
 "emotion": "学生状态，如 专注/困惑/沮丧/兴奋/走神",
 "note": "一句话教学观察"}
<<<END_EVAL>>>"""

SUMMARY_PROMPT = """你是教研员。下面是一次 AI 家教课的记录，每轮标注了所用教学技巧和学生作答得分。
请输出 JSON：
{"progress": "一句话：这次课学到哪里、掌握得如何、下次从哪里继续",
 "experiences": ["1~3 条可复用到其他学生的教学经验，每条以【教学经验】开头，写清 场景（学科/内容类型/学生特点）+ 做法 + 效果与证据"]}
只写有证据支持的经验，没有就给空列表。"""

OPENING_CUE = "（学生进入课堂。请根据本轮安排开始这次课：简短问候，然后开始教学。）"


@dataclass
class TurnResult:
    reply: str
    eval: TurnEval
    mode: str
    unit: str
    technique: str
    event: Optional[str] = None


def parse_reply(raw: str) -> Tuple[str, TurnEval]:
    """拆出给学生看的回复和评估块。"""
    block = extract_tagged(raw, "EVAL")
    reply = strip_tagged(raw, "EVAL") if block else raw.strip()
    data = extract_json(block) if block else {}
    score = data.get("score")
    try:
        score = None if score in (None, "", "null") else max(0.0, min(1.0, float(score)))
    except (TypeError, ValueError):
        score = None
    return reply, TurnEval(score=score,
                           misconception=str(data.get("misconception") or ""),
                           emotion=str(data.get("emotion") or ""),
                           note=str(data.get("note") or ""))


class TutorRuntime:
    def __init__(self, project: Project, harness: Dict[str, Any], llm: LLM,
                 store: Optional[Any] = None, workdir: Optional[Path] = None):
        self.project = project
        self.harness = harness
        self.llm = llm
        self.workdir = Path(workdir) if workdir else None

        self.pacing = PacingStrategy(harness["pacing"])
        self.ability = AbilityStrategy(harness["ability"])
        self.technique = TechniqueStrategy(harness["technique"])
        self.memory = PersonalMemoryStrategy(harness["memory"])
        self.memory.bind(store, project.learner_id)

        self.state = self._load_state()
        self._session_log: List[Dict[str, Any]] = []

    # ── 对外 API ──

    def start_session(self) -> TurnResult:
        return self.chat(OPENING_CUE, record=False)

    def chat(self, user_msg: str, record: bool = True) -> TurnResult:
        st = self.state
        d = self.pacing.directive(st)
        a = self.ability.view(d.unit.content_type, st)
        tp = self.technique.choose(d, a, st)
        mv = self.memory.recall(user_msg if record else d.unit.title, d, st)

        before = self.llm.total_tokens
        raw = self.llm.chat(self._compose(d, a, tp, mv, user_msg))
        st.tokens += self.llm.total_tokens - before
        reply, ev = parse_reply(raw)
        if not record:
            ev.score = None

        prev = st.last_prompt
        event = self.pacing.update(st, d, prev, ev)
        if prev:
            self.ability.update(prev["content_type"], st, ev)
        self.technique.update(tp, st, ev)
        focus = d.review_unit or d.unit
        st.last_prompt = {"unit": d.unit.id, "mode": d.mode, "content_type": focus.content_type,
                          "review_unit": d.review_unit.id if d.review_unit else None}
        st.turns += 1
        st.history = (st.history + [{"role": "user", "content": user_msg},
                                    {"role": "assistant", "content": reply}])[-60:]

        meta = {"project_id": self.project.id, "subject": self.project.subject,
                "unit": d.unit.title, "content_type": d.unit.content_type,
                "technique": tp.name, "mode": d.mode}
        if ev.score is not None:
            meta["score"] = ev.score
        if record:
            self.memory.record(user_msg, reply, st, meta)

        turn = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "user": user_msg, "reply": reply,
                "mode": d.mode, "unit": d.unit.title, "technique": tp.name,
                "eval": ev.__dict__, "event": event}
        self._session_log.append(turn)
        self._append_transcript(turn)
        self.save()
        return TurnResult(reply=reply, eval=ev, mode=d.mode, unit=d.unit.title,
                          technique=tp.name, event=event)

    def end_session(self) -> Dict[str, Any]:
        """下课：写长期记忆、总结本次课的教学经验、课次 +1。"""
        self.memory.flush(wait=True)
        answered = [t for t in self._session_log if t["user"] != OPENING_CUE]
        if not answered:
            return {"progress": "", "experiences": []}

        summary = self._summarize(answered)
        meta = {"project_id": self.project.id, "subject": self.project.subject}
        if summary.get("progress"):
            self.memory.save_note(f"【学习进度】{summary['progress']}", "学习进度", meta)
        experiences = [e for e in summary.get("experiences", []) if isinstance(e, str) and e.strip()]
        self.memory.save_experiences(experiences, meta)

        self.state.sessions += 1
        self._session_log = []
        self.save()
        return {"progress": summary.get("progress", ""), "experiences": experiences}

    def status(self) -> Dict[str, Any]:
        st = self.state
        units = self.pacing.units()
        return {
            "project": self.project.title,
            "approach": self.harness["pacing"].get("approach"),
            "unit": f"{st.unit_index + 1}/{len(units)} {units[st.unit_index].title}",
            "finished": st.finished,
            "mastery": {u.title: st.mastery.get(u.id, 0.0) for u in units},
            "ability": {ct: round(self.ability.level(ct, st), 2)
                        for ct in dict.fromkeys(u.content_type for u in units)},
            "turns": st.turns, "sessions": st.sessions, "tokens": st.tokens,
        }

    def mastery_mean(self) -> float:
        units = self.pacing.units()
        return sum(self.state.mastery.get(u.id, 0.0) for u in units) / max(1, len(units))

    # ── 内部 ──

    def _compose(self, d: Directive, a: AbilityView, tp: TechniquePlan,
                 mv: MemoryView, user_msg: str) -> List[Dict[str, str]]:
        p = self.project
        sections = [
            self.harness.get("persona", "").strip(),
            f"【项目】{p.title}｜{p.subject}｜目标：{p.goal}\n【学生】{p.learner_profile or '（未提供）'}",
            d.text, a.text, tp.instruction, mv.text, EVAL_FORMAT,
        ]
        system = "\n\n".join(s for s in sections if s)
        return [{"role": "system", "content": system}, *mv.history,
                {"role": "user", "content": user_msg}]

    def _summarize(self, turns: List[Dict[str, Any]]) -> Dict[str, Any]:
        lines = []
        for t in turns[-30:]:
            score = t["eval"].get("score")
            lines.append(f"[{t['unit']}｜{t['mode']}｜技巧:{t['technique']}｜得分:{score}]\n"
                         f"学生：{t['user']}\n导师：{t['reply'][:400]}")
        user = (f"学科：{self.project.subject}；学生：{self.project.learner_profile}\n\n"
                + "\n\n".join(lines))
        try:
            return self.llm.chat_json([{"role": "system", "content": SUMMARY_PROMPT},
                                       {"role": "user", "content": user}])
        except Exception:
            return {}

    def _state_path(self) -> Optional[Path]:
        return self.workdir / "state.json" if self.workdir else None

    def _load_state(self) -> LearnerState:
        path = self._state_path()
        if path and path.exists():
            return LearnerState.from_dict(json.loads(path.read_text(encoding="utf-8")))
        return LearnerState()

    def save(self) -> None:
        path = self._state_path()
        if path:
            path.write_text(json.dumps(self.state.to_dict(), ensure_ascii=False, indent=2),
                            encoding="utf-8")

    def _append_transcript(self, turn: Dict[str, Any]) -> None:
        if self.workdir:
            with open(self.workdir / "transcript.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps(turn, ensure_ascii=False) + "\n")
