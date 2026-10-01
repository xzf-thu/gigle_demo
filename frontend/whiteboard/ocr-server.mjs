let apiKey = process.env.DEEPSEEK_API_KEY || '';
export const getDeepSeekKey = () => apiKey;

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request, maxLength) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxLength) throw new Error('请求内容过大');
  }
  return JSON.parse(body);
}

export async function handleWhiteboardApi(request, response, port) {
  const origin = request.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}`) return json(response, 403, { error: 'Forbidden' });
  if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' });

  if (request.url === '/api/ocr/key') {
    try {
      const { key } = await readJson(request, 1024);
      if (typeof key !== 'string' || key.trim().length < 16 || key.length > 512) return json(response, 400, { error: 'API 密钥格式无效' });
      apiKey = key.trim();
      return json(response, 200, { configured: true });
    } catch { return json(response, 400, { error: '无法读取 API 密钥' }); }
  }

  if (request.url !== '/api/ocr') return json(response, 404, { error: 'Not found' });
  if (!apiKey) return json(response, 503, { error: '请输入 DeepSeek API 密钥以启用识别' });
  try {
    const { image } = await readJson(request, 12_000_000);
    if (typeof image !== 'string' || !image.startsWith('data:image/jpeg;base64,')) return json(response, 400, { error: '无效的画布截图' });
    const result = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 1800, messages: [{ role: 'user', content: [
        { type: 'text', text: '请对图片做 OCR。只返回图片里实际可见的文字，按照阅读顺序保留换行。不要描述图片，不要猜测模糊文字。如果没有可辨认文字，只返回“未识别到文字”。' },
        { type: 'image_url', image_url: { url: image } },
      ] }] }),
      signal: AbortSignal.timeout(90_000),
    });
    if (result.status === 401) return json(response, 401, { error: 'DeepSeek API 密钥无效，请重新输入' });
    if (result.status === 402) return json(response, 402, { error: 'DeepSeek 账户余额不足' });
    if (!result.ok) return json(response, 502, { error: `DeepSeek 服务暂时不可用 (${result.status})` });
    const data = await result.json();
    return json(response, 200, { text: data.choices?.[0]?.message?.content?.trim() || '未识别到文字' });
  } catch (error) {
    return json(response, 502, { error: error?.message === '请求内容过大' ? '当前视图图片过大' : '无法连接 DeepSeek，请检查网络后重试' });
  }
}
