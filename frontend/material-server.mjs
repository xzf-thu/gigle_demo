import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { getDeepSeekKey } from './whiteboard/ocr-server.mjs';
import { learningAgent } from './learning-agent.mjs';

const root = resolve(process.env.GIGLE_STUDY_DATA_DIR || resolve(import.meta.dirname, '../data/user/user_studymaterial_data'));
const formats = new Set(['blank', 'slide', 'report', 'pdf']);
const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8' };
const reply = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const safeId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const clean = value => String(value || '').trim().slice(0, 160);
const directoryName = (kind, title, id) => `${kind}-${clean(title).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+$/, '_').slice(0, 60) || '未命名'}-${id}`;
const readBody = async req => {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 40_000_000) throw new Error('资料超过 40 MB'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};
const metadata = async dir => JSON.parse(await readFile(join(dir, 'atom.json'), 'utf8'));
async function tree(dir = root, parent = null, output = []) {
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name.startsWith('folder-')) {
      try { const item = JSON.parse(await readFile(join(path, 'folder.json'), 'utf8')); output.push({ ...item, type: 'folder', name: item.name, date: item.updatedAt, fav: !!item.favorite, parent }); await tree(path, item.id, output); } catch { /* ignore incomplete folder */ }
    } else if (entry.name.startsWith('atom-')) {
      try { const atom = await metadata(path); output.push({ id: atom.id, type: 'doc', name: atom.title, format: atom.format, date: atom.updatedAt, parent, pages: atom.pages || 1, fav: !!atom.favorite, preview: atom.preview, firstImage: atom.firstImage }); } catch { /* ignore incomplete atom */ }
    }
  }
  return output;
}
async function locate(id, kind, dir = root) {
  if (!safeId(id)) return null;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    if (entry.name.startsWith(`${kind}-`) && entry.name.endsWith(`-${id}`)) return path;
    if (entry.name.startsWith('folder-')) { const found = await locate(id, kind, path); if (found) return found; }
  }
  return null;
}
export const locateAtomDir = id => locate(id, 'atom');
function extractJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 返回内容无法解析，请重试');
  return JSON.parse(text.slice(start, end + 1));
}
async function generate(format, title, sources) {
  const key = getDeepSeekKey();
  if (!key) throw Object.assign(new Error('请输入 DeepSeek API 密钥'), { status: 503 });
  const details = sources.map((s, i) => `${i + 1}. ${s.kind}: ${s.text || s.url || s.name || ''}`).join('\n').slice(0, 24000);
  const prompt = `你是学习资料编辑。请用简体中文生成${format === 'slide' ? '演示文稿' : '介绍/报告'}，标题为「${title}」。根据来源生成准确、可读、适合白板展示的内容。网页搜索和网址没有实际联网读取，只能基于已有知识和用户提供的文字做概述；不确定的事实要明确标注“待核实”，不要捏造引用。只返回 JSON：{"title":"...","sections":[{"heading":"...","body":"..."}]}。Slide 输出 4-7 个简短 section；Report 输出 3-6 个较详细 section。\n来源：\n${details}`;
  const images = sources.filter(source => source.kind === 'image' && typeof source.data === 'string' && source.data.startsWith('data:image/')).slice(0, 3).map(source => ({ type: 'image_url', image_url: { url: source.data } }));
  const content = images.length ? [{ type: 'text', text: prompt }, ...images] : prompt;
  const response = await fetch('https://api.deepseek.com/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-flash', thinking: { type: 'disabled' }, max_tokens: 2600, messages: [{ role: 'user', content }] }), signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw Object.assign(new Error(response.status === 401 ? 'DeepSeek API 密钥无效' : response.status === 402 ? 'DeepSeek 账户余额不足' : `DeepSeek 生成失败 (${response.status})`), { status: response.status === 401 ? 401 : 502 });
  const result = await response.json();
  const answer = result.choices?.[0]?.message?.content;
  if (!answer) throw new Error('AI 未返回内容');
  const generated = extractJson(answer);
  if (!Array.isArray(generated.sections) || !generated.sections.length) throw new Error('AI 返回内容为空');
  return { title: clean(generated.title) || title, sections: generated.sections.slice(0, 12).map(section => ({ heading: clean(section.heading), body: String(section.body || '').slice(0, 3000) })) };
}
function makeBoard(format, title, generated, image) {
  const items = [];
  if (format !== 'blank') {
    items.push({ id: 1, kind: 'text', x: 1250, y: 110, w: 850, h: 110, content: title, fontSize: 48, weight: 'bold', color: '#293044' });
    let y = 250, id = 2;
    if (image) { items.push({ id: id++, kind: 'image', x: 1250, y, w: 760, h: 400, content: image }); y += 440; }
    for (const section of generated?.sections || []) {
      items.push({ id: id++, kind: 'text', x: 1250, y, w: 800, h: 55, content: section.heading, fontSize: 32, weight: 'bold', color: '#293044' });
      y += 62;
      items.push({ id: id++, kind: 'text', x: 1250, y, w: 850, h: format === 'slide' ? 120 : 180, content: section.body, fontSize: 23, color: '#344256' });
      y += format === 'slide' ? 170 : 230;
    }
  }
  return { width: 3600, height: Math.max(2400, (items.at(-1)?.y || 0) + 450), background: 'grid', items, strokes: [], view: { x: 0, y: 30, z: 1 } };
}
async function saveAtom(dir, atom) { atom.updatedAt = new Date().toISOString(); await writeFile(join(dir, 'atom.json'), JSON.stringify(atom, null, 2)); }
function learningExperience(atom, sessionMs) {
  const seconds = Math.round(sessionMs / 1000);
  const texts = (atom.board?.items || []).filter(item => item.kind === 'text' && typeof item.content === 'string').map(item => item.content.trim()).filter(Boolean).join('；').slice(0, 5000);
  const sourceNames = (atom.sources || []).map(source => source.name || source.url).filter(Boolean).join('、').slice(0, 1500);
  return `项目「${atom.title}」学习 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒。使用的资料：${sourceNames || '无'}。白板上记录的文字：${texts || '无'}。笔迹数：${atom.board?.strokes?.length || 0}。这是学习活动记录，不代表已经掌握这些内容。`;
}
function assetName(name, index) {
  const ext = basename(name || '').split('.').at(-1)?.toLowerCase();
  return `source-${index}.${types[ext] ? ext : 'bin'}`;
}
async function downloadPdf(url) {
  const address = new URL(url);
  if (!['https:', 'http:'].includes(address.protocol) || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(address.hostname)) throw new Error('请使用公开的 PDF 链接，或上传 PDF 文件');
  const response = await fetch(address, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`PDF 链接无法读取 (${response.status})，请上传文件`);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) { length += chunk.length; if (length > 25_000_000) throw new Error('PDF 超过 25 MB，请上传较小文件'); chunks.push(chunk); }
  const data = Buffer.concat(chunks);
  if (data.subarray(0, 5).toString() !== '%PDF-') throw new Error('链接返回的不是 PDF，请上传文件');
  return data;
}

