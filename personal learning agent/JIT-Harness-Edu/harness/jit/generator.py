"""JIT 生成器：每创建一个教育项目，就调用一次大模型 API 为它即时生成 harness。

流程：
    1. 找参考   从模板库取最相似、效果最好的几个 harness
    2. 读记忆   从记忆库取这个学生的记忆摘要（个人记忆会影响 harness 的设计）
    3. 生成     模型输出五个带标签的块 PERSONA / PACING / ABILITY / TECHNIQUE / MEMORY
    4. 校验     规则检查，按模块列出问题
    5. 修复     把问题交回模型，只重写有问题的块，最多 2 轮
    6. 兜底     仍不合格的模块用最相关模板的同名模块替换 —— 保证一定能开课
"""

from __future__ import annotations

import copy
import logging
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from llm import LLM, extract_tagged

from .. import dump_harness
from ..catalog import DEFAULT_TECHNIQUES_BY_TYPE, render_catalog
from ..protocol import BLOCKS, Project
from .library import HarnessLibrary, Template
from .validate import DEFAULTS, Diagnostics, check_unit, normalize, validate

logger = logging.getLogger(__name__)

PROMPTS = yaml.safe_load((Path(__file__).parent / "prompts.yaml").read_text(encoding="utf-8"))
KEY_TO_BLOCK = {v: k for k, v in BLOCKS.items()}


def fill(template: str, **values: str) -> str:
    for key, value in values.items():
        template = template.replace("{{ " + key + " }}", value)
    return template


def parse_blocks(raw: str, base: Dict[str, Any]) -> Tuple[Dict[str, Any], Diagnostics, List[str]]:
    """把模型输出里的块解析进 harness（只覆盖输出了的块）。返回 (harness, 解析错误, 更新了哪些块)。"""
    harness = copy.deepcopy(base)
    errors: Diagnostics = {}
    updated = []
    for tag, key in BLOCKS.items():
        block = extract_tagged(raw, tag)
        if block is None:
            continue
        updated.append(tag)
        block = re.sub(r"^\s*```[a-zA-Z]*\s*\n|\n\s*```\s*$", "", block)  # 模型偶尔会多包一层 ```
        if key == "persona":
            harness[key] = block.strip()
            continue
        try:
            harness[key] = yaml.safe_load(block)
        except yaml.YAMLError as exc:
            harness.pop(key, None)
            errors[tag] = [f"YAML 解析失败：{exc}"]
    return harness, errors, updated


def merge(*diag_sets: Diagnostics) -> Diagnostics:
    out: Diagnostics = {}
    for d in diag_sets:
        for block, msgs in d.items():
            out.setdefault(block, []).extend(msgs)
    return out


def render_diagnostics(diags: Diagnostics) -> str:
    return "\n".join(f"[{block}]\n" + "\n".join(f"- {m}" for m in msgs) for block, msgs in diags.items())


def render_references(refs: List[Template]) -> str:
    """参考模板只展示设计，不展示具体单元（避免照抄别的项目的课程内容）。"""
    if not refs:
        return "（暂无）"
    parts = []
    for i, e in enumerate(refs, 1):
        h = copy.deepcopy(e.harness)
        units = h.get("pacing", {}).pop("units", [])
        titles = " / ".join(str(u.get("title", "")) for u in units if isinstance(u, dict))
        h.setdefault("pacing", {})["units"] = f"（{len(units)} 个单元：{titles}）"
        blocks = [f"### 参考 {i}：{e.name}（相关度 {e.similarity:.2f}；{e.score_text()}）",
                  f"说明：{e.description}"]
        for key in ("persona", "pacing", "ability", "technique", "memory"):
            if key not in h:
                continue
            tag = KEY_TO_BLOCK[key]
            body = h[key].strip() if key == "persona" else dump_harness(h[key]).strip()
            blocks.append(f"<<<{tag}>>>\n{body}\n<<<END_{tag}>>>")
        parts.append("\n".join(blocks))
    return "\n\n".join(parts)


