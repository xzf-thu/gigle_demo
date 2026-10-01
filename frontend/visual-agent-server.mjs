import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { agentEnvironment, learningAgent } from './learning-agent.mjs';
import { locateAtomDir } from './material-server.mjs';

const script = resolve(import.meta.dirname, '../personal learning agent/visual agent/visual_agent.py');
const python = resolve(import.meta.dirname, '../personal learning agent/JIT-Harness-Edu/.venv/bin/python');
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

async function readBody(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 12_000_000) throw Object.assign(new Error('当前视图图片过大'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function runVisualAgentStream(env, payload, response) {
  return new Promise(resolveResult => {
    const child = spawn(python, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '', producedOutput = false, finished = false, timedOut = false;
    const sendError = message => {
      if (!response.writableEnded) response.write(`${JSON.stringify({ error: message })}\n`);
    };
    const timeout = setTimeout(() => { timedOut = true; child.kill(); }, 150_000);
    response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.on('close', () => { if (!finished) child.kill(); });
    child.stdout.on('data', chunk => { producedOutput = true; if (!response.writableEnded) response.write(chunk); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      sendError(error.code === 'ENOENT' ? '学习 Agent 依赖未安装，请重新运行启动器' : error.message);
      producedOutput = true;
    });
    child.on('close', code => {
      clearTimeout(timeout);
      finished = true;
      if (code !== 0 && !producedOutput) sendError(timedOut ? 'gigle 回答超时，请重试' : stderr.trim().split('\n').at(-1) || 'gigle 暂时无法回答');
      if (!response.writableEnded) response.end();
      resolveResult();
    });
    child.stdin.end(JSON.stringify({ ...payload, stream: true }));
  });
}

export async function handleVisualAgentApi(request, response, port) {
  const origin = request.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}`) return json(response, 403, { error: 'Forbidden' });
  if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' });
  try {
    const body = await readBody(request);
    const atomId = body.atomId;
    if (typeof atomId !== 'string' || !/^[a-f0-9-]{36}$/.test(atomId)) return json(response, 400, { error: '请先打开一个项目' });
    if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 2000) return json(response, 400, { error: '请输入不超过 2000 字的问题' });
    if (typeof body.image !== 'string' || !/^data:image\/(jpeg|png);base64,/.test(body.image)) return json(response, 400, { error: '当前画布截图无效' });
    const env = agentEnvironment();
    if (!env) return json(response, 503, { error: '请输入 DeepSeek API 密钥以启用 AI 辅助' });
    const dir = await locateAtomDir(atomId);
    if (!dir) return json(response, 404, { error: '项目不存在' });
    const atom = JSON.parse(await readFile(join(dir, 'atom.json'), 'utf8'));
    const harness = join(dir, 'learning-agent', atomId, 'harness.yaml');
    try { await access(harness); }
    catch {
      const materials = (atom.sources || []).map(source => `${source.kind}: ${source.text || source.url || source.name}`).join('\n').slice(0, 3000);
      await learningAgent('create', dir, atomId, { title: atom.title, subject: atom.title,
        goal: `学习并理解「${atom.title}」`, materials });
    }
    await runVisualAgentStream(env, { atom_dir: dir, atom_id: atomId,
      question: body.question.trim(), image: body.image,
      context: body.context && typeof body.context === 'object' ? body.context : {},
      history: Array.isArray(body.history) ? body.history.slice(-8) : [] }, response);
    return;
  } catch (error) {
    if (response.headersSent) { response.end(); return; }
    const message = error?.message || 'gigle 暂时无法回答';
    return json(response, error?.status || (/\b401\b/.test(message) ? 401 : /\b402\b/.test(message) ? 402 : 502), { error: message });
  }
}