export async function handleMaterialApi(req, res, port) {
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}`) return reply(res, 403, { error: 'Forbidden' });
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.pathname === '/api/library' && req.method === 'GET') return reply(res, 200, { items: await tree() });
    if (url.pathname === '/api/folders' && req.method === 'POST') {
      const body = await readBody(req); const name = clean(body.name);
      if (!name) return reply(res, 400, { error: '请输入文件夹名称' });
      const parentDir = body.parent ? await locate(body.parent, 'folder') : root;
      if (!parentDir) return reply(res, 404, { error: '目标文件夹不存在' });
      const id = randomUUID(), dir = join(parentDir, directoryName('folder', name, id)); await mkdir(dir, { recursive: true });
      const folder = { schemaVersion: 1, id, type: 'folder', name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await writeFile(join(dir, 'folder.json'), JSON.stringify(folder, null, 2)); return reply(res, 201, { folder });
    }
    if (url.pathname === '/api/atoms' && req.method === 'POST') {
      const body = await readBody(req); const format = body.format, sources = Array.isArray(body.sources) ? body.sources.slice(0, 20) : [];
      if (!formats.has(format) || (format !== 'blank' && !sources.length) || (format === 'blank' && sources.length)) return reply(res, 400, { error: '创建参数无效' });
      const parentDir = body.parent ? await locate(body.parent, 'folder') : root;
      if (!parentDir) return reply(res, 404, { error: '目标文件夹不存在' });
      const inputTitle = clean(body.title) || (format === 'blank' ? '空白板' : clean(sources[0]?.name) || '未命名项目');
      const generated = format === 'slide' || format === 'report' ? await generate(format, inputTitle, sources) : null;
      const downloadedPdfs = await Promise.all(sources.map(source => source.kind === 'pdf' && source.url && !source.data ? downloadPdf(source.url) : null));
      const id = randomUUID(), dir = join(parentDir, directoryName('atom', generated?.title || inputTitle, id)), assets = join(dir, 'assets');
      await mkdir(assets, { recursive: true });
      const savedSources = [], pdfBuffers = []; let firstImage = null, pdfAsset = null, pdfPages = 1;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i], entry = { kind: clean(source.kind), name: clean(source.name), url: clean(source.url), text: String(source.text || '').slice(0, 30000) };
        if (typeof source.data === 'string' && /^data:[^;]+;base64,/.test(source.data)) {
          const data = Buffer.from(source.data.split(',')[1], 'base64');
          const file = assetName(source.name, i); await writeFile(join(assets, file), data); entry.asset = `assets/${file}`;
          if (!firstImage && source.kind === 'image') firstImage = `/api/atoms/${id}/asset/${file}`;
          if (source.kind === 'pdf') { pdfBuffers.push(data); if (!pdfAsset) pdfAsset = `/api/atoms/${id}/asset/${file}`; }
        }
        else if (source.kind === 'pdf' && source.url) {
          const file = `source-${i}.pdf`, data = downloadedPdfs[i]; await writeFile(join(assets, file), data);
          entry.asset = `assets/${file}`; pdfBuffers.push(data); if (!pdfAsset) pdfAsset = `/api/atoms/${id}/asset/${file}`;
        }
        savedSources.push(entry);
      }
      if (pdfBuffers.length) {
        try {
          const { PDFDocument } = await import('pdf-lib');
          if (pdfBuffers.length === 1) pdfPages = (await PDFDocument.load(pdfBuffers[0])).getPageCount();
          else {
            const combined = await PDFDocument.create();
            for (const bytes of pdfBuffers) { const source = await PDFDocument.load(bytes); const pages = await combined.copyPages(source, source.getPageIndices()); pages.forEach(page => combined.addPage(page)); }
            pdfPages = combined.getPageCount(); await writeFile(join(assets, 'combined.pdf'), await combined.save()); pdfAsset = `/api/atoms/${id}/asset/combined.pdf`;
          }
        } catch { /* original PDFs stay available when merging is unsupported */ }
      }
      const now = new Date().toISOString();
      const atom = { schemaVersion: 1, id, title: generated?.title || inputTitle, format, createdAt: now, updatedAt: now, favorite: false, pages: format === 'pdf' ? pdfPages : 1, sources: savedSources, board: makeBoard(format, generated?.title || inputTitle, generated, firstImage), preview: { title: generated?.title || inputTitle, excerpt: generated?.sections?.[0]?.body || '', image: firstImage }, firstImage, pdfAsset, generation: generated ? { provider: 'deepseek', provisionalWebResearch: sources.some(s => ['websearch', 'web', 'video'].includes(s.kind)) } : null, studyTimeMs: 0, memoryPreference: 'ask' };
      try {
        const materials = savedSources.map(source => `${source.kind}: ${source.text || source.url || source.name}`).join('\n').slice(0, 3000);
        await learningAgent('create', dir, id, { title: atom.title, subject: atom.title, goal: `学习并理解「${atom.title}」`, materials });
        atom.learningAgent = { projectId: id, harness: `learning-agent/${id}/harness.yaml` };
        await saveAtom(dir, atom); return reply(res, 201, { atom });
      } catch (error) { await rm(dir, { recursive: true, force: true }); throw error; }
    }
    if (parts[0] === 'api' && parts[1] === 'atoms' && safeId(parts[2])) {
      const dir = await locate(parts[2], 'atom'); if (!dir) return reply(res, 404, { error: '原子不存在' });
      if (parts[3] === 'asset' && parts.length === 5 && req.method === 'GET') {
        const filename = parts[4]; if (!/^(source-\d+\.[a-z0-9]+|combined\.pdf)$/.test(filename)) return reply(res, 400, { error: '资源名称无效' });
        const bytes = await readFile(join(dir, 'assets', filename)); const ext = filename.split('.').at(-1); res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' }); return res.end(bytes);
      }
      if (parts[3] === 'preview' && parts.length === 4 && req.method === 'GET') { const bytes = await readFile(join(dir, 'preview.png')); res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); return res.end(bytes); }
      if (parts[3] === 'exit' && parts.length === 4 && req.method === 'POST') {
        const body = await readBody(req), atom = await metadata(dir);
        const duration = Number(body.studyMs);
        if (!Number.isFinite(duration) || duration < 0 || duration > 86_400_000 || !safeId(body.exitId)) return reply(res, 400, { error: '学习时长无效' });
        if (atom.lastExitId !== body.exitId) {
          atom.studyTimeMs = (Number(atom.studyTimeMs) || 0) + Math.round(duration);
          atom.lastExitId = body.exitId;
          await saveAtom(dir, atom);
        }
        const preference = atom.memoryPreference || 'ask';
        const shouldPrompt = preference === 'ask' && atom.studyTimeMs >= 180_000;
        if (preference === 'always' && atom.lastMemoryExitId !== body.exitId) {
          await learningAgent('remember', dir, atom.id, { experience: learningExperience(atom, duration), study_seconds: Math.round(duration / 1000) });
          atom.lastMemoryExitId = body.exitId;
          await saveAtom(dir, atom);
        }
        return reply(res, 200, { shouldPrompt });
      }
      if (parts[3] === 'memory' && parts.length === 4 && req.method === 'POST') {
        const body = await readBody(req), atom = await metadata(dir);
        if (!['always', 'never', 'later'].includes(body.choice)) return reply(res, 400, { error: '记忆选择无效' });
        if ((atom.memoryPreference || 'ask') !== 'ask') return reply(res, 409, { error: '本项目已经设定记忆偏好' });
        if (body.choice === 'always') {
          if ((Number(atom.studyTimeMs) || 0) < 180_000) return reply(res, 400, { error: '学习满 3 分钟后才能同步记忆' });
          await learningAgent('remember', dir, atom.id, { experience: learningExperience(atom, atom.studyTimeMs), study_seconds: Math.round(atom.studyTimeMs / 1000) });
          atom.memoryPreference = 'always'; atom.lastMemoryExitId = atom.lastExitId;
        } else if (body.choice === 'never') atom.memoryPreference = 'never';
        await saveAtom(dir, atom);
        return reply(res, 200, { preference: atom.memoryPreference });
      }
      if (parts.length === 3 && req.method === 'GET') return reply(res, 200, { atom: await metadata(dir) });
      if (parts.length === 3 && req.method === 'PATCH') {
        const body = await readBody(req), atom = await metadata(dir);
        if (typeof body.favorite === 'boolean') atom.favorite = body.favorite;
        if (body.board && typeof body.board === 'object') { atom.board = { ...atom.board, ...body.board }; const first = atom.board.items?.find(item => item.kind === 'image'); if (first?.content) atom.firstImage = first.content; atom.preview = { title: atom.title, excerpt: atom.board.items?.find(item => item.kind === 'text' && item.content !== atom.title)?.content || '', image: atom.firstImage || atom.preview?.image || null }; }
        if (typeof body.title === 'string' && clean(body.title)) atom.title = clean(body.title);
        if (typeof body.previewData === 'string' && body.previewData.startsWith('data:image/png;base64,')) {
          await writeFile(join(dir, 'preview.png'), Buffer.from(body.previewData.split(',')[1], 'base64'));
          if (!atom.firstImage) atom.preview.image = `/api/atoms/${atom.id}/preview?v=${Date.now()}`;
        }
        await saveAtom(dir, atom); return reply(res, 200, { atom });
      }
      if (parts.length === 3 && req.method === 'DELETE') { await rm(dir, { recursive: true, force: true }); return reply(res, 200, { deleted: true }); }
    }
    if (parts[0] === 'api' && parts[1] === 'folders' && safeId(parts[2]) && parts.length === 3 && req.method === 'DELETE') {
      const dir = await locate(parts[2], 'folder'); if (!dir) return reply(res, 404, { error: '文件夹不存在' });
      await rm(dir, { recursive: true, force: true }); return reply(res, 200, { deleted: true });
    }
    if (parts[0] === 'api' && parts[1] === 'folders' && safeId(parts[2]) && parts.length === 3 && req.method === 'PATCH') {
      const dir = await locate(parts[2], 'folder'); if (!dir) return reply(res, 404, { error: '文件夹不存在' });
      const body = await readBody(req), folder = JSON.parse(await readFile(join(dir, 'folder.json'), 'utf8'));
      if (typeof body.favorite === 'boolean') folder.favorite = body.favorite;
      folder.updatedAt = new Date().toISOString(); await writeFile(join(dir, 'folder.json'), JSON.stringify(folder, null, 2)); return reply(res, 200, { folder });
    }
    return reply(res, 404, { error: 'Not found' });
  } catch (error) { return reply(res, error?.status || 500, { error: error?.message || '本机服务出错' }); }
}
