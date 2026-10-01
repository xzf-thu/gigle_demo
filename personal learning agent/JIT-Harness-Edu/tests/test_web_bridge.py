"""Gigle 桥接烟测：专属 harness、mem0 记忆和下个项目的记忆读取。"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from fake_openai import start

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parents[1]


def bridge(env, payload):
    completed = subprocess.run(
        [sys.executable, str(ROOT / "web_bridge.py")], input=json.dumps(payload), text=True,
        capture_output=True, env=env, timeout=300, check=True,
    )
    return json.loads(completed.stdout)


def test_web_bridge():
    server = start()
    (WORKSPACE / ".cache").mkdir(exist_ok=True)
    try:
        with tempfile.TemporaryDirectory(dir=WORKSPACE / ".cache") as temporary:
            temp = Path(temporary)
            env = {**os.environ, "LLM_BASE_URL": f"http://127.0.0.1:{server.server_address[1]}/v1",
                   "LLM_API_KEY": "test", "JIT_MODEL": "fake", "TUTOR_MODEL": "fake",
                   "MEMORY_MODEL": "fake", "EDU_DATA_DIR": str(temp / "data"),
                   "FASTEMBED_CACHE_PATH": str(WORKSPACE / ".cache/fastembed"),
                   "MEM0_DIR": str(temp / "data/mem0"), "MEM0_TELEMETRY": "False"}
            for key in ("EMBED_PROVIDER", "EMBED_API_KEY", "EMBED_MODEL", "EMBED_DIMS"):
                env.pop(key, None)
            first = temp / "first"
            first.mkdir()
            result = bridge(env, {"action": "create", "atom_dir": str(first),
                                  "project_id": "topic-1", "title": "一元一次方程",
                                  "subject": "数学", "goal": "学会解方程", "materials": "等式"})
            assert result["memory_available"]
            assert (first / "learning-agent/topic-1/harness.yaml").is_file()
            bridge(env, {"action": "remember", "atom_dir": str(first), "project_id": "topic-1",
                         "study_seconds": 190, "experience": "学习了等式的性质并写下练习笔记"})
            second = temp / "second"
            second.mkdir()
            bridge(env, {"action": "create", "atom_dir": str(second), "project_id": "topic-2",
                         "title": "解方程进阶", "subject": "数学", "goal": "解较复杂方程"})
            report = json.loads((second / "learning-agent/topic-2/jit_report.json").read_text())
            assert "等式的性质" in report["learner_memory"]
    finally:
        server.shutdown()


if __name__ == "__main__":
    test_web_bridge()
    print("✓ test_web_bridge")
