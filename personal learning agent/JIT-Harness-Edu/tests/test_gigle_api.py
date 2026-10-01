"""本机主页创建、三分钟门槛与项目记忆偏好的端到端烟测。"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from fake_openai import VISUAL_REQUESTS, start

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parents[1]
FRONTEND = WORKSPACE / "frontend"


def free_port():
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return server.getsockname()[1]


def call(port, path, method="GET", body=None):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.load(response)


def call_stream(port, path, body):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", method="POST",
        data=json.dumps(body).encode(), headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        assert response.headers["Content-Type"].startswith("application/x-ndjson")
        frames = [json.loads(line) for line in response if line.strip()]
    assert frames[-1] == {"done": True}
    assert not any("error" in frame for frame in frames)
    return {"reply": "".join(frame.get("delta", "") for frame in frames), "delta_count": sum("delta" in frame for frame in frames)}


def test_gigle_api():
    fake = start()
    (WORKSPACE / ".cache").mkdir(exist_ok=True)
    server = None
    try:
        with tempfile.TemporaryDirectory(dir=WORKSPACE / ".cache") as temporary:
            temp = Path(temporary)
            port = free_port()
            env = {**os.environ, "PORT": str(port), "GIGLE_STUDY_DATA_DIR": str(temp / "materials"),
                   "EDU_DATA_DIR": str(temp / "agent-data"),
                   "FASTEMBED_CACHE_PATH": str(WORKSPACE / ".cache/fastembed"),
                   "MEM0_DIR": str(temp / "agent-data/mem0"), "MEM0_TELEMETRY": "False",
                   "LLM_BASE_URL": f"http://127.0.0.1:{fake.server_address[1]}/v1",
                   "LLM_API_KEY": "test", "JIT_MODEL": "fake", "TUTOR_MODEL": "fake",
                   "MEMORY_MODEL": "fake", "PYTHONPYCACHEPREFIX": str(WORKSPACE / ".cache/pycache")}
            for key in ("EMBED_PROVIDER", "EMBED_API_KEY", "EMBED_MODEL", "EMBED_DIMS"):
                env.pop(key, None)
            server = subprocess.Popen(["node", "local-server.mjs"], cwd=FRONTEND, env=env,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            for _ in range(100):
                try:
                    call(port, "/api/library")
                    break
                except (urllib.error.URLError, ConnectionError):
                    time.sleep(0.1)
            else:
                raise AssertionError("Gigle 本机服务没有启动")

            atom = call(port, "/api/atoms", "POST", {"title": "方程练习", "format": "blank", "sources": []})["atom"]
            atom_id = atom["id"]
            assert atom["learningAgent"]["projectId"] == atom_id
            assert next((temp / "materials").glob(f"atom-*-{atom_id}/learning-agent/{atom_id}/harness.yaml")).is_file()
            exit_path = f"/api/atoms/{atom_id}/exit"
            assert not call(port, exit_path, "POST", {"exitId": str(uuid.uuid4()), "studyMs": 179_000})["shouldPrompt"]
            assert call(port, exit_path, "POST", {"exitId": str(uuid.uuid4()), "studyMs": 1_000})["shouldPrompt"]
            call(port, f"/api/atoms/{atom_id}/memory", "POST", {"choice": "later"})
            assert call(port, exit_path, "POST", {"exitId": str(uuid.uuid4()), "studyMs": 1_000})["shouldPrompt"]
            call(port, f"/api/atoms/{atom_id}/memory", "POST", {"choice": "always"})
            assert not call(port, exit_path, "POST", {"exitId": str(uuid.uuid4()), "studyMs": 1_000})["shouldPrompt"]
            saved = call(port, f"/api/atoms/{atom_id}")["atom"]
            assert saved["memoryPreference"] == "always" and saved["lastMemoryExitId"]

            image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=="
            visual = call_stream(port, "/api/visual-agent", {
                "atomId": atom_id, "question": "左上角是什么？", "image": image,
                "context": {"viewport": {"width": 800, "height": 600}, "view": {"x": 0, "y": 0, "z": 1},
                            "items": [{"kind": "text", "x": 10, "y": 10, "w": 100, "h": 40, "content": "等式"}]},
                "history": [],
            })
            assert "gigle" in visual["reply"]
            assert visual["delta_count"] > 1
            assert VISUAL_REQUESTS
            visual_messages = VISUAL_REQUESTS[-1]
            assert "项目导师人设" in visual_messages[0]["content"]
            assert "左侧上方的文字：等式" in visual_messages[0]["content"]
            assert visual_messages[-1]["content"][1]["image_url"]["url"] == image

            follow_up = call_stream(port, "/api/visual-agent", {
                "atomId": atom_id, "question": "那下一步呢？", "image": image,
                "context": {"viewport": {"width": 800, "height": 600}, "view": {"x": 0, "y": 0, "z": 1}},
                "history": [{"role": "user", "content": "左上角是什么？"},
                            {"role": "assistant", "content": visual["reply"]}],
            })
            assert "gigle" in follow_up["reply"]
            assert [message["role"] for message in VISUAL_REQUESTS[-1]] == ["system", "user", "assistant", "user"]
            assert VISUAL_REQUESTS[-1][1]["content"] == "左上角是什么？"
            assert VISUAL_REQUESTS[-1][-1]["content"][1]["image_url"]["url"] == image

            greeting = call_stream(port, "/api/visual-agent", {
                "atomId": atom_id, "question": "你好", "image": image, "history": [], "context": {},
            })
            assert greeting["reply"] == "你好！"
            assert VISUAL_REQUESTS[-1][-1]["content"] == "你好"

            project_dir = next((temp / "materials").glob(f"atom-*-{atom_id}"))
            shutil.rmtree(project_dir / "learning-agent")
            legacy_visual = call_stream(port, "/api/visual-agent", {
                "atomId": atom_id, "question": "现在能看到吗？", "image": image,
                "context": {"viewport": {"width": 800, "height": 600}, "view": {"x": 0, "y": 0, "z": 1}},
                "history": [],
            })
            assert "gigle" in legacy_visual["reply"]
            assert (project_dir / f"learning-agent/{atom_id}/harness.yaml").is_file()

            other = call(port, "/api/atoms", "POST", {"title": "不记忆项目", "format": "blank", "sources": []})["atom"]
            other_exit = f"/api/atoms/{other['id']}/exit"
            assert call(port, other_exit, "POST", {"exitId": str(uuid.uuid4()), "studyMs": 180_000})["shouldPrompt"]
            call(port, f"/api/atoms/{other['id']}/memory", "POST", {"choice": "never"})
            assert not call(port, other_exit, "POST", {"exitId": str(uuid.uuid4()), "studyMs": 5_000})["shouldPrompt"]
    finally:
        if server:
            server.terminate()
            server.wait(timeout=10)
        fake.shutdown()


if __name__ == "__main__":
    test_gigle_api()
    print("✓ test_gigle_api")
