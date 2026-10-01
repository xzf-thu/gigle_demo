"""教育 harness：四个模块 + 固定编排器 + JIT 生成。"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

import yaml


class _BlockDumper(yaml.SafeDumper):
    """多行字符串用 | 块样式输出，harness.yaml 更好读、好手改。"""


def _str_presenter(dumper, data):
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


_BlockDumper.add_representer(str, _str_presenter)


def dump_harness(harness: Dict[str, Any]) -> str:
    return yaml.dump(harness, Dumper=_BlockDumper, allow_unicode=True, sort_keys=False, width=100)


def save_harness(harness: Dict[str, Any], path: Path) -> None:
    Path(path).write_text(dump_harness(harness), encoding="utf-8")


def load_harness(path: Path) -> Dict[str, Any]:
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))
