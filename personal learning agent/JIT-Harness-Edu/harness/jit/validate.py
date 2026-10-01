"""harness 校验：纯规则检查，按模块列出问题，原样交给修复轮。

检查字段是否齐全、取值是否在能力注册表（catalog.py）里、数值是否在范围内。
"""

from __future__ import annotations

import copy
from typing import Any, Dict, List

from ..catalog import APPROACHES, PACES, TECHNIQUES
from ..protocol import CONTENT_TYPES

Diagnostics = Dict[str, List[str]]   # 块名(PACING/...) -> 问题列表

# 可选字段的默认值：缺了就补，不算错误
DEFAULTS = {
    "pacing": {"pace": "中", "turns_per_unit": 8, "mastery_threshold": 0.8,
               "slow_down_below": 0.5, "review_every": 5, "why": ""},
    "ability": {"learning_rate": 0.2, "stretch": 0.1, "initial": {}, "profiles": {}},
    "technique": {"on_struggle": "支架渐隐", "on_review": "检索练习", "on_mastery": "迁移挑战",
                  "assess_every": 2, "avoid": [],
                  "feedback_style": "先具体肯定做对的一点，再指出最关键的一个问题"},
    "memory": {"recall_top_k": 5, "experience_top_k": 2, "history_turns": 8,
               "write_every": 2, "focus": ""},
}

RANGES = {
    "pacing": {"turns_per_unit": (3, 30, int), "mastery_threshold": (0.5, 0.95, float),
               "slow_down_below": (0.2, 0.7, float), "review_every": (0, 20, int)},
    "ability": {"learning_rate": (0.05, 0.5, float), "stretch": (0.0, 0.3, float)},
    "technique": {"assess_every": (1, 5, int)},
    "memory": {"recall_top_k": (1, 10, int), "experience_top_k": (0, 5, int),
               "history_turns": (2, 20, int), "write_every": (1, 5, int)},
}


def normalize(harness: Dict[str, Any]) -> Dict[str, Any]:
    """补齐可选字段的默认值；不修改传入对象。"""
    h = copy.deepcopy(harness)
    for module, defaults in DEFAULTS.items():
        if isinstance(h.get(module), dict):
            h[module] = {**defaults, **h[module]}
    ability = h.get("ability")
    if isinstance(ability, dict) and isinstance(ability.get("initial"), dict):
        ability["initial"] = {ct: ability["initial"].get(ct, 0.5) for ct in CONTENT_TYPES}
    return h


def validate(harness: Dict[str, Any]) -> Diagnostics:
    diags: Diagnostics = {}

    def bad(block: str, msg: str) -> None:
        diags.setdefault(block, []).append(msg)

    persona = harness.get("persona")
    if not isinstance(persona, str) or len(persona.strip()) < 10:
        bad("PERSONA", "缺少导师人设文本（至少一两句话）")

    for module in RANGES:
        if not isinstance(harness.get(module), dict):
            bad(module.upper(), "块缺失，或块内不是 YAML 映射")
            continue
        for key, (lo, hi, typ) in RANGES[module].items():
            value = harness[module].get(key)
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                bad(module.upper(), f"{key} 必须是数字，当前为 {value!r}")
            elif typ is int and int(value) != value:
                bad(module.upper(), f"{key} 必须是整数，当前为 {value}")
            elif not lo <= value <= hi:
                bad(module.upper(), f"{key}={value} 超出范围 [{lo}, {hi}]")

    used_types = _check_pacing(harness.get("pacing"), bad)
    _check_ability(harness.get("ability"), bad)
    _check_technique(harness.get("technique"), used_types, bad)
    return diags


def check_unit(u: Any) -> List[str]:
    if not isinstance(u, dict):
        return ["单元必须是映射"]
    problems = []
    for key in ("id", "title"):
        if not str(u.get(key) or "").strip():
            problems.append(f"缺少 {key}")
    if u.get("content_type") not in CONTENT_TYPES:
        problems.append(f"content_type={u.get('content_type')!r} 不在 {CONTENT_TYPES} 中")
    objectives = u.get("objectives")
    if not isinstance(objectives, list) or not objectives:
        problems.append("objectives 必须是非空列表")
    return problems


def _check_pacing(p: Any, bad) -> List[str]:
    if not isinstance(p, dict):
        return []
    if p.get("approach") not in APPROACHES:
        bad("PACING", f"approach={p.get('approach')!r} 不是可选范式：{list(APPROACHES)}")
    if p.get("pace") not in PACES:
        bad("PACING", f"pace={p.get('pace')!r} 必须是 慢 / 中 / 快")
    units = p.get("units")
    if not isinstance(units, list) or not units:
        bad("PACING", "units 必须是非空列表")
        return []
    if len(units) > 30:
        bad("PACING", f"单元太多（{len(units)} 个），请合并到 30 个以内")
    ids, used = set(), []
    for i, u in enumerate(units):
        for problem in check_unit(u):
            bad("PACING", f"第 {i + 1} 个单元：{problem}")
        if isinstance(u, dict):
            if str(u.get("id")) in ids:
                bad("PACING", f"单元 id 重复：{u.get('id')}")
            ids.add(str(u.get("id")))
            if u.get("content_type") in CONTENT_TYPES:
                used.append(u["content_type"])
    return list(dict.fromkeys(used))


def _check_ability(a: Any, bad) -> None:
    if not isinstance(a, dict):
        return
    initial = a.get("initial")
    if not isinstance(initial, dict):
        bad("ABILITY", "initial 必须是 {内容类型: 0~1} 的映射")
    else:
        for ct, v in initial.items():
            if ct not in CONTENT_TYPES:
                bad("ABILITY", f"initial 里有未知内容类型 {ct!r}")
            elif isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= 1:
                bad("ABILITY", f"initial.{ct}={v!r} 必须是 0~1 的数字")
    profiles = a.get("profiles")
    if not isinstance(profiles, dict):
        bad("ABILITY", "profiles 必须是映射")
        return
    for ct, prof in profiles.items():
        if ct not in CONTENT_TYPES:
            bad("ABILITY", f"profiles 里有未知内容类型 {ct!r}")
        elif not isinstance(prof, dict):
            bad("ABILITY", f"profiles.{ct} 必须是映射")
        else:
            for key in ("representations", "activities"):
                if key in prof and not isinstance(prof[key], list):
                    bad("ABILITY", f"profiles.{ct}.{key} 必须是列表")


def _check_technique(t: Any, used_types: List[str], bad) -> None:
    if not isinstance(t, dict):
        return
    by_type = t.get("by_content_type")
    if not isinstance(by_type, dict):
        bad("TECHNIQUE", "by_content_type 必须是 {内容类型: [技巧, ...]} 的映射")
        by_type = {}
    for ct in used_types:
        if not by_type.get(ct):
            bad("TECHNIQUE", f"by_content_type 缺少单元里用到的内容类型「{ct}」")
    for ct, names in by_type.items():
        if ct not in CONTENT_TYPES:
            bad("TECHNIQUE", f"by_content_type 里有未知内容类型 {ct!r}")
        if not isinstance(names, list):
            bad("TECHNIQUE", f"by_content_type.{ct} 必须是列表")
            continue
        for name in names:
            if name not in TECHNIQUES:
                bad("TECHNIQUE", f"技巧「{name}」不在教学技巧库中")
    for key in ("on_struggle", "on_review", "on_mastery"):
        if t.get(key) not in TECHNIQUES:
            bad("TECHNIQUE", f"{key}={t.get(key)!r} 不在教学技巧库中")
    if not isinstance(t.get("avoid"), list):
        bad("TECHNIQUE", "avoid 必须是列表")
