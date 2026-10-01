import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { handleWhiteboardApi } from './whiteboard/ocr-server.mjs';
import { handleMaterialApi } from './material-server.mjs';
import { handleVisualAgentApi } from './visual-agent-server.mjs';

const root = resolve(import.meta.dirname, 'local-site');
const host = '127.0.0.1';
let port = Number(process.env.PORT || 4317);
const firstPort = port;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.mjs': 'text/javascript; charset=utf-8' };

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

const server = createServer(async (request, response) => {
  if (request.url?.startsWith('/api/ocr')) return handleWhiteboardApi(request, response, port);
  if (request.url?.startsWith('/api/visual-agent')) return handleVisualAgentApi(request, response, port);
  if (request.url?.startsWith('/api/library') || request.url?.startsWith('/api/atoms') || request.url?.startsWith('/api/folders')) return handleMaterialApi(request, response, port);
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed' });
  try {
    const pathname = new URL(request.url || '/', `http://${host}`).pathname;
    const relative = decodeURIComponent((pathname === '/' ? '/index.html' : pathname.endsWith('/') ? `${pathname}index.html` : pathname).slice(1));
    const file = resolve(root, relative);
    if (file !== root && !file.startsWith(root + sep)) return json(response, 403, { error: 'Forbidden' });
    if (!(await stat(file)).isFile()) return json(response, 404, { error: 'Not found' });
    const content = await readFile(file);
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { json(response, 404, { error: 'Not found' }); }
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE' && port < firstPort + 20) { port += 1; server.listen(port, host); }
  else { console.error(`本机白板启动失败：${error.message}`); process.exitCode = 1; }
});
server.on('listening', () => {
  const baseUrl = `http://${host}:${port}`;
  const requestedPath = process.argv.find(argument => argument.startsWith('--open='))?.slice('--open='.length);
  console.log(`Gigle 本机服务已启动：${baseUrl}`);
  if (requestedPath?.startsWith('/') && process.platform === 'darwin') execFile('open', [`${baseUrl}${requestedPath}`], error => { if (error) console.error(`浏览器打开失败：${error.message}`); });
});
server.listen(port, host);
