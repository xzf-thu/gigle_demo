#!/bin/zsh
set -e
cd "${0:A:h}"
script_dir="$PWD"
if ! command -v node >/dev/null 2>&1; then
  echo '需要先安装 Node.js（22.13 或更新版本）。'
  read '?按回车退出…'
  exit 1
fi
if [[ ! -d node_modules ]]; then npm install; fi
agent_dir="$script_dir/../personal learning agent/JIT-Harness-Edu"
agent_python="$agent_dir/.venv/bin/python"
if [[ ! -x "$agent_python" ]] || ! "$agent_python" -c 'import openai, yaml, mem0, fastembed' >/dev/null 2>&1; then
  echo '首次启动：正在本机安装学习 Agent 与 mem0 依赖…'
  export UV_CACHE_DIR="$script_dir/../.cache/uv"
  export PIP_CACHE_DIR="$script_dir/../.cache/pip"
  if command -v uv >/dev/null 2>&1; then
    uv venv --python 3.12 "$agent_dir/.venv"
    uv pip install --python "$agent_python" -r "$agent_dir/requirements.txt"
  else
    python3.12 -m venv "$agent_dir/.venv"
    "$agent_python" -m pip install -r "$agent_dir/requirements.txt"
  fi
fi
npm run build:local
if [[ -z "$DEEPSEEK_API_KEY" ]]; then
  echo '输入 DeepSeek API 密钥；直接回车后也可在创建页补录。密钥仅保存在本次本机运行的内存中。'
  read -s 'DEEPSEEK_API_KEY?API 密钥：'
  echo
  export DEEPSEEK_API_KEY
fi
node local-server.mjs --open=/main/
