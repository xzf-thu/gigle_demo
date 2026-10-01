"""四模块协议：固定接口 + 共享数据类型。

理念来自 JIT-Agent：harness 由固定的四个模块组成，按任务即时生成。四个模块在教育场景下对应为：

    JIT 模块          教育 harness 模块            回答的问题
    ─────────────     ──────────────────────      ─────────────────────────────
    Planning     →    ① 宏观方式与速度 Pacing       按什么范式教、走多快、何时前进/复习/放慢
    Tool Policy  →    ② 内容学习能力 Ability        这类内容学生能力如何、该给什么难度和活动
    Action       →    ③ 教育技巧 Technique          这一轮用什么教学技巧、怎么反馈、要不要检测
    Memory       →    ④ 个人记忆 PersonalMemory     记住这个学生什么、上课时想起什么

做法（刻意做简单）：四个模块的代码是固定的；每个项目只让大模型生成各模块的 YAML 规格
（参数 + 策略选择 + 课程单元），运行时由固定代码解释执行。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

# 五种内容类型：② 内容学习能力按这个维度分别建模
CONTENT_TYPES = ["概念理解", "程序技能", "事实记忆", "问题解决", "表达创作"]

# harness = 五个块。PERSONA 是整体人设/系统提示，其余四个是模块规格
MODULES = ["pacing", "ability", "technique", "memory"]
BLOCKS = {"PERSONA": "persona", "PACING": "pacing", "ABILITY": "ability",
          "TECHNIQUE": "technique", "MEMORY": "memory"}


# ── 教育项目 ──

@dataclass
class Project:
    id: str
    title: str
    subject: str
    goal: str
    learner_id: str
    learner_profile: str = ""
    total_sessions: int = 6
    minutes_per_session: int = 30
    materials: str = ""
    created_at: str = ""

    def describe(self) -> str:
        """给生成模型看的项目描述，也用于模板库检索。"""
        lines = [
            f"项目名称：{self.title}",
            f"学科/主题：{self.subject}",
            f"学习目标：{self.goal}",
            f"学习者：{self.learner_profile or '（未提供）'}",
            f"课时安排：共 {self.total_sessions} 次课，每次约 {self.minutes_per_session} 分钟",
        ]
        if self.materials:
            lines.append(f"学习材料摘要：\n{self.materials[:3000]}")
        return "\n".join(lines)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class Unit:
    id: str
    title: str
    content_type: str
    objectives: List[str] = field(default_factory=list)


# ── 运行时状态（每个项目一份，持久化到 state.json） ──

@dataclass
class LearnerState:
    unit_index: int = 0
    turns: int = 0                    # 全项目累计轮数
    turns_in_unit: int = 0
    sessions: int = 0                 # 已完成的课次（“时间/速度”信号）
    finished: bool = False
    mastery: Dict[str, float] = field(default_factory=dict)       # unit_id -> 0..1
    ability: Dict[str, float] = field(default_factory=dict)       # content_type -> 0..1
    recent_scores: List[float] = field(default_factory=list)
    technique_log: List[Dict[str, Any]] = field(default_factory=list)  # [{technique, score}]
    history: List[Dict[str, str]] = field(default_factory=list)        # 近期原始对话
    last_prompt: Dict[str, Any] = field(default_factory=dict)          # 上一轮的安排（学生本轮作答是对它的回应）
    tokens: int = 0                   # 累计 token（“成本”信号）

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "LearnerState":
        known = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        return cls(**known)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# ── 模块之间传递的数据 ──

@dataclass
class Directive:
    """① 宏观模块给出的本轮指令。"""
    unit: Unit
    mode: str          # 新授 / 巩固 / 复习 / 放慢 / 进阶 / 结课
    text: str
    review_unit: Optional[Unit] = None


@dataclass
class AbilityView:
    """② 能力模块对当前内容类型的判断。"""
    content_type: str
    level: float
    label: str
    target_difficulty: float
    representations: List[str]
    activities: List[str]
    text: str


@dataclass
class TechniquePlan:
    """③ 技巧模块为本轮选择的教学动作。"""
    name: str
    instruction: str
    assess: bool       # 本轮是否要做形成性检测
    reason: str = ""


@dataclass
class MemoryView:
    """④ 记忆模块为本轮准备的上下文。"""
    recalled: List[str]
    experiences: List[str]
    history: List[Dict[str, str]]
    text: str


@dataclass
class TurnEval:
    """导师每轮顺带给出的评估（从回复里的 <<<EVAL>>> 块解析）。"""
    score: Optional[float] = None     # 学生本轮表现 0..1；没检测就是 None
    misconception: str = ""
    emotion: str = ""
    note: str = ""


# ── 四个模块的固定接口 ──

class BasePacing(ABC):
    """① 宏观方式与速度。"""

    def __init__(self, spec: Dict[str, Any]):
        self.spec = spec

    @abstractmethod
    def units(self) -> List[Unit]: ...

    @abstractmethod
    def directive(self, state: LearnerState) -> Directive: ...

    @abstractmethod
    def update(self, state: LearnerState, directive: Directive, prev: Dict[str, Any],
               ev: TurnEval) -> Optional[str]:
        """更新掌握度与进度；返回进度事件（如“进入下一单元”）或 None。

        prev 是上一轮的安排：学生本轮的作答回应的是上一轮的提问，分数记到那里。
        """


class BaseAbility(ABC):
    """② 内容学习能力：决定本轮的难度、呈现方式和可用活动。"""

    def __init__(self, spec: Dict[str, Any]):
        self.spec = spec

    @abstractmethod
    def view(self, content_type: str, state: LearnerState) -> AbilityView: ...

    @abstractmethod
    def update(self, content_type: str, state: LearnerState, ev: TurnEval) -> None: ...


class BaseTechnique(ABC):
    """③ 教育技巧：决定这一轮具体怎么教。"""

    def __init__(self, spec: Dict[str, Any]):
        self.spec = spec

    @abstractmethod
    def choose(self, directive: Directive, ability: AbilityView, state: LearnerState) -> TechniquePlan: ...

    @abstractmethod
    def update(self, plan: TechniquePlan, state: LearnerState, ev: TurnEval) -> None: ...


class BasePersonalMemory(ABC):
    """④ 个人记忆。长期记忆落在 memory/（mem0）。"""

    def __init__(self, spec: Dict[str, Any]):
        self.spec = spec

    @abstractmethod
    def recall(self, query: str, directive: Directive, state: LearnerState) -> MemoryView: ...

    @abstractmethod
    def record(self, user_msg: str, reply: str, state: LearnerState,
               metadata: Dict[str, Any]) -> None: ...

    @abstractmethod
    def save_experiences(self, experiences: List[str], metadata: Dict[str, Any]) -> None: ...
