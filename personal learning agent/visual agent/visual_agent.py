"""Gigle 视觉学习 Agent：当前截图 + 项目 harness + 用户问题。"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

from tools import describe_visible_board

JIT_ROOT = Path(__file__).resolve().parents[1] / "JIT-Harness-Edu"
sys.path.insert(0, str(JIT_ROOT))

from agent import EduAgent  # noqa: E402
from web_bridge import settings_for  # noqa: E402


def prepare(payload: dict[str, Any]):
    atom_dir = Path(payload["atom_dir"]).resolve()
    atom_id = str(payload["atom_id"])
    question = str(payload.get("question") or "").strip()
    image = payload.get("image")
    if not re.fullmatch(r"[a-f0-9-]{36}", atom_id):
        raise ValueError("项目 ID 无效")
    if not question or len(question) > 2000:
        raise ValueError("请输入不超过 2000 字的问题")
    if not isinstance(image, str) or not re.match(r"^data:image/(jpeg|png);base64,", image):
        raise ValueError("当前画布截图无效")

    agent = EduAgent(settings_for(atom_dir), use_memory=True)
    project = agent.load_project(atom_id)
    runtime = agent.open_class(atom_id)
    state = runtime.state
    directive = runtime.pacing.directive(state)
    ability = runtime.ability.view(directive.unit.content_type, state)
    technique = runtime.technique.choose(directive, ability, state)
    memory = runtime.memory.recall(question, directive, state)
    position = describe_visible_board(payload.get("context") or {}, question)
    system = "\n\n".join([
        "你是 gigle，陪学生一起看白板的学习助手。用自然、清楚的简体中文交谈，先准确回答眼前的问题，再决定是否需要展开。不要套用固定开场或结尾。",
        "当前截图是视觉事实的主要依据。只描述看得清的内容；不确定时说明哪里看不清，并请学生放大或指出位置。不要编造文字、公式、页码、题意或答案。",
        "根据问题调整篇幅：简单事实或日常对话直接简短回复；概念问题解释关键原因，必要时举一个贴近题目的例子；做题时先回应学生正在问的步骤，给出有用的线索和推理，不机械地拒绝给答案。学生明确要完整解法时就完整解释。",
        "只有回答完有价值且自然的下一步时，才在结尾加一句邀请：可以问学生是否想了解更多、是否需要更细的介绍，或给一道与当前内容相关的思考题。三种方式择一，措辞随上下文变化；简单问题、闲聊、已经结束的话题直接收住，不要每轮都反问。",
        "下面的 harness 是教学参考，用它调整解释深度、节奏和反馈方式；不要让教学流程盖过学生当前的问题，也不要复述内部策略。",
        f"【项目】{project.title}｜{project.subject}｜目标：{project.goal}",
        f"【项目导师人设】{runtime.harness.get('persona', '')}",
        directive.text, ability.text, technique.instruction,
        f"【本项目记忆重点】{runtime.harness['memory'].get('focus', '')}",
        memory.text,
        "【视觉定位辅助】\n" + position,
        "【本轮回复优先规则】先判断学生问的是什么。寒暄、致谢、确认和能用一两句回答的简单问题，直接回答后停止；不要描述白板、介绍课程计划、追加教学问题或邀请继续。只有实质性的学习问题需要展开时才引用截图和教学策略；回答完整后，也仅在自然且有帮助时留一个相关的延伸方向。",
    ])
    history = []
    history_limit = min(8, 2 * int(runtime.harness["memory"].get("history_turns", 8)))
    for turn in (payload.get("history") or [])[-history_limit:]:
        if isinstance(turn, dict) and turn.get("role") in ("user", "assistant"):
            content = str(turn.get("content") or "")[:2000]
            if content:
                history.append({"role": turn["role"], "content": content})
    if re.fullmatch(r"(你好|您好|嗨|哈喽|hello|hi|早上好|下午好|晚上好|在吗|谢谢|谢了|再见|拜拜)[！!。,.，?？\s]*", question, re.IGNORECASE):
        return runtime, [
            {"role": "system", "content": "你是 gigle。对寒暄、致谢或告别，只用一句自然的中文回复。不要提白板、课程或教学计划，也不要反问。"},
            *history, {"role": "user", "content": question},
        ]
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system}, *history,
        {"role": "user", "content": [
            {"type": "text", "text": f"我的问题：{question}\n如果问题涉及画布、题目或笔记，请参考当前截图；否则直接回答问题。"},
            {"type": "image_url", "image_url": {"url": image}},
        ]},
    ]
    return runtime, messages


def answer(payload: dict[str, Any]) -> dict[str, str]:
    runtime, messages = prepare(payload)
    reply = runtime.llm.chat(messages).strip()
    if not reply:
        raise RuntimeError("gigle 没有收到模型回复，请重试")
    return {"reply": reply}


def answer_stream(payload: dict[str, Any]) -> None:
    runtime, messages = prepare(payload)
    received = False
    for delta in runtime.llm.chat_stream(messages):
        received = True
        print(json.dumps({"delta": delta}, ensure_ascii=False), flush=True)
    if not received:
        raise RuntimeError("gigle 没有收到模型回复，请重试")
    print(json.dumps({"done": True}), flush=True)


if __name__ == "__main__":
    try:
        payload = json.load(sys.stdin)
        if payload.get("stream"):
            answer_stream(payload)
        else:
            print(json.dumps(answer(payload), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), flush=True)
        sys.exit(1)
