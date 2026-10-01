import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { getDeepSeekKey } from './whiteboard/ocr-server.mjs';

const bridge = resolve(import.meta.dirname, '../personal learning agent/JIT-Harness-Edu/web_bridge.py');
const python = resolve(import.meta.dirname, '../personal learning agent/JIT-Harness-Edu/.venv/bin/python');

export function agentEnvironment() {
  const key = getDeepSeekKey() || process.env.LLM_API_KEY;
  if (!key) return null;
  return {
    ...process.env,
    LLM_API_KEY: key,
    LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1',
    JIT_MODEL: process.env.JIT_MODEL || 'deepseek-flash',
    TUTOR_MODEL: process.env.TUTOR_MODEL || 'deepseek-flash',
    MEMORY_MODEL: process.env.MEMORY_MODEL || 'deepseek-flash',
  };
}

export function learningAgent(action, atomDir, projectId, details = {}) {
  return new Promise((resolveResult, reject) => {
    const env = agentEnvironment();
    if (!env) return reject(Object.assign(new Error('请先设置 DeepSeek API 密钥，再创建项目'), { status: 503 }));
    const child = spawn(python, [bridge], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => child.kill(), 300_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timeout); reject(new Error(error.code === 'ENOENT' ? '学习 Agent 的 Python 依赖未安装，请重新运行「启动Gigle.command」' : error.message)); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code === 0) {
        try { resolveResult(JSON.parse(stdout)); } catch { reject(new Error('学习 Agent 返回了无效结果')); }
      } else {
        let message;
        try { message = JSON.parse(stdout).error; } catch { /* Python did not return structured output */ }
        reject(new Error(message || stderr.trim().split('\n').at(-1) || '学习 Agent 执行失败'));
      }
    });
    child.stdin.end(JSON.stringify({ action, atom_dir: atomDir, project_id: projectId, ...details }));
  });
}
