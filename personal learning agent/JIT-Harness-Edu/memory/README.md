# memory/

基于 [mem0 开源版](https://github.com/mem0ai/mem0)（`mem0ai` 2.x）的教育记忆库。

## 存什么

两个作用域，都在同一个 mem0 实例里：

| 作用域 | mem0 标识 | 内容 | 怎么写入 |
|---|---|---|---|
| 学生记忆 | `user_id=<学生ID>` | 这个学生的学习体验 | 上课对话交给 mem0 自动抽取；下课时直接写一条“学习进度” |
| 教学经验 | `agent_id=edu_teacher` | 跨学生可复用的经验 | 下课时模型总结 1~3 条；`seed_experiences.yaml` 内置 21 条 |

学生记忆的类别（每条记忆以【类别】开头，便于阅读和归组）：

| 类别 | 例子 |
|---|---|
| 背景信息 | 【背景信息】学生读初二，数学期中 75 分，想在期末前补上方程 |
| 学习偏好 | 【学习偏好】学生喜欢先看生活中的例子，再看公式 |
| 知识掌握 | 【知识掌握】学生能正确用移项解 2x+3=7 这类方程 |
| 易错点 | 【易错点】学生移项时常忘记变号，把 x+3=5 解成 x=8 |
| 有效技巧 | 【有效技巧】用天平类比讲等式性质后，学生马上理解了两边同时加减 |
| 学习状态 | 【学习状态】学生连续答错两题后明显沮丧，说“我数学就是不行” |
| 学习进度 | 【学习进度】学完了等式的性质，下次从解方程继续 |

抽取规则在 `prompts.py`：通过 mem0 的自定义指令，把它通用的“事实抽取器”改造成中文的教育体验抽取器；
每个项目的 harness 还可以通过 `memory.focus` 追加本项目的抽取重点。

## 怎么用

```python
from memory import EduMemory

mem = EduMemory()                      # 读 .env；数据在 data/mem0/

# 写
mem.remember_turns("stu_001", [
    {"role": "user", "content": "x+3=5，x 是 8 吧？"},
    {"role": "assistant", "content": "再想想，3 移到右边要变号哦……"},
], metadata={"project_id": "...", "unit": "解一元一次方程"})
mem.add_note("stu_001", "学完了等式的性质，下次从解方程继续", category="学习进度")
mem.add_experience("【教学经验】初二学生学移项时，先用天平演示再做题，变号错误明显减少")
mem.seed_experiences()                 # 导入内置教学经验

# 读
mem.recall("stu_001", "移项", k=5)     # 检索学生记忆 -> [MemoryItem(id, text, category, score, metadata)]
mem.recall_experience("程序技能 解方程", k=3)
mem.profile("stu_001")                 # {类别: [记忆, ...]}
mem.digest("stu_001")                  # 给 harness 生成用的文本摘要

# 删
mem.delete(memory_id)
mem.forget_learner("stu_001")
```

harness 只通过这几个方法访问记忆，换掉 mem0 也不用改 harness。

## 配置（config.py）

| 部件 | 默认 | 说明 |
|---|---|---|
| LLM | OpenAI 兼容接口，`MEMORY_MODEL` | mem0 用它抽取记忆，需支持 `response_format=json_object` |
| 向量模型 | OpenAI 兼容 `/v1/embeddings`，`EMBED_MODEL` | 也支持 `EMBED_PROVIDER=ollama / huggingface` |
| 向量库 | 本地 Qdrant，`data/mem0/qdrant` | 单进程；多用户部署换成 Qdrant 服务或 pgvector |
| 历史库 | SQLite，`data/mem0/history.db` | mem0 记录每条记忆的增改历史 |

mem0 的遥测默认关闭（`MEM0_TELEMETRY=False`）。

## 线程

本地 Qdrant 要求始终在创建它的线程里访问，所以 `EduMemory` 把所有 mem0 调用放在一个专用后台线程里：
上课时的写入不等待（`remember_turns(..., wait=False)`），之后的读取自动排在写入后面；下课时 `wait()` 等全部写完。

## 关于 mem0 2.x

- `search()` / `get_all()` 用 `filters={"user_id": ...}` 指定作用域，不再接受顶层 `user_id` 参数（与 1.x 不同）。
- 2.x 的抽取流程只做“新增”，靠内容哈希去重，不会自动合并或删除旧记忆；需要清理时用 `delete()` / `forget_learner()`。
- 启动时可能提示未安装 spaCy / fastembed：它们用于英文的关键词检索和实体抽取增强；不装也能正常做语义检索，命令行默认不显示这些提示。
