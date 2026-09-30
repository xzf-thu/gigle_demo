'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react';
import { ArrowDownToLine, Eraser, FileText, Grip, Highlighter, ImagePlus, Maximize2, Minus, MousePointer2, PenLine, Plus, RotateCw, Ruler, ScanText, Type, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Tool = 'select' | 'pen' | 'eraser' | 'highlighter' | 'ruler';
type Point = { x: number; y: number };
type View = { x: number; y: number; z: number };
type Stroke = { id: number; kind: Tool; color: string; width: number; points: Point[] };
type Item = { id: number; kind: 'image' | 'text'; x: number; y: number; w: number; h: number; content: string };
type Page = { src: string; w: number; h: number };
const PW = 794, PH = 1123, GAP = 36;
const colors = ['#293044', '#496ed5', '#e46b72', '#3da782', '#e8ab3e'];
const tools: { id: Tool; label: string; icon: typeof MousePointer2 }[] = [
  { id: 'select', label: '选择', icon: MousePointer2 }, { id: 'pen', label: '画笔', icon: PenLine },
  { id: 'eraser', label: '橡皮', icon: Eraser }, { id: 'highlighter', label: '荧光笔', icon: Highlighter },
  { id: 'ruler', label: '直尺', icon: Ruler },
];
const limit = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));

