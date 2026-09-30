import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, 'local-site');
const host = '127.0.0.1';
const port = Number(process.env.PORT || 4317);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.mjs': 'text/javascript; charset=utf-8' };

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function handleOcr(request, response) {
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}:${port}`) return json(response, 403, { error: 'Forbidden' });
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return json(response, 503, { error: '请在启动白板时输入 DeepSeek API 密钥' });
  let body = '';
  try {
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 12_000_000) return json(response, 413, { error: '当前视图图片过大' });
    }
    const { image } = JSON.parse(body);
    if (typeof image !== 'string' || !image.startsWith('data:image/jpeg;base64,')) return json(response, 400, { error: '无效的画布截图' });
    const result = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 1800, messages: [{ role: 'user', content: [
        { type: 'text', text: '请对图片做 OCR。只返回图片里实际可见的文字，按照阅读顺序保留换行。不要描述图片，不要猜测模糊文字。如果没有可辨认文字，只返回“未识别到文字”。' },
        { type: 'image_url', image_url: { url: image } },
      ] }] }),
    });
    if (!result.ok) return json(response, 502, { error: `识别服务暂时不可用 (${result.status})` });
    const data = await result.json();
    json(response, 200, { text: data.choices?.[0]?.message?.content?.trim() || '未识别到文字' });
  } catch { json(response, 500, { error: '识别失败，请重试' }); }
}

const server = createServer(async (request, response) => {
  if (request.url === '/api/ocr' && request.method === 'POST') return handleOcr(request, response);
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed' });
  try {
    const pathname = new URL(request.url || '/', `http://${host}`).pathname;
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = resolve(root, relative);
    if (file !== root && !file.startsWith(root + sep)) return json(response, 403, { error: 'Forbidden' });
    if (!(await stat(file)).isFile()) return json(response, 404, { error: 'Not found' });
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { json(response, 404, { error: 'Not found' }); }
});
server.listen(port, host, () => console.log(`Gigle 白板已在本机运行：http://${host}:${port}`));