class JITGenerator:
    def __init__(self, llm: LLM, library: HarnessLibrary, memory: Optional[Any] = None,
                 max_repairs: int = 2, k_refs: int = 3):
        self.llm = llm
        self.library = library
        self.memory = memory
        self.max_repairs = max_repairs
        self.k_refs = k_refs

    def generate(self, project: Project) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        started, tokens_before = time.time(), self.llm.total_tokens
        task = project.describe()
        refs = self.library.search(task, k=self.k_refs)
        learner_memory = self._learner_memory(project.learner_id)
        catalog = render_catalog()
        report: Dict[str, Any] = {
            "project_id": project.id,
            "references": [{"id": e.id, "name": e.name, "similarity": e.similarity,
                            "reward": e.reward} for e in refs],
            "learner_memory": learner_memory,
            "rounds": [],
            "fallback_modules": [],
        }

        # 生成
        system = fill(PROMPTS["generate_system"], catalog=catalog,
                      references=render_references(refs))
        user = fill(PROMPTS["generate_user"], project=task, learner_memory=learner_memory)
        raw = self.llm.chat([{"role": "system", "content": system},
                             {"role": "user", "content": user}])
        harness, parse_errors, _ = parse_blocks(raw, {})
        diags = merge(parse_errors, validate(normalize(harness)))
        report["rounds"].append({"stage": "generate", "system": system, "user": user,
                                 "response": raw, "diagnostics": diags})

        # 修复：只重写有问题的块
        history: List[str] = []
        for round_no in range(1, self.max_repairs + 1):
            if not diags:
                break
            logger.info("harness 校验未通过，第 %d 轮修复：%s", round_no, list(diags))
            repair_user = fill(PROMPTS["repair_user"], project=task,
                               harness=self._render_harness(harness),
                               diagnostics=render_diagnostics(diags),
                               history="\n".join(history) or "（无）")
            raw = self.llm.chat([{"role": "system",
                                  "content": fill(PROMPTS["repair_system"], catalog=catalog)},
                                 {"role": "user", "content": repair_user}], temperature=0.3)
            harness, parse_errors, updated = parse_blocks(raw, harness)
            history.append(f"第 {round_no} 轮：问题在 {list(diags)}；本轮重写了 {updated or '（无）'}")
            diags = merge(parse_errors, validate(normalize(harness)))
            report["rounds"].append({"stage": f"repair_{round_no}", "user": repair_user,
                                     "response": raw, "diagnostics": diags})

        # 兜底
        harness = normalize(harness)
        if diags:
            logger.warning("修复后仍有问题，按模块用参考模板兜底：%s", list(diags))
            report["fallback_modules"] = list(diags)
            harness = self._fallback(harness, list(diags), refs, project)
            diags = validate(harness)

        harness["meta"] = {"project_id": project.id, "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                           "references": [e.id for e in refs],
                           "repairs": len(report["rounds"]) - 1,
                           "fallback_modules": report["fallback_modules"]}
        report["valid"] = not diags
        report["final_diagnostics"] = diags
        report["tokens"] = self.llm.total_tokens - tokens_before
        report["seconds"] = round(time.time() - started, 1)
        return harness, report

    # ── 内部 ──

    def _learner_memory(self, learner_id: str) -> str:
        if self.memory is None:
            return "（记忆库未启用）"
        try:
            return self.memory.digest(learner_id) or "（这个学生还没有记忆，是第一次来）"
        except Exception as exc:
            logger.warning("读取学生记忆失败：%s", exc)
            return "（读取失败）"

    @staticmethod
    def _render_harness(harness: Dict[str, Any]) -> str:
        parts = []
        for tag, key in BLOCKS.items():
            if key not in harness:
                parts.append(f"<<<{tag}>>>\n（缺失）\n<<<END_{tag}>>>")
                continue
            body = harness[key] if key == "persona" else dump_harness(harness[key])
            parts.append(f"<<<{tag}>>>\n{str(body).strip()}\n<<<END_{tag}>>>")
        return "\n\n".join(parts)

    @staticmethod
    def _fallback(harness: Dict[str, Any], bad_blocks: List[str], refs: List[Template],
                  project: Project) -> Dict[str, Any]:
        ref = normalize(refs[0].harness)
        h = copy.deepcopy(harness)
        for block in bad_blocks:
            key = BLOCKS[block]
            h[key] = copy.deepcopy(ref.get(key, DEFAULTS.get(key, {})))

        if "PACING" in bad_blocks:
            # 范式与节奏用参考的；单元尽量保留生成结果里合格的，一个都没有就用学习目标兜底
            old_units = harness.get("pacing", {}).get("units", []) if isinstance(harness.get("pacing"), dict) else []
            units, seen = [], set()
            for u in old_units if isinstance(old_units, list) else []:
                if not check_unit(u) and str(u["id"]) not in seen:
                    units.append(u)
                    seen.add(str(u["id"]))
            h["pacing"]["units"] = units or [{"id": "u1", "title": project.title,
                                              "content_type": "概念理解", "objectives": [project.goal]}]

        # 技巧必须覆盖单元里出现的内容类型
        technique = h.setdefault("technique", {})
        by_type = technique.setdefault("by_content_type", {})
        for u in h["pacing"]["units"]:
            by_type.setdefault(u["content_type"], list(DEFAULT_TECHNIQUES_BY_TYPE[u["content_type"]]))
        return normalize(h)
