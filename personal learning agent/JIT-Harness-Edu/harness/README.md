# harness/

四个 harness 模块 + just-in-time 生成。

## harness.yaml 长什么样

每个项目一份，由 `jit/generator.py` 在创建项目时生成：

```yaml
persona: |            # 导师人设（系统提示开头）
  你是一位耐心、严谨的一对一导师……
pacing:               # ① 宏观方式与速度
  approach: 掌握学习          # 直接讲授 / 掌握学习 / 螺旋上升 / 项目驱动 / 探究发现 / 间隔检索
  pace: 中                    # 慢 ×1.5 / 中 ×1.0 / 快 ×0.7，乘到每单元计划轮数上
  turns_per_unit: 8
  mastery_threshold: 0.8      # 掌握度过线 → 出确认题 → 答对才前进
  slow_down_below: 0.5        # 最近两次作答平均低于它 → 放慢
  review_every: 5             # 每隔几轮插入一次对旧单元的间隔复习（0 = 不插）
  units:
    - {id: u1, title: 分数的意义, content_type: 概念理解, objectives: [...]}
ability:              # ② 内容学习能力
  learning_rate: 0.2          # 能力估计 += 步长 × (本次得分 − 当前估计)
  stretch: 0.1                # 难度目标 = 当前能力 + stretch（最近发展区）
  initial: {概念理解: 0.5, 程序技能: 0.4, ...}
  profiles:
    概念理解: {representations: [...], activities: [...], note: ...}
technique:            # ③ 教育技巧
  by_content_type: {概念理解: [苏格拉底提问, 类比讲解, 费曼复述], ...}
  on_struggle: 支架渐隐        # 放慢 / 超时 时
  on_review: 检索练习          # 复习时
  on_mastery: 迁移挑战         # 进阶 / 结课时
  assess_every: 2
  feedback_style: 先具体指出学生做对的一步……
  avoid: [直接给出完整答案]
memory:               # ④ 个人记忆
  recall_top_k: 5             # 每轮检索几条学生记忆
  experience_top_k: 2         # 每轮检索几条跨学生的教学经验
  history_turns: 8            # 带上最近几轮原始对话
  write_every: 2              # 每几轮把对话交给 mem0 抽取
  focus: 学生反复出错的步骤……  # 追加给 mem0 的抽取重点
meta: {...}           # 生成信息：参考了哪些模板、修复轮数、兜底了哪些模块
```

可选值全部来自 `catalog.py`，校验规则在 `jit/validate.py`。

## 每轮上课（runtime.py）

```
directive = pacing.directive(state)                    ① 本轮在哪个单元、什么模式
ability   = ability.view(unit.content_type, state)     ② 当前水平、难度目标、呈现方式、活动
plan      = technique.choose(directive, ability, state) ③ 用什么技巧、要不要出检测题
recall    = memory.recall(学生发言, directive, state)    ④ 学生记忆 + 教学经验 + 最近对话

系统提示 = persona + 项目信息 + ①②③④ 的文本 + 输出格式（要求附 <<<EVAL>>> 评估块）
回复, 评估 = 调模型并解析

pacing.update / ability.update / technique.update     分数记到“上一轮”的提问上
memory.record                                          满 write_every 轮就后台写入 mem0
```

模式说明：

| 模式 | 触发条件 | 技巧 |
|---|---|---|
| 新授 | 进入新单元的第一轮 | 按内容类型挑 |
| 巩固 | 默认 | 按内容类型挑 |
| 放慢 | 最近两次作答平均 < slow_down_below | on_struggle |
| 复习 | 每 review_every 轮，复习掌握度最低的旧单元 | on_review |
| 超时 | 本单元轮数 ≥ 计划轮数且未达标 | on_struggle |
| 进阶 | 掌握度 ≥ mastery_threshold，出确认题 | on_mastery |
| 结课 | 所有单元完成 | on_mastery |

## Just-in-time 生成（jit/）

只在**创建项目时调用一次**：

1. **找参考**：`library.search()` 按项目描述与模板的文本相似度（中文按相邻两字匹配）× 0.7 + 实测效果 × 0.3 排序，取前 3 个。参考只展示设计，不展示单元，避免照抄。
2. **读记忆**：`EduMemory.digest(learner_id)`，把这个学生按类别归组的记忆交给模型，用来定初始能力和技巧顺序。
3. **生成**：模型先写一段分析，再输出 `<<<PERSONA>>> <<<PACING>>> <<<ABILITY>>> <<<TECHNIQUE>>> <<<MEMORY>>>` 五个块（块内 YAML）。
4. **校验**：`validate()` 按模块列出问题，如“技巧「XX」不在教学技巧库中”“mastery_threshold=1.2 超出范围”。
5. **修复**：把当前 harness 和问题清单交回模型，只重写有问题的块，最多 2 轮。
6. **兜底**：还有问题的模块用最相关模板的同名模块替换；单元路线尽量保留生成结果里合格的单元。

完整过程（每轮的提示词、模型输出、问题清单）记录在 `projects/<项目ID>/jit_report.json`。

## 模板库（jit/library.py）

- 内置模板：`seeds/` 下 5 个 YAML。
- 沉淀模板：`finish_project()` 时计算学习效果（平均掌握度、结课测验、学生评价三者平均），满足以下条件就存进 `data/harness_library.json`：
  - 效果不低于它参考过的模板里实测效果最好的那个，并且效果更高、或用的课次更少、或用的 token 更少；
  - 参考里没有实测过的模板时，效果 ≥ 0.6。

## 扩展一个模块

四个模块的接口在 `protocol.py`。要换一种推进规则，比如按时间而不是按轮数推进，只需改 `modules/pacing.py`；
如果新规则需要新参数，同时在 `jit/validate.py` 的 `DEFAULTS` / `RANGES` 里登记，并在 `jit/prompts.yaml` 的格式说明里加上，模型就会生成它。
