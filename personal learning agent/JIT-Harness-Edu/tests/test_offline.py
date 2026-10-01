"""离线测试：不需要任何 API Key。用假 OpenAI 服务 + 真实的 mem0/Qdrant 跑完整流程。

    python tests/test_offline.py        # 或 python -m pytest tests
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "tests"))

import fake_openai  # noqa: E402

TMP = Path(tempfile.mkdtemp(prefix="edu-jit-test-"))
SERVER = fake_openai.start()
BASE = f"http://127.0.0.1:{SERVER.server_address[1]}/v1"
os.environ.update({
    "LLM_BASE_URL": BASE, "LLM_API_KEY": "test", "TUTOR_MODEL": "fake",
    "EMBED_PROVIDER": "openai", "EMBED_BASE_URL": BASE, "EMBED_API_KEY": "test",
    "EMBED_MODEL": "fake-embed", "EMBED_DIMS": str(fake_openai.DIMS),
    "EDU_DATA_DIR": str(TMP / "data"), "EDU_PROJECTS_DIR": str(TMP / "projects"),
    "MEM0_DIR": str(TMP / "data" / "mem0"), "MEM0_TELEMETRY": "False",
})

from harness.jit import HarnessLibrary, normalize, validate  # noqa: E402
from harness.modules import PacingStrategy, TechniqueStrategy  # noqa: E402
from harness.protocol import LearnerState, TechniquePlan, TurnEval  # noqa: E402


# ── 单元测试：不涉及模型 ──

def test_builtin_templates_are_valid():
    lib = HarnessLibrary(TMP / "unused.json")
    assert len(lib.all()) >= 5
    for t in lib.all():
        assert validate(normalize(t.harness)) == {}, t.id


def test_library_search_matches_subject():
    lib = HarnessLibrary(TMP / "unused.json")
    assert lib.search("高考英语 3500 词汇 背单词", k=1)[0].id == "seed:spaced_retrieval"
    assert lib.search("用 Python 写一个记账小程序", k=1)[0].id == "seed:project_based"


def test_validate_reports_problems_per_module():
    lib = HarnessLibrary(TMP / "unused.json")
    h = normalize(lib.get("seed:mastery_socratic").harness)
    h["pacing"]["approach"] = "随便教"
    h["technique"]["by_content_type"]["概念理解"] = ["不存在的技巧"]
    h["memory"]["recall_top_k"] = 99
    diags = validate(h)
    assert set(diags) == {"PACING", "TECHNIQUE", "MEMORY"}


def test_pacing_needs_confirmation_before_advancing():
    spec = {"approach": "掌握学习", "pace": "中", "turns_per_unit": 20, "mastery_threshold": 0.8,
            "units": [{"id": "u1", "title": "A", "content_type": "概念理解", "objectives": ["a"]},
                      {"id": "u2", "title": "B", "content_type": "程序技能", "objectives": ["b"]}]}
    pacing, st = PacingStrategy(spec), LearnerState()
    st.mastery["u1"] = 0.85
    st.turns_in_unit = 3
    d = pacing.directive(st)
    assert d.mode == "进阶"
    # 上一轮不是确认题 → 不前进
    assert pacing.update(st, d, {"unit": "u1", "mode": "巩固"}, TurnEval(score=0.9)) is None
    # 上一轮是确认题且答对 → 前进
    event = pacing.update(st, d, {"unit": "u1", "mode": "进阶"}, TurnEval(score=0.9))
    assert "进入下一单元" in event and st.unit_index == 1


def test_technique_score_credits_previous_turn():
    tech, st = TechniqueStrategy({"by_content_type": {}}), LearnerState()
    tech.update(TechniquePlan("类比讲解", "", False), st, TurnEval(score=None))
    tech.update(TechniquePlan("费曼复述", "", False), st, TurnEval(score=0.9))
    assert st.technique_log[0] == {"technique": "类比讲解", "score": 0.9}
    assert st.technique_log[1]["score"] is None


# ── 端到端：创建项目 → 上课 → 下课 → 结课 → 第二个项目用上记忆和沉淀模板 ──

def test_end_to_end():
    from agent import EduAgent

    agent = EduAgent()
    assert agent.memory is not None, agent.memory_error
    assert agent.memory.seed_experiences() > 10

    # 1. 创建项目：生成 → 校验发现 2 个模块有问题 → 修复 1 轮通过
    project, harness, report = agent.create_project(
        "一元一次方程入门", "初中数学", "会解一元一次方程", "stu_001", "初二，基础一般", 4, 30)
    assert list(report["rounds"][0]["diagnostics"]) == ["PACING", "TECHNIQUE"]
    assert report["rounds"][1]["stage"] == "repair_1" and report["rounds"][1]["diagnostics"] == {}
    assert report["valid"] and report["fallback_modules"] == []
    assert harness["pacing"]["mastery_threshold"] == 0.8
    assert (agent.project_dir(project.id) / "harness.yaml").exists()

    # 2. 上课
    rt = agent.open_class(project.id)
    opening = rt.start_session()
    assert opening.mode == "新授" and opening.eval.score is None

    turns = [rt.chat(m) for m in ["我不会", "还是不懂", "是 1 克", "2", "3", "4", "5"]]
    modes = [t.mode for t in turns]
    assert "放慢" in modes, modes
    assert "进阶" in modes, modes
    assert any(t.event and "进入下一单元" in t.event for t in turns), [t.event for t in turns]
    assert rt.state.unit_index == 1
    assert "<<<EVAL>>>" not in turns[-1].reply

    # 3. 下课：写记忆、总结经验
    summary = rt.end_session()
    assert summary["experiences"] and rt.state.sessions == 1
    recalled = agent.memory.recall("stu_001", "等式的性质")
    assert recalled and all(m.text.startswith("【") for m in recalled)
    assert agent.memory.recall_experience("概念理解 等式")
    profile = agent.memory.profile("stu_001")
    assert "学习进度" in profile

    # 4. 结课：效果达标 → 沉淀为模板
    result = agent.finish_project(project.id, rating=5, post_test=90)
    assert result["saved_to_library"], result
    assert any(t.id == f"proj:{project.id}" for t in agent.library.all())

    # 5. 同一个学生的第二个项目：生成时读到了他的记忆，参考里出现了沉淀模板
    _, _, report2 = agent.create_project("一元一次方程应用题", "初中数学", "会列方程解应用题",
                                         "stu_001", "初二", 3, 30)
    assert "【" in report2["learner_memory"]
    assert any(r["id"] == f"proj:{project.id}" for r in report2["references"])


def _run_all():
    tests = [(name, fn) for name, fn in globals().items() if name.startswith("test_") and callable(fn)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"✓ {name}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"✗ {name}: {type(exc).__name__}: {exc}")
    SERVER.shutdown()
    shutil.rmtree(TMP, ignore_errors=True)
    print(f"\n{len(tests) - failed}/{len(tests)} 通过")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    _run_all()
