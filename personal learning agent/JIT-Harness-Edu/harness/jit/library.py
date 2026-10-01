"""模板库：生成 harness 时的参考来源。

- 内置模板：harness/seeds/*.yaml，几套手写的典型教学 harness
- 沉淀模板：项目结课后效果好的 harness 自动存进 data/harness_library.json，下次相似项目优先参考
- 检索：按与新项目描述的文本相似度 + 实测效果排序，取前几个给生成器参考

沉淀规则：效果不低于它参考过的模板里最好的那个，并且至少有一项更好
（效果更高 / 用的课次更少 / token 更少）；没有可比的实测模板时，效果 ≥ 0.6 即可。
"""

from __future__ import annotations

import copy
import json
import math
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

SEEDS_DIR = Path(__file__).resolve().parents[1] / "seeds"


@dataclass
class Template:
    id: str
    name: str
    description: str
    task: str                         # 检索用的文本
    harness: Dict[str, Any]
    source: str = "内置"              # 内置 / 沉淀
    reward: Optional[float] = None    # 学习效果 0~1
    sessions: Optional[int] = None    # 用了几次课
    tokens: Optional[int] = None      # 用了多少 token
    created_at: str = ""
    similarity: float = field(default=0.0, compare=False)

    def score_text(self) -> str:
        if self.reward is None:
            return "内置模板，未经实测"
        return f"实测效果 {self.reward:.2f}，用了 {self.sessions} 次课、{self.tokens} tokens"


def _grams(text: str) -> set:
    """中文按相邻两字、英文按单词切分；够用且不依赖分词库。"""
    t = text.lower()
    compact = re.sub(r"\s+", "", t)
    return {compact[i:i + 2] for i in range(len(compact) - 1)} | set(re.findall(r"[a-z0-9]+", t))


def similarity(a: str, b: str) -> float:
    A, B = _grams(a), _grams(b)
    if not A or not B:
        return 0.0
    return len(A & B) / math.sqrt(len(A) * len(B))


class HarnessLibrary:
    MIN_REWARD = 0.6     # 没有可比模板时的沉淀门槛
    DEFAULT_REWARD = 0.5 # 内置模板没有实测效果，排序时按 0.5 计

    def __init__(self, library_path: Path, seeds_dir: Path = SEEDS_DIR):
        self.path = Path(library_path)
        self.builtin = self._load_builtin(seeds_dir)
        self.saved = self._load_saved()

    def all(self) -> List[Template]:
        return self.builtin + self.saved

    def get(self, template_id: str) -> Optional[Template]:
        return next((t for t in self.all() if t.id == template_id), None)

    def search(self, task_text: str, k: int = 3) -> List[Template]:
        scored = [(t, similarity(task_text, t.task)) for t in self.all()]
        top_sim = max((s for _, s in scored), default=0.0) or 1.0

        def rank(item):
            t, s = item
            reward = self.DEFAULT_REWARD if t.reward is None else t.reward
            return 0.7 * s / top_sim + 0.3 * reward

        hits = []
        for t, s in sorted(scored, key=rank, reverse=True)[:k]:
            hit = copy.copy(t)
            hit.similarity = round(s, 3)
            hits.append(hit)
        return hits

    def save_if_better(self, project_id: str, name: str, task: str, harness: Dict[str, Any],
                       metrics: Dict[str, Any], ref_ids: List[str]) -> Tuple[bool, str]:
        """结课后判断这个项目的 harness 值不值得沉淀为模板。"""
        r, n, c = float(metrics["reward"]), int(metrics["sessions"]), int(metrics["tokens"])
        tested = [t for t in (self.get(i) for i in ref_ids) if t and t.reward is not None]
        if tested:
            best = max(tested, key=lambda t: (t.reward, -t.sessions, -t.tokens))
            if r < best.reward:
                return False, f"效果 {r:.2f} 不如参考模板「{best.name}」({best.reward:.2f})，不沉淀"
            if not (r > best.reward or n < best.sessions or c < best.tokens):
                return False, f"与参考模板「{best.name}」持平，也没有更省课次或 token，不沉淀"
            reason = f"优于参考模板「{best.name}」({best.reward:.2f})，已沉淀为新模板"
        elif r < self.MIN_REWARD:
            return False, f"效果 {r:.2f} 低于沉淀门槛 {self.MIN_REWARD}，不沉淀"
        else:
            reason = f"效果 {r:.2f} 达到门槛，已沉淀为新模板"

        entry = Template(
            id=f"proj:{project_id}", name=name,
            description=harness.get("pacing", {}).get("why", ""), task=task,
            harness={k: v for k, v in harness.items() if k != "meta"}, source="沉淀",
            reward=round(r, 3), sessions=n, tokens=c, created_at=time.strftime("%Y-%m-%d %H:%M:%S"),
        )
        self.saved = [t for t in self.saved if t.id != entry.id] + [entry]
        self._save()
        return True, reason

    # ── 持久化 ──

    @staticmethod
    def _load_builtin(seeds_dir: Path) -> List[Template]:
        out = []
        for path in sorted(Path(seeds_dir).glob("*.yaml")):
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
            out.append(Template(
                id=f"seed:{path.stem}", name=data["name"], description=data["description"],
                task=f"{data['name']} {data['description']} {data.get('suited_for', '')}",
                harness=data["harness"],
            ))
        if not out:
            raise FileNotFoundError(f"没有找到内置模板：{seeds_dir}")
        return out

    def _load_saved(self) -> List[Template]:
        if not self.path.exists():
            return []
        rows = json.loads(self.path.read_text(encoding="utf-8"))
        return [Template(**{k: v for k, v in row.items() if k != "similarity"}) for row in rows]

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        rows = [{k: v for k, v in asdict(t).items() if k != "similarity"} for t in self.saved]
        self.path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
