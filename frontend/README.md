# Gigle 前端

这是只在本机运行的前端项目。`main/` 是应用主页；`whiteboard/` 是独立的白板模块；`shared/` 存放可复用的界面组件。

双击 `启动Gigle.command` 打开主页。构建命令：`npm run build:local`。本机服务由 `local-server.mjs` 提供，只监听 `127.0.0.1`，不会发布到云端。资料写入 `../data/user/user_studymaterial_data/`。白板的独立启动方式见 [whiteboard/README.md](whiteboard/README.md)。
