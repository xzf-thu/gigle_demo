# 教育 JIT Agent

一个用大模型 API 搭建的 AI 家教 Agent。**每创建一个教育项目，就为它“即时”生成一套专属的教学 harness**，
然后按这套 harness 上课；上课过程中的学习体验存进基于 **mem0 开源版** 的记忆库，下次生成 harness 和上课时都会用上。

理念借鉴自 [JIT-Agent](https://github.com/bingreeky/JIT)（[论文](https://arxiv.org/abs/2608.25593)）：
Agent 的表现不只取决于模型，还取决于包在模型外面的 harness；与其写一个通用 harness 到处用，
不如针对手头的任务即时生成一个。本项目只取这个理念，是一个纯 API 调用的应用，不涉及任何模型训练。

## 核心概念

**harness = 四个模块**，每个模块回答一个教学问题：

| 模块 | 回答的问题 | 生成时决定什么 | 上课时每轮做什么 |
|---|---|---|---|
| ① 宏观方式与速度 `pacing` | 按什么范式教、走多快 | 教学范式、速度、单元路线、达标线、复习间隔 | 判断本轮是 新授/巩固/复习/放慢/进阶/超时/结课 |
| ② 内容学习能力 `ability` | 这类内容学生学得怎么样 | 五类内容的初始能力、各自的呈现方式与学习活动 | 给出难度目标（略高于当前水平），按作答更新能力 |
| ③ 教育技巧 `technique` | 这一轮具体怎么教 | 每类内容的候选技巧、卡住/复习/达标时的技巧、反馈风格 | 挑技巧（没试过的先试，试过的挑对这个学生最有效的），决定是否出检测题 |
| ④ 个人记忆 `memory` | 记住学生什么、想起什么 | 回忆条数、保留几轮对话、本项目重点记什么 | 检索学生记忆和教学经验；把对话交给 mem0 抽取成记忆 |

四个模块的**代码是固定的**，每个项目只生成它们的 **YAML 规格**（参数 + 策略选择 + 课程单元），存成 `harness.yaml`，可以直接打开看、手动改。

**Just-in-time：每个项目创建时生成一次 harness。**

```
创建项目 ──► 从模板库找相似模板 ─┐
            从记忆库读学生记忆 ──┼─► 大模型生成 harness ─► 规则校验 ─► 有问题就修复（≤2 轮）─► 仍不行的模块用模板兜底
                                 ┘                                                              │
                                                                                              harness.yaml
上课（可以很多次）：每轮 ①定进度 → ②定难度 → ③选技巧 → ④想起记忆 → 调模型回复 → 四个模块各自更新
                    后台把对话写入 mem0；下课时总结本次进度和可复用的教学经验
结课：算学习效果 → 效果好的 harness 沉淀进模板库，以后相似项目优先参考
```

## 目录

```
edu-jit-agent/
├── agent.py            产品服务层 EduAgent：创建项目 / 上课 / 结课（CLI、Web 后端都只调它）
├── cli.py              命令行入口
├── llm.py              OpenAI 兼容的模型客户端
├── settings.py         配置（读 .env）
├── harness/            ── 四个 harness 模块 + just-in-time 生成
│   ├── protocol.py         四模块的固定接口和数据类型
│   ├── catalog.py          可选的教学范式 / 内容类型 / 教学技巧（生成和校验都以它为准）
│   ├── modules/            四个模块的实现
│   │   ├── pacing.py           ① 宏观方式与速度
│   │   ├── ability.py          ② 内容学习能力
│   │   ├── technique.py        ③ 教育技巧
│   │   └── personal_memory.py  ④ 个人记忆
│   ├── runtime.py          TutorRuntime：把四个模块接起来上课
│   ├── jit/                just-in-time 生成
│   │   ├── generator.py        找参考 → 生成 → 校验 → 修复 → 兜底
│   │   ├── validate.py         规则校验
│   │   ├── library.py          模板库（内置 + 沉淀）
│   │   └── prompts.yaml        生成 / 修复提示词
│   └── seeds/              5 套内置模板（掌握学习、间隔检索、项目驱动、探究发现、螺旋上升）
├── memory/             ── 教育记忆库（基于 mem0 开源版）
│   ├── edu_memory.py       EduMemory：学生记忆 + 教学经验
│   ├── prompts.py          记忆类别与抽取指令
│   ├── config.py           mem0 配置（本地 Qdrant）
│   └── seed_experiences.yaml  21 条内置教学经验
├── tests/              离线测试（不需要 API Key）
├── data/               运行时生成：mem0 向量库、模板库
└── projects/           运行时生成：每个项目一个目录
```

## 快速开始

```bash
pip install -r requirements.txt
```

```bash
cp .env.example .env
```

在 `.env` 里填上 `LLM_API_KEY`。默认用阿里云百炼（一个 Key 同时提供对话和向量），也可以换成任何 OpenAI 兼容服务，见 `.env.example` 里的方案 B。

导入内置教学经验（只需一次）：

```bash
python cli.py memory seed
```

创建一个教育项目（交互式填写；这一步会生成 harness）：

```bash
python cli.py new
```

上课（`/status` 看进度，`/end` 下课）：

```bash
python cli.py class <项目ID>
```

结课并评估（学生满意度 1~5、结课测验 0~100，都可省略）：

```bash
python cli.py finish <项目ID> --rating 4 --post-test 85
```

其他命令：`list`、`show <项目ID>`、`library`、`memory profile --learner <学生ID>`、`memory search --learner <学生ID> "关键词"`、`memory forget --learner <学生ID>`。

## 在代码里调用

```python
from agent import EduAgent

agent = EduAgent()
project, harness, report = agent.create_project(
    title="一元一次方程入门", subject="初中数学", goal="会解一元一次方程并列方程解应用题",
    learner_id="stu_001", learner_profile="初二，基础一般，喜欢生活中的例子",
    total_sessions=4, minutes_per_session=30,
)

tutor = agent.open_class(project.id)
print(tutor.start_session().reply)
turn = tutor.chat("是不是两边同时加 3？")
print(turn.reply, turn.mode, turn.technique, turn.eval.score, turn.event)
tutor.end_session()

agent.finish_project(project.id, rating=5, post_test=90)
```

接 Web 后端时，每个请求调 `open_class(project_id).chat(...)` 即可：学习进度都持久化在 `projects/<项目ID>/state.json`。

## 一些设计选择

- **分数记到上一轮。** 学生这一轮的作答，回应的是导师上一轮的提问，所以掌握度、能力、技巧效果都记到上一轮的单元和技巧上。
- **先确认再前进。** 掌握度过线后先出一道确认题（进阶），答对才进入下一单元；一个单元超过计划轮数两倍会强制前进，避免卡死。
- **评估顺带做。** 导师每次回复末尾附一个学生看不到的 `<<<EVAL>>>` 评估块，不额外调用模型。
- **记忆不拖慢上课。** mem0 写入在后台线程进行，下课时才等它写完。
- **一定能开课。** 生成失败的模块会用最相关的模板兜底；`harness.yaml` 被手动改坏时，开课前会报出具体问题。
- **没有照搬的部分。** 不生成 Python 代码、不做多候选采样与挑选、不做评审团、不训练模型。

## 扩展

| 想做的事 | 改哪里 |
|---|---|
| 增加教学技巧、教学范式 | `harness/catalog.py`（生成提示词和校验会自动跟上） |
| 增加内置模板 | 在 `harness/seeds/` 放一个 YAML（格式同现有文件） |
| 调整每轮的推进/选技巧规则 | `harness/modules/` 下对应模块 |
| 换向量库（如 pgvector、Milvus） | `memory/config.py` 的 `vector_store` |
| 调整记忆类别和抽取规则 | `memory/prompts.py` |

## 测试

```bash
python tests/test_offline.py
```

测试会启动一个假的 OpenAI 兼容服务，用真实的 mem0 + 本地 Qdrant 跑完 创建项目 → 修复 → 上课 → 下课 → 结课 → 第二个项目 的完整流程。
`python tests/fake_openai.py` 也可以单独启动，作为没有 Key 时的演示后端（把 `.env` 里的地址指到 `http://127.0.0.1:8765/v1`，并设 `EMBED_DIMS=64`）。

## 注意

- `EMBED_DIMS` 必须等于向量模型的实际输出维度；换向量模型后删除 `data/mem0` 重建。
- 本地 Qdrant 同一时间只允许一个进程打开，不要同时开两个 `cli.py class`；多用户部署请把向量库换成 Qdrant 服务或 pgvector。
- 记忆里是学生的学习数据，`memory forget --learner <学生ID>` 可以删除某个学生的全部记忆。
