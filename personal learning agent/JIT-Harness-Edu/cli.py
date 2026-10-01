"""命令行入口。

    python cli.py new                      创建教育项目（交互式；会生成一次 harness）
    python cli.py list                     列出项目
    python cli.py show <项目ID>            查看项目的 harness 和生成过程
    python cli.py class <项目ID>           上课（输入 /status 看进度，/end 下课）
    python cli.py finish <项目ID> [--rating 4] [--post-test 85]   结课
    python cli.py library                  查看模板库
    python cli.py memory seed              导入内置教学经验
    python cli.py memory profile --learner <学生ID>
    python cli.py memory search --learner <学生ID> "分数除法"
    python cli.py memory list [--learner <学生ID>]       不带 --learner 列出教学经验
    python cli.py memory forget --learner <学生ID>
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

DIM, BOLD, GREEN, YELLOW, RESET = "\033[2m", "\033[1m", "\033[32m", "\033[33m", "\033[0m"


def ask(prompt: str, default: str = "") -> str:
    hint = f"（默认 {default}）" if default else ""
    value = input(f"{prompt}{hint}：").strip()
    return value or default


def make_agent(use_memory: bool = True):
    from agent import EduAgent

    agent = EduAgent(use_memory=use_memory)
    if use_memory and agent.memory is None:
        print(f"{YELLOW}⚠ 长期记忆不可用（{agent.memory_error}），本次只使用会话内记忆。{RESET}")
    return agent


def print_harness(harness: dict) -> None:
    p, a, t, m = harness["pacing"], harness["ability"], harness["technique"], harness["memory"]
    print(f"{BOLD}① 宏观方式与速度{RESET}  {p['approach']} · 速度{p['pace']} · 每单元约 {p['turns_per_unit']} 轮 · "
          f"达标线 {p['mastery_threshold']} · 每 {p['review_every']} 轮复习")
    print(f"   理由：{p.get('why', '')}")
    for i, u in enumerate(p["units"], 1):
        print(f"   {i}. {u['title']}（{u['content_type']}）— {'；'.join(u['objectives'])}")
    used = list(dict.fromkeys(u["content_type"] for u in p["units"]))
    print(f"{BOLD}② 内容学习能力{RESET}  " +
          "  ".join(f"{ct} {a['initial'].get(ct, 0.5):.2f}" for ct in used))
    print(f"{BOLD}③ 教育技巧{RESET}  " +
          "  ".join(f"{ct}:{'/'.join(t['by_content_type'].get(ct, []))}" for ct in used))
    print(f"   卡住→{t['on_struggle']}  复习→{t['on_review']}  达标→{t['on_mastery']}  "
          f"每 {t['assess_every']} 轮检测")
    print(f"{BOLD}④ 个人记忆{RESET}  回忆 {m['recall_top_k']} 条 · 参考经验 {m['experience_top_k']} 条 · "
          f"保留 {m['history_turns']} 轮对话 · 每 {m['write_every']} 轮写入")
    if m.get("focus"):
        print(f"   重点记住：{m['focus']}")


def print_status(st: dict) -> None:
    print(f"  单元 {st['unit']}{'（已全部完成）' if st['finished'] else ''} · 范式 {st['approach']}")
    print("  掌握度：" + "  ".join(f"{k} {v:.0%}" for k, v in st["mastery"].items()))
    print("  能力：" + "  ".join(f"{k} {v:.2f}" for k, v in st["ability"].items()))
    print(f"  累计 {st['turns']} 轮 · {st['sessions']} 次课 · {st['tokens']} tokens")


# ── 命令 ──

def cmd_new(args) -> None:
    agent = make_agent()
    print(f"{BOLD}创建教育项目{RESET}")
    title = ask("项目名称")
    subject = ask("学科/主题")
    goal = ask("学习目标")
    learner_id = ask("学生ID（同一个学生多个项目用同一个ID，记忆会共享）", "student1")
    profile = ask("学生情况（年级、基础、特点，可空）")
    sessions = int(ask("计划上几次课", "6"))
    minutes = int(ask("每次课多少分钟", "30"))
    materials_path = ask("学习材料文件路径（可空）")
    materials = Path(materials_path).expanduser().read_text(encoding="utf-8") if materials_path else ""

    print(f"\n{DIM}正在为这个项目生成 harness……{RESET}")
    project, harness, report = agent.create_project(title, subject, goal, learner_id, profile,
                                                    sessions, minutes, materials)
    print(f"\n{GREEN}✓ 项目已创建：{project.id}{RESET}")
    refs = "、".join(f"{r['name']}({r['similarity']:.2f})" for r in report["references"])
    print(f"{DIM}参考模板：{refs}｜修复 {harness['meta']['repairs']} 轮"
          f"｜兜底模块 {report['fallback_modules'] or '无'}｜{report['tokens']} tokens · {report['seconds']}s{RESET}\n")
    print_harness(harness)
    print(f"\n开始上课：python cli.py class {project.id}")


def cmd_list(args) -> None:
    agent = make_agent(use_memory=False)
    rows = agent.list_projects()
    if not rows:
        print("还没有项目。用 python cli.py new 创建一个。")
    for r in rows:
        status = "已结课" if r["finished"] else f"已上 {r['sessions']} 次课"
        print(f"{r['id']}  {r['title']}  学生:{r['learner_id']}  {status}")


def cmd_show(args) -> None:
    agent = make_agent(use_memory=False)
    project = agent.load_project(args.project)
    print(f"{BOLD}{project.title}{RESET}（{project.subject}）学生：{project.learner_id}\n目标：{project.goal}\n")
    print_harness(agent.load_harness(args.project))
    report = agent.jit_report(args.project)
    if report:
        print(f"\n{BOLD}生成过程{RESET}")
        for r in report["rounds"]:
            problems = sum(len(v) for v in r["diagnostics"].values())
            verdict = "通过" if not problems else f"{problems} 个问题，涉及 {list(r['diagnostics'])}"
            print(f"  {r['stage']}: {verdict}")
        print(f"  学生记忆：{report['learner_memory'][:200]}")
    print(f"\n{DIM}完整 harness：{agent.project_dir(args.project) / 'harness.yaml'}{RESET}")


def cmd_class(args) -> None:
    agent = make_agent()
    runtime = agent.open_class(args.project)
    if runtime.state.finished:
        print(f"{YELLOW}这个项目的所有单元都已完成，本次课将做总复盘。{RESET}")
    print(f"{DIM}上课中。输入 /status 看进度，/end 下课。{RESET}\n")

    def show(turn) -> None:
        print(f"{GREEN}导师{RESET}：{turn.reply}")
        score = "—" if turn.eval.score is None else f"{turn.eval.score:.2f}"
        print(f"{DIM}  [{turn.unit} · {turn.mode} · {turn.technique} · 得分 {score}]{RESET}")
        if turn.event:
            print(f"{YELLOW}  ▶ {turn.event}{RESET}")

    show(runtime.start_session())
    try:
        while True:
            user = input(f"\n{BOLD}你{RESET}：").strip()
            if not user:
                continue
            if user in ("/end", "/quit", "/exit"):
                break
            if user == "/status":
                print_status(runtime.status())
                continue
            try:
                show(runtime.chat(user))
            except Exception as exc:  # 网络/接口偶发错误：提示后可以重发
                print(f"{YELLOW}⚠ 调用模型失败：{exc}（可以重新发送）{RESET}")
    except (EOFError, KeyboardInterrupt):
        print()

    print(f"\n{DIM}下课，正在整理本次课的记忆……{RESET}")
    summary = runtime.end_session()
    if summary["progress"]:
        print(f"本次进度：{summary['progress']}")
    for e in summary["experiences"]:
        print(f"{DIM}  + {e}{RESET}")


def cmd_finish(args) -> None:
    agent = make_agent(use_memory=False)
    result = agent.finish_project(args.project, rating=args.rating, post_test=args.post_test)
    print("效果信号：" + "，".join(f"{k} {v:.2f}" for k, v in result["signals"].items()))
    m = result["metrics"]
    print(f"综合效果 {m['reward']:.2f} · {m['sessions']} 次课 · {m['tokens']} tokens")
    print(("✓ " if result["saved_to_library"] else "· ") + result["reason"])


def cmd_library(args) -> None:
    agent = make_agent(use_memory=False)
    for t in agent.library.all():
        print(f"{t.id:<32} {t.name}  [{t.source}] {t.score_text()}")


def cmd_memory(args) -> None:
    agent = make_agent()
    mem = agent.memory
    if mem is None:
        sys.exit("记忆库不可用，请检查 .env 里的模型与嵌入配置。")
    if args.action == "seed":
        print(f"已导入 {mem.seed_experiences()} 条教学经验。")
    elif args.action == "profile":
        for category, texts in mem.profile(args.learner).items():
            print(f"{BOLD}【{category}】{RESET}")
            for t in texts:
                print(f"  - {t}")
    elif args.action == "search":
        items = mem.recall(args.learner, args.query) if args.learner else mem.recall_experience(args.query)
        for it in items:
            print(f"{it.score or 0:.2f}  {it.text}")
    elif args.action == "list":
        for it in mem.list(args.learner):
            print(f"{it.id[:8]}  {it.text}")
    elif args.action == "forget":
        if input(f"确认删除学生 {args.learner} 的全部记忆？(y/N) ").lower() == "y":
            mem.forget_learner(args.learner)
            print("已删除。")


def main() -> None:
    parser = argparse.ArgumentParser(description="教育 JIT Agent")
    parser.add_argument("-v", "--verbose", action="store_true", help="显示详细日志")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("new", help="创建教育项目").set_defaults(func=cmd_new)
    sub.add_parser("list", help="列出项目").set_defaults(func=cmd_list)
    for name, func, help_text in [("show", cmd_show, "查看项目"), ("class", cmd_class, "上课")]:
        p = sub.add_parser(name, help=help_text)
        p.add_argument("project")
        p.set_defaults(func=func)
    p = sub.add_parser("finish", help="结课并评估")
    p.add_argument("project")
    p.add_argument("--rating", type=int, choices=range(1, 6), help="学生满意度 1~5")
    p.add_argument("--post-test", type=float, help="结课测验分 0~100")
    p.set_defaults(func=cmd_finish)
    sub.add_parser("library", help="查看模板库").set_defaults(func=cmd_library)
    p = sub.add_parser("memory", help="记忆库")
    p.add_argument("action", choices=["seed", "profile", "search", "list", "forget"])
    p.add_argument("query", nargs="?", default="")
    p.add_argument("--learner", default="")
    p.set_defaults(func=cmd_memory)

    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO if args.verbose else logging.WARNING,
                        format="%(levelname)s %(name)s: %(message)s")
    if not args.verbose:  # mem0 / qdrant 的提示信息对使用者没用
        for noisy in ("mem0", "qdrant_client", "httpx"):
            logging.getLogger(noisy).setLevel(logging.ERROR)
    if args.cmd == "memory" and args.action in ("profile", "forget") and not args.learner:
        parser.error("需要 --learner")
    args.func(args)


if __name__ == "__main__":
    main()
