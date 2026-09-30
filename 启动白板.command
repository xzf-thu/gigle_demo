#!/bin/zsh
set -e
cd "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  echo '需要先安装 Node.js（22.13 或更新版本）。'
  read '?按回车退出…'
  exit 1
fi
if [[ ! -d node_modules ]]; then npm install; fi
npm run build:local
if [[ -z "$DEEPSEEK_API_KEY" ]]; then
  echo 'AI 识别需要 DeepSeek API 密钥；直接回车可跳过。输入不会显示或保存。'
  read -s 'DEEPSEEK_API_KEY?API 密钥：'
  echo
  export DEEPSEEK_API_KEY
fi
node local-server.mjs &
server_pid=$!
sleep 1
open 'http://127.0.0.1:4317'
wait $server_pid
