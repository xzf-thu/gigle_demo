"""离线测试用的假 OpenAI 兼容服务（只用标准库）。

按系统提示词识别是谁在调用，返回固定格式的结果：
- harness 生成：第一次故意给出两个错误（未知技巧、达标线越界），用来测试修复轮
- harness 修复：返回修好的块
- 导师上课：回复 + <<<EVAL>>> 评估块（学生说“不会/不懂”给 0.3 分，带数字的作答给 0.9 分）
- 课后总结：进度 + 教学经验 JSON
- mem0 记忆抽取：返回带【类别】的记忆
- /v1/embeddings：按字二元组哈希的 64 维向量（相似文本向量相近）

单独运行可当离线演示后端：python tests/fake_openai.py  （然后把 .env 的地址指到 http://127.0.0.1:8765/v1）
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIMS = 64
VISUAL_REQUESTS = []

GENERATED = """分析：学生是初二学生，方程概念基础一般，适合掌握学习，小步推进并频繁检测。

<<<PERSONA>>>
你是一位耐心的数学导师。你用提问引导学生自己想明白，每次只推进一小步。
学生答错时先肯定他做对的部分，再指出最关键的一处错误。
<<<END_PERSONA>>>

<<<PACING>>>
approach: 掌握学习
why: 方程知识前后依赖强
pace: 快
turns_per_unit: 6
mastery_threshold: 1.2
slow_down_below: 0.5
review_every: 4
units:
  - id: u1
    title: 等式的性质
    content_type: 概念理解
    objectives: [能说出等式两边同时加减乘除同一个数仍相等]
  - id: u2
    title: 解一元一次方程
    content_type: 程序技能
    objectives: [能用移项和合并同类项解方程]
<<<END_PACING>>>

<<<ABILITY>>>
learning_rate: 0.2
stretch: 0.1
initial: {概念理解: 0.5, 程序技能: 0.4}
profiles:
  概念理解:
    representations: [天平类比]
    activities: [用自己的话解释]
<<<END_ABILITY>>>

<<<TECHNIQUE>>>
by_content_type:
  概念理解: [类比讲解, 神奇教学法]
  程序技能: [样例学习, 支架渐隐]
on_struggle: 支架渐隐
on_review: 检索练习
on_mastery: 迁移挑战
assess_every: 1
feedback_style: 先肯定再纠错
avoid: [直接给答案]
<<<END_TECHNIQUE>>>

<<<MEMORY>>>
recall_top_k: 5
experience_top_k: 2
history_turns: 6
write_every: 1
focus: 学生在移项时的符号错误
<<<END_MEMORY>>>
"""

REPAIRED = """<<<PACING>>>
approach: 掌握学习
why: 方程知识前后依赖强
pace: 快
turns_per_unit: 6
mastery_threshold: 0.8
slow_down_below: 0.5
review_every: 4
units:
  - id: u1
    title: 等式的性质
    content_type: 概念理解
    objectives: [能说出等式两边同时加减乘除同一个数仍相等]
  - id: u2
    title: 解一元一次方程
    content_type: 程序技能
    objectives: [能用移项和合并同类项解方程]
<<<END_PACING>>>

<<<TECHNIQUE>>>
by_content_type:
  概念理解: [类比讲解, 苏格拉底提问]
  程序技能: [样例学习, 支架渐隐]
on_struggle: 支架渐隐
on_review: 检索练习
on_mastery: 迁移挑战
assess_every: 1
feedback_style: 先肯定再纠错
avoid: [直接给答案]
<<<END_TECHNIQUE>>>
"""


def embed(text: str) -> list:
    vec = [0.0] * DIMS
    t = re.sub(r"\s+", "", text)
    for i in range(len(t) - 1):
        h = int(hashlib.md5(t[i:i + 2].encode()).hexdigest(), 16)
        vec[h % DIMS] += 1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def _text(content) -> str:
    if isinstance(content, list):
        return " ".join(part.get("text", "") for part in content if isinstance(part, dict))
    return content or ""


def respond(messages: list) -> str:
    system = _text(messages[0]["content"]) if messages else ""
    last = _text(messages[-1]["content"]) if messages else ""

    if "你是 gigle。对寒暄、致谢或告别" in system:
        VISUAL_REQUESTS.append(messages)
        return "你好！"
    if "你是 gigle，陪学生一起看白板的学习助手" in system:
        VISUAL_REQUESTS.append(messages)
        return "我是 gigle，我看到了当前画布。我们先看你问的这一部分。"
    if "没有通过校验" in system:
        return REPAIRED
    if "即时（just-in-time）" in system:
        return GENERATED
    if "教研员" in system:
        return json.dumps({"progress": "学完了等式的性质，下次从解方程继续",
                           "experiences": ["【教学经验】初二学生学等式性质时，用天平类比后再让学生自己说规律，答对率明显提高"]},
                          ensure_ascii=False)
    if "Memory Extractor" in system:
        new = last.split("## New Messages", 1)[-1][:400]
        memories = []
        if "不会" in new or "不懂" in new:
            memories.append({"id": "0", "text": "【学习状态】学生在等式的性质上表示不会，需要更多提示"})
        if re.search(r"\d", new):
            memories.append({"id": str(len(memories)), "text": "【知识掌握】学生能正确说出等式两边同时加同一个数仍相等"})
        return json.dumps({"memory": memories}, ensure_ascii=False)
    if "【输出格式】" in system:
        if "不会" in last or "不懂" in last:
            score, reply = 0.3, "没关系，我们换个方式：想象一架天平，两边放一样重的东西……你觉得两边各加 1 克会怎样？"
        elif re.search(r"\d", last):
            score, reply = 0.9, "完全正确！你抓住了关键。再来一道：x + 3 = 5，两边同时减几？"
        else:
            score, reply = None, "同学你好！今天我们来学等式的性质。先想一想：天平两边一样重时，两边各加 1 克还平衡吗？"
        ev = {"score": score, "misconception": "", "emotion": "专注", "note": "测试"}
        return f"{reply}\n<<<EVAL>>>\n{json.dumps(ev, ensure_ascii=False)}\n<<<END_EVAL>>>"
    return "ok"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 安静
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        if self.path.endswith("/embeddings"):
            inputs = body["input"] if isinstance(body["input"], list) else [body["input"]]
            out = {"object": "list", "model": body.get("model", "fake"),
                   "data": [{"object": "embedding", "index": i, "embedding": embed(t)}
                            for i, t in enumerate(inputs)],
                   "usage": {"prompt_tokens": 1, "total_tokens": 1}}
        else:
            content = respond(body.get("messages", []))
            if body.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for offset in range(0, len(content), 12):
                    frame = {"id": "fake", "object": "chat.completion.chunk", "created": 0,
                             "model": body.get("model", "fake"),
                             "choices": [{"index": 0, "delta": {"content": content[offset:offset + 12]},
                                          "finish_reason": None}]}
                    self.wfile.write(("data: " + json.dumps(frame, ensure_ascii=False) + "\n\n").encode())
                    self.wfile.flush()
                    time.sleep(0.01)
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return
            out = {"id": "fake", "object": "chat.completion", "created": 0,
                   "model": body.get("model", "fake"),
                   "choices": [{"index": 0, "finish_reason": "stop",
                                "message": {"role": "assistant", "content": content}}],
                   "usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}}
        data = json.dumps(out, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def start(port: int = 0) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


if __name__ == "__main__":
    srv = start(8765)
    print("假 OpenAI 服务：http://127.0.0.1:8765/v1  （EMBED_DIMS=64，Ctrl-C 退出）")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        srv.shutdown()