export default function Whiteboard() {
  const wrap = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const upload = useRef<HTMLInputElement>(null), imageInput = useRef<HTMLInputElement>(null);
  const cache = useRef(new Map<string, HTMLImageElement>());
  const gesture = useRef<{ kind: 'pan' | 'draw' | 'erase'; start: Point; view: View; stroke?: Stroke } | null>(null);
  const dragTray = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const dragRuler = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const ids = useRef(0);
  const [size, setSize] = useState({ w: 1200, h: 800 });
  const [view, setView] = useState<View>({ x: -1200, y: 48, z: 1 });
  const [board, setBoard] = useState({ w: 3600, h: 2400 });
  const [tool, setTool] = useState<Tool>('select');
  const [color, setColor] = useState(colors[0]), [width, setWidth] = useState(3);
  const [strokes, setStrokes] = useState<Stroke[]>([]), [savedStrokes, setSavedStrokes] = useState<Stroke[]>([]);
  const [items, setItems] = useState<Item[]>([]), [savedItems, setSavedItems] = useState<Item[]>([]);
  const [pages, setPages] = useState<Page[]>([]), [pdfName, setPdfName] = useState('');
  const [files, setFiles] = useState<{ name: string; url: string }[]>([]);
  const [tick, setTick] = useState(0), [busyPdf, setBusyPdf] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false), [textOpen, setTextOpen] = useState(false), [textValue, setTextValue] = useState('');
  const [ocrOpen, setOcrOpen] = useState(false), [ocrBusy, setOcrBusy] = useState(false), [ocrText, setOcrText] = useState('');
  const [tray, setTray] = useState({ left: 260, top: 22 }), [ruler, setRuler] = useState({ left: 360, top: 420, angle: 0 });
  const [notice, setNotice] = useState('');
  const pdf = pages.length > 0;
  const point = (p: Point, v = view) => ({ x: (p.x - v.x) / v.z, y: (p.y - v.y) / v.z });
  const paperAt = (p: Point) => pages.some((_, i) => p.x >= 0 && p.x <= PW && p.y >= i * (PH + GAP) && p.y <= i * (PH + GAP) + PH);
  const next = () => ++ids.current;
  const getImage = (src: string) => {
    let img = cache.current.get(src);
    if (!img) { img = new Image(); img.onload = () => setTick(n => n + 1); img.src = src; cache.current.set(src, img); }
    return img;
  };

  useEffect(() => {
    if (!wrap.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width, h = entry.contentRect.height;
      setSize({ w, h }); setBoard(b => ({ w: Math.max(b.w, w * 3), h: Math.max(b.h, h * 3) }));
    });
    observer.observe(wrap.current); return () => observer.disconnect();
  }, []);

  const draw = useCallback(() => {
    const node = canvas.current; if (!node) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    node.width = Math.round(size.w * dpr); node.height = Math.round(size.h * dpr);
    node.style.width = `${size.w}px`; node.style.height = `${size.h}px`;
    const c = node.getContext('2d'); if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = pdf ? '#e9ecf2' : '#e9edf4'; c.fillRect(0, 0, size.w, size.h);
    c.translate(view.x, view.y); c.scale(view.z, view.z);
    if (pdf) pages.forEach((page, i) => {
      const y = i * (PH + GAP);
      c.save(); c.shadowColor = '#33415530'; c.shadowBlur = 28; c.shadowOffsetY = 8; c.fillStyle = 'white'; c.fillRect(0, y, PW, PH); c.restore();
      const img = getImage(page.src);
      if (img.complete && img.naturalWidth) {
        const scale = Math.min(PW / page.w, PH / page.h), w = page.w * scale, h = page.h * scale;
        c.drawImage(img, (PW - w) / 2, y + (PH - h) / 2, w, h);
      }
    });
    else {
      c.save(); c.shadowColor = '#33415520'; c.shadowBlur = 24; c.fillStyle = 'white'; c.fillRect(0, 0, board.w, board.h); c.restore();
      c.save(); c.beginPath(); c.rect(0, 0, board.w, board.h); c.clip();
      c.beginPath(); c.strokeStyle = '#e5eaf1'; c.lineWidth = 1 / view.z;
      for (let x = 0; x <= board.w; x += 32) { c.moveTo(x, 0); c.lineTo(x, board.h); }
      for (let y = 0; y <= board.h; y += 32) { c.moveTo(0, y); c.lineTo(board.w, y); }
      c.stroke(); c.restore();
    }
    const content = () => {
      items.forEach(item => {
        if (item.kind === 'image') { const img = getImage(item.content); if (img.complete && img.naturalWidth) c.drawImage(img, item.x, item.y, item.w, item.h); }
        else { c.fillStyle = '#293044'; c.font = '28px Arial, sans-serif'; item.content.split('\n').forEach((line, i) => c.fillText(line, item.x, item.y + 30 + i * 38)); }
      });
      const active = gesture.current?.kind === 'draw' && gesture.current.stroke ? [gesture.current.stroke] : [];
      [...strokes, ...active].forEach(s => {
        if (!s.points.length) return;
        c.save(); c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = s.width; c.strokeStyle = s.color; c.fillStyle = s.color;
        c.globalAlpha = s.kind === 'highlighter' ? .38 : 1;
        c.beginPath(); c.moveTo(s.points[0].x, s.points[0].y);
        if (s.points.length === 1) { c.arc(s.points[0].x, s.points[0].y, s.width / 2, 0, Math.PI * 2); c.fill(); }
        else { s.points.slice(1).forEach(p => c.lineTo(p.x, p.y)); c.stroke(); }
        c.restore();
      });
    };
    if (pdf) pages.forEach((_, i) => { c.save(); c.beginPath(); c.rect(0, i * (PH + GAP), PW, PH); c.clip(); content(); c.restore(); });
    else { c.save(); c.beginPath(); c.rect(0, 0, board.w, board.h); c.clip(); content(); c.restore(); }
  }, [size, view, board, pages, pdf, items, strokes, tick]);
  useEffect(() => { draw(); }, [draw]);

  const extend = (v: View) => { if (!pdf) setBoard(b => ({ ...b, h: Math.max(b.h, (size.h - v.y) / v.z + size.h * 2) })); };
  const zoomAt = (factor: number, at = { x: size.w / 2, y: size.h / 2 }) => {
    setView(v => { const z = limit(v.z * factor, .35, 3.5), p = point(at, v); const nv = { x: at.x - p.x * z, y: at.y - p.y * z, z }; extend(nv); return nv; });
  };
  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect(), at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * .01), at);
    else setView(v => { const nv = { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }; extend(nv); return nv; });
  };
  const erase = (p: Point) => setStrokes(all => all.filter(s => !s.points.some(q => Math.hypot(p.x - q.x, p.y - q.y) < 18 / view.z + s.width)));
  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const screen = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY }, p = point(screen);
    if (tool !== 'select' && (pdf ? !paperAt(p) : p.x < 0 || p.x > board.w || p.y < 0 || p.y > board.h)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'select') gesture.current = { kind: 'pan', start: screen, view };
    else if (tool === 'eraser') { gesture.current = { kind: 'erase', start: screen, view }; erase(p); }
    else { gesture.current = { kind: 'draw', start: screen, view, stroke: { id: next(), kind: tool, color: tool === 'highlighter' && color === colors[0] ? '#f4ce46' : color, width: tool === 'highlighter' ? 18 : tool === 'ruler' ? 2 : width, points: [p] } }; draw(); }
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current; if (!g) return;
    const screen = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    if (g.kind === 'pan') { const v = { ...g.view, x: g.view.x + screen.x - g.start.x, y: g.view.y + screen.y - g.start.y }; setView(v); extend(v); return; }
    const p = point(screen); if (g.kind === 'erase') { erase(p); return; }
    if (!g.stroke || (pdf && !paperAt(p))) return;
    if (g.stroke.kind === 'ruler') g.stroke.points = [g.stroke.points[0], p];
    else if (Math.hypot(p.x - g.stroke.points.at(-1)!.x, p.y - g.stroke.points.at(-1)!.y) > 1.5 / view.z) g.stroke.points.push(p);
    draw();
  };
  const onUp = () => { const g = gesture.current; if (g?.kind === 'draw' && g.stroke) setStrokes(all => [...all, g.stroke!]); gesture.current = null; };

  const addImage = async (file: File) => {
    const src = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
    const img = new Image(); img.src = src; await img.decode();
    const w = Math.min(360, img.naturalWidth), h = w * img.naturalHeight / img.naturalWidth;
    const center = point({ x: size.w / 2, y: size.h / 2 });
    setItems(all => [...all, { id: next(), kind: 'image', x: pdf ? limit(center.x - w / 2, 0, PW - w) : center.x - w / 2, y: pdf ? limit(center.y - h / 2, 0, PH - h) : center.y - h / 2, w, h, content: src }]);
  };
  const handleFile = async (file?: File) => {
    if (!file) return;
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      setBusyPdf(true);
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), useSystemFonts: true }).promise;
        const result: Page[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i), base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: PW / base.width }), temp = document.createElement('canvas');
          temp.width = Math.ceil(viewport.width); temp.height = Math.ceil(viewport.height);
          const context = temp.getContext('2d'); if (!context) continue;
          await page.render({ canvas: temp, canvasContext: context, viewport }).promise;
          result.push({ src: temp.toDataURL('image/png'), w: temp.width, h: temp.height });
        }
        if (!pdf) { setSavedStrokes(strokes); setSavedItems(items); }
        setPages(result); setPdfName(file.name); setStrokes([]); setItems([]); setTool('select');
        const z = Math.min(.85, (size.w - 100) / PW, (size.h - 90) / PH);
        setView({ x: (size.w - PW * z) / 2, y: 36, z });
      } catch (err) { setNotice(err instanceof Error ? `PDF 打开失败：${err.message}` : 'PDF 打开失败'); }
      setBusyPdf(false);
    } else if (file.type.startsWith('image/')) await addImage(file);
    else { setFiles(all => [...all, { name: file.name, url: URL.createObjectURL(file) }]); setNotice(`已添加文件：${file.name}`); }
  };
  const removePdf = () => { setPages([]); setPdfName(''); setStrokes(savedStrokes); setItems(savedItems); setView({ x: -size.w, y: 48, z: 1 }); setTool('select'); };
  const insertText = () => {
    if (!textValue.trim()) return;
    const center = point({ x: size.w / 2, y: size.h / 2 });
    setItems(all => [...all, { id: next(), kind: 'text', x: pdf ? limit(center.x - 130, 16, PW - 270) : center.x - 130, y: pdf ? limit(center.y, 16, PH - 70) : center.y, w: 270, h: 50, content: textValue.trim() }]);
    setTextValue(''); setTextOpen(false);
  };
  const download = () => { if (!canvas.current) return; const link = document.createElement('a'); link.href = canvas.current.toDataURL('image/png'); link.download = pdf ? `${pdfName.replace(/\.pdf$/i, '')}-批注.png` : '白板-当前视图.png'; link.click(); };
  const ocr = async () => {
    if (!canvas.current) return;
    setOcrOpen(true); setOcrBusy(true); setOcrText('');
    try {
      const response = await fetch('/api/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: canvas.current.toDataURL('image/jpeg', .85) }) });
      const data = await response.json() as { error?: string; text?: string }; if (!response.ok) throw new Error(data.error || '识别失败'); setOcrText(data.text || '未识别到文字');
    } catch (err) { setOcrText(err instanceof Error ? err.message : '识别失败'); }
    setOcrBusy(false);
  };
  const beginTray = (e: ReactPointerEvent<HTMLButtonElement>) => { dragTray.current = { x: e.clientX, y: e.clientY, left: tray.left, top: tray.top }; e.currentTarget.setPointerCapture(e.pointerId); };
  const moveTray = (e: ReactPointerEvent<HTMLButtonElement>) => { const d = dragTray.current; if (d) setTray({ left: limit(d.left + e.clientX - d.x, 8, Math.max(8, size.w - 620)), top: limit(d.top + e.clientY - d.y, 8, size.h - 80) }); };
  const beginRuler = (e: ReactPointerEvent<HTMLDivElement>) => { dragRuler.current = { x: e.clientX, y: e.clientY, left: ruler.left, top: ruler.top }; e.currentTarget.setPointerCapture(e.pointerId); };
  const moveRuler = (e: ReactPointerEvent<HTMLDivElement>) => { const d = dragRuler.current; if (d) setRuler(r => ({ ...r, left: d.left + e.clientX - d.x, top: d.top + e.clientY - d.y })); };

  useEffect(() => {
    type Context = { registerTool: (tool: { name: string; title: string; description: string; inputSchema: object; annotations: { readOnlyHint: boolean }; execute: (input: unknown) => { inserted: boolean } }, options: { signal: AbortSignal }) => void | Promise<void> };
    const context = (document as Document & { modelContext?: Context }).modelContext;
    if (!context?.registerTool) return;
    const controller = new AbortController();
    void Promise.resolve(context.registerTool({
      name: 'insert_whiteboard_text', title: '插入白板文本', description: '在当前白板或 PDF 可见区域中央插入文本。',
      inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1, maxLength: 1000 } }, required: ['text'], additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute(input) {
        const text = (input as { text?: unknown })?.text;
        if (typeof text !== 'string' || !text.trim() || text.length > 1000) throw new Error('请输入 1 到 1000 个字符');
        const center = point({ x: size.w / 2, y: size.h / 2 });
        setItems(all => [...all, { id: next(), kind: 'text', x: pdf ? limit(center.x - 130, 16, PW - 270) : center.x - 130, y: pdf ? limit(center.y, 16, PH - 70) : center.y, w: 270, h: 50, content: text.trim() }]);
        return { inserted: true };
      },
    }, { signal: controller.signal })).catch(() => {});
    return () => controller.abort();
  }, [view, size, pdf]);

  return <main className="whiteboard-app">
    <header className="topbar"><div className="brand"><span className="brand-mark"><span /></span><strong>gigle</strong><span className="brand-divider" /><span>学习白板</span></div><div className="header-actions">
      {pdfName && <div className="pdf-chip"><FileText size={16} /><span title={pdfName}>{pdfName}</span><button onClick={removePdf} title="删除 PDF，返回白板" aria-label="删除 PDF，返回白板"><X size={15} /></button></div>}
      {files.map((file, i) => <a className="file-chip" href={file.url} download={file.name} key={`${file.name}-${i}`}>{file.name}</a>)}
      <Button className="upload-button" onClick={() => upload.current?.click()}><Upload size={17} />上传</Button>
      <input className="sr-only" ref={upload} type="file" onChange={e => { void handleFile(e.target.files?.[0]); e.target.value = ''; }} aria-label="上传文件" />
    </div></header>
    <div className="canvas-area" ref={wrap} onWheel={onWheel}>
      <canvas ref={canvas} className={`drawing-canvas cursor-${tool}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-label={pdf ? 'PDF 批注画布' : '网格白板'} />
      <div className="canvas-caption"><span className="green-dot" />{pdf ? `PDF · ${pages.length} 页` : '无限白板'}<span className="caption-sep">/</span>{Math.round(view.z * 100)}%</div>
      <div className="floating-tray" style={{ left: tray.left, top: tray.top }}><button className="tray-grip" onPointerDown={beginTray} onPointerMove={moveTray} onPointerUp={() => { dragTray.current = null; }} title="拖动工具栏" aria-label="拖动工具栏"><Grip size={20} /></button><span className="tray-line" />
        {tools.map(({ id, label, icon: Icon }) => <Button key={id} variant="ghost" size="icon-lg" className={`tool-button ${tool === id ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={tool === id} onClick={() => { setTool(id); setInsertOpen(false); }}><Icon size={19} /></Button>)}
        <span className="tray-line" /><div className="insert-holder"><Button variant="ghost" size="icon-lg" className={`tool-button ${insertOpen ? 'active' : ''}`} title="插入" aria-label="插入" aria-expanded={insertOpen} onClick={() => setInsertOpen(v => !v)}><Plus size={21} /></Button>{insertOpen && <div className="insert-menu"><button onClick={() => { setTextOpen(true); setInsertOpen(false); }}><Type size={17} />文本</button><button onClick={() => { imageInput.current?.click(); setInsertOpen(false); }}><ImagePlus size={17} />图片</button><button onClick={() => { upload.current?.click(); setInsertOpen(false); }}><Upload size={17} />文件</button></div>}</div>
        <input className="sr-only" ref={imageInput} type="file" accept="image/*" onChange={e => { if (e.target.files?.[0]) void addImage(e.target.files[0]); e.target.value = ''; }} aria-label="插入图片" />
      </div>
      {tool !== 'select' && tool !== 'eraser' && <div className="style-tray"><span>颜色</span>{colors.map(c => <button key={c} className={`swatch ${color === c ? 'chosen' : ''}`} style={{ background: c }} title={c} aria-label={`选择颜色 ${c}`} onClick={() => setColor(c)} />)}<span className="style-line" /><span>粗细</span><input type="range" min="1" max="12" value={width} onChange={e => setWidth(Number(e.target.value))} aria-label="笔画粗细" /><b>{width}</b></div>}
      {tool === 'ruler' && <div className="ruler-overlay" style={{ left: ruler.left, top: ruler.top, transform: `rotate(${ruler.angle}deg)` }}><div className="ruler-body" onPointerDown={beginRuler} onPointerMove={moveRuler} onPointerUp={() => { dragRuler.current = null; }}><div className="ruler-ticks" /><span>拖动直尺 · 在纸上拖动画直线</span></div><button onClick={() => setRuler(r => ({ ...r, angle: r.angle + 15 }))} title="旋转直尺"><RotateCw size={16} /></button></div>}
      <div className="zoom-controls"><Button variant="ghost" size="icon" onClick={() => zoomAt(1 / 1.2)} aria-label="缩小"><Minus size={17} /></Button><span>{Math.round(view.z * 100)}%</span><Button variant="ghost" size="icon" onClick={() => zoomAt(1.2)} aria-label="放大"><Plus size={17} /></Button><span className="zoom-line" /><Button variant="ghost" size="icon" onClick={() => pdf ? setView({ x: (size.w - PW * .75) / 2, y: 36, z: .75 }) : setView({ x: -size.w, y: 48, z: 1 })} aria-label="重置视图"><Maximize2 size={16} /></Button></div>
      {!pdf && strokes.length === 0 && items.length === 0 && <div className="empty-hint"><div><PenLine size={22} /></div><strong>从这里开始思考</strong><span>拖动白板探索空间，或选择画笔写下第一笔</span></div>}
      {ocrOpen && <section className="ocr-panel" aria-live="polite"><div className="ocr-top"><span className="ocr-icon"><ScanText size={18} /></span><div><strong>可见内容识别</strong><small>当前屏幕的画布内容</small></div><button onClick={() => setOcrOpen(false)} aria-label="关闭识别结果"><X size={18} /></button></div><div className="ocr-body">{ocrBusy ? <span className="ocr-wait"><i />正在识别可见内容…</span> : <p>{ocrText}</p>}</div></section>}
      <div className="bottom-actions"><Button variant="outline" onClick={download}><ArrowDownToLine size={18} />下载</Button><Button className="ai-button" disabled={ocrBusy} onClick={() => void ocr()}><ScanText size={18} />AI 识别</Button></div>
      {busyPdf && <div className="loading-mask"><i />正在打开 PDF…</div>}
      {notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></button></div>}
    </div>
    {textOpen && <div className="dialog-backdrop" onClick={() => setTextOpen(false)}><div className="text-dialog" role="dialog" aria-modal="true" aria-label="插入文本" onClick={e => e.stopPropagation()}><div className="dialog-heading"><Type size={19} /><strong>插入文本</strong><button onClick={() => setTextOpen(false)} aria-label="关闭"><X size={18} /></button></div><textarea autoFocus value={textValue} onChange={e => setTextValue(e.target.value)} placeholder="输入要放在白板上的内容…" /><div className="dialog-actions"><Button variant="ghost" onClick={() => setTextOpen(false)}>取消</Button><Button onClick={insertText} disabled={!textValue.trim()}>插入</Button></div></div></div>}
  </main>;
}
