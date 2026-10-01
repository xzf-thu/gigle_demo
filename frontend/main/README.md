# Gigle 主页

主页展示本机真实资料，不再载入演示项目。请从 `frontend/启动Gigle.command` 启动；本机服务会同时提供主页、白板、DeepSeek API 代理和资料存储接口。

创建的每个原子都保存在 `data/user/user_studymaterial_data/` 的对应目录，结构与主页文件夹层级一致。每个原子文件夹含 `atom.json`，上传资料放在 `assets/`，退出白板时生成 `preview.png`。所有格式共享同一份 `schemaVersion: 1` 数据结构：`format`、`sources`、`board`、`preview`。Web Search 当前由 DeepSeek 生成概述，未进行联网检索。

创建项目时，本机服务会调用 `personal learning agent/JIT-Harness-Edu/web_bridge.py`，按项目名称和资料摘要生成专属的 `learning-agent/<项目 ID>/harness.yaml`、`project.json` 和 `jit_report.json`。生成失败会取消该次创建，避免出现没有 harness 的项目。已有项目不会被改写。

白板的“← 主页”会累计页面处于可见状态的学习时间。累计满 3 分钟后，首次符合条件的退出会询问是否把本次学习活动同步到 mem0。选择“本项目永远是”会立即写入，并在以后每次退出时自动写入；“永远不要”只作用于当前项目；“这次先不了，下次问我”会在下次退出时再问。同步内容包括学习时长、资料名称、白板文字与笔迹数量，不会推断掌握程度。记忆存于本机 `data/user/learning_agent_data/mem0/`，下一次创建项目时会作为 harness 生成的参考。默认用本地中文 FastEmbed 模型，首次使用会下载模型到工作区 `.cache/fastembed/`。也可在启动前配置 `EMBED_PROVIDER`、`EMBED_API_KEY`、`EMBED_BASE_URL`、`EMBED_MODEL`、`EMBED_DIMS` 来使用其他向量模型。

`启动Gigle.command` 首次运行会把 Python 依赖安装在 `personal learning agent/JIT-Harness-Edu/.venv/`。DeepSeek 密钥继续只从运行时环境或创建页输入读取，不写入项目文件。专属 harness 的生成会发送项目名称及最多 3000 字的资料摘要给已配置的对话模型；选择同步记忆后，mem0 会处理学习活动记录。
