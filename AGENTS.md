# Gigle project instructions

This project is local-only at the user's request. Keep all source and build output in this workspace. Do not create, update, push, or deploy a cloud Site or other hosted copy unless the user explicitly changes this preference.

The whiteboard feature, including its browser UI, OCR handler, PDF export, and standalone launcher, lives in `frontend/whiteboard/`. `frontend/main/` is the app homepage. Shared UI primitives live in `frontend/shared/`; root files provide local build and loopback serving. Build with `npm run build:local`. The user launches the full app with `frontend/启动Gigle.command`. Study materials live in `data/user/user_studymaterial_data/`, mirroring the homepage folder hierarchy; each atom is one folder with `atom.json`, assets, and a preview image.

Never commit or embed API keys. The local launcher reads `DEEPSEEK_API_KEY` at runtime without saving it. AI OCR sends the current canvas image to DeepSeek only when the user clicks AI 识别.
