"""EduAgent：产品服务层。CLI、Web 后端都只调这一层。

一个教育项目的生命周期：
    create_project()   创建项目 → JIT 生成 harness（每个项目只生成这一次）
    open_class()       打开项目 → TutorRuntime：start_session / chat / end_session，可以上很多次课
    finish_project()   结课 → 计算学习效果 → 效果好的 harness 沉淀进模板库，供以后相似项目参考

项目文件（projects/<项目ID>/）：
    project.json      项目信息
    harness.yaml      生成的 harness（可以手动改，开课时会重新校验）
    jit_report.json   生成过程：参考了哪些模板、读到的学生记忆、每轮的模型输出和校验问题
    state.json        学习进度：单元、掌握度、各类内容能力、技巧效果
    transcript.jsonl  上课记录
    finish.json       结课报告
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from statistics import mean
from typing import Any, Dict, List, Optional, Tuple

from harness import load_harness, save_harness
from harness.jit import HarnessLibrary, JITGenerator, normalize, validate
from harness.jit.generator import render_diagnostics
from harness.protocol import Project
from harness.runtime import TutorRuntime
from llm import LLM
from settings import Settings

logger = logging.getLogger(__name__)


class EduAgent:
    def __init__(self, settings: Optional[Settings] = None, use_memory: bool = True):
        self.s = settings or Settings.load()
        self.s.projects_dir.mkdir(parents=True, exist_ok=True)
        self.library = HarnessLibrary(self.s.data_dir / "harness_library.json")
        self.memory = None
        self.memory_error = ""
        if use_memory:
            try:
                from memory import EduMemory
                self.memory = EduMemory(self.s)
            except Exception as exc:  # 记忆库不可用时照常上课，只是没有长期记忆
                self.memory_error = f"{type(exc).__name__}: {exc}"
                logger.warning("长期记忆不可用：%s", self.memory_error)

    def _llm(self, model: str, temperature: float) -> LLM:
        return LLM(model, self.s.llm_base_url, self.s.llm_api_key, temperature=temperature)

    def project_dir(self, project_id: str) -> Path:
        return self.s.projects_dir / project_id

    # ── 创建项目：JIT 生成一次 harness ──

    def create_project(self, title: str, subject: str, goal: str, learner_id: str,
                       learner_profile: str = "", total_sessions: int = 6,
                       minutes_per_session: int = 30,
                       materials: str = "", project_id: Optional[str] = None) -> Tuple[Project, Dict[str, Any], Dict[str, Any]]:
        project = Project(
            id=project_id or time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4],
            title=title, subject=subject, goal=goal, learner_id=learner_id,
            learner_profile=learner_profile, total_sessions=total_sessions,
            minutes_per_session=minutes_per_session, materials=materials,
            created_at=time.strftime("%Y-%m-%d %H:%M:%S"),
        )
        generator = JITGenerator(self._llm(self.s.jit_model, 0.7), self.library, self.memory)
        harness, report = generator.generate(project)   # 失败会直接抛出，不会留下半成品项目

        d = self.project_dir(project.id)
        d.mkdir(parents=True)
        self._write_json(d / "project.json", project.to_dict())
        save_harness(harness, d / "harness.yaml")
        self._write_json(d / "jit_report.json", report)
        return project, harness, report

    # ── 查询 ──

    def list_projects(self) -> List[Dict[str, Any]]:
        rows = []
        for d in sorted(self.s.projects_dir.iterdir(), reverse=True):
            if not (d / "project.json").exists():
                continue
            p = json.loads((d / "project.json").read_text(encoding="utf-8"))
            state = self._read_json(d / "state.json")
            rows.append({"id": p["id"], "title": p["title"], "learner_id": p["learner_id"],
                         "sessions": state.get("sessions", 0),
                         "finished": (d / "finish.json").exists()})
        return rows

    def load_project(self, project_id: str) -> Project:
        path = self.project_dir(project_id) / "project.json"
        if not path.exists():
            raise FileNotFoundError(f"没有这个项目：{project_id}")
        return Project(**json.loads(path.read_text(encoding="utf-8")))

    def load_harness(self, project_id: str) -> Dict[str, Any]:
        return load_harness(self.project_dir(project_id) / "harness.yaml")

    def jit_report(self, project_id: str) -> Dict[str, Any]:
        return self._read_json(self.project_dir(project_id) / "jit_report.json")

    # ── 上课 ──

    def open_class(self, project_id: str) -> TutorRuntime:
        project = self.load_project(project_id)
        harness = normalize(self.load_harness(project_id))
        diags = validate(harness)
        if diags:  # harness.yaml 可能被手动改坏了
            raise ValueError("harness.yaml 校验不通过：\n" + render_diagnostics(diags))
        return TutorRuntime(project, harness, self._llm(self.s.tutor_model, 0.7),
                            store=self.memory, workdir=self.project_dir(project_id))

    # ── 结课：评估效果，好的 harness 沉淀为模板 ──

    def finish_project(self, project_id: str, rating: Optional[int] = None,
                       post_test: Optional[float] = None) -> Dict[str, Any]:
        """rating：学生满意度 1~5；post_test：结课测验分 0~100。都可省略。"""
        project = self.load_project(project_id)
        runtime = self.open_class(project_id)
        signals = {"平均掌握度": runtime.mastery_mean()}
        if post_test is not None:
            signals["结课测验"] = max(0.0, min(1.0, post_test / 100))
        if rating is not None:
            signals["学生评价"] = max(0.0, min(1.0, (rating - 1) / 4))
        metrics = {"reward": round(mean(signals.values()), 3),
                   "sessions": max(1, runtime.state.sessions),
                   "tokens": runtime.state.tokens}

        harness = self.load_harness(project_id)
        refs = harness.get("meta", {}).get("references", [])
        saved, reason = self.library.save_if_better(project.id, project.title, project.describe(),
                                                    harness, metrics, refs)
        result = {"project_id": project.id, "signals": signals, "metrics": metrics,
                  "saved_to_library": saved, "reason": reason,
                  "finished_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        self._write_json(self.project_dir(project_id) / "finish.json", result)
        return result

    # ── 工具 ──

    @staticmethod
    def _write_json(path: Path, data: Any) -> None:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str), encoding="utf-8")

    @staticmethod
    def _read_json(path: Path) -> Dict[str, Any]:
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
