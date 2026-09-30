import { env } from 'cloudflare:workers';

export async function POST(request: Request) {
  try {
    const { image } = await request.json() as { image?: string };
    if (!image?.startsWith('data:image/jpeg;base64,') || image.length > 12_000_000) {
      return Response.json({ error: '当前视图图片无效或过大' }, { status: 400 });
    }
    const key = (env as { DEEPSEEK_API_KEY?: string }).DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY;
    if (!key) return Response.json({ error: 'AI 识别服务尚未配置' }, { status: 503 });
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        thinking: { type: 'disabled' },
        max_tokens: 1800,
        messages: [{ role: 'user', content: [
          { type: 'text', text: '请对图片做 OCR。只返回图片里实际可见的文字，按照阅读顺序保留换行。不要描述图片，不要猜测模糊文字。如果没有可辨认文字，只返回“未识别到文字”。' },
          { type: 'image_url', image_url: { url: image } },
        ] }],
      }),
    });
    if (!response.ok) return Response.json({ error: `识别服务暂时不可用 (${response.status})` }, { status: 502 });
    const result = await response.json() as { choices?: { message?: { content?: string } }[] };
    return Response.json({ text: result.choices?.[0]?.message?.content?.trim() || '未识别到文字' });
  } catch {
    return Response.json({ error: '识别失败，请重试' }, { status: 500 });
  }
}
