'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ArrowDownToLine, Eraser, FileText, Grip, Highlighter, ImagePlus, Maximize2, Minus, MousePointer2, PenLine, Plus, RotateCw, Ruler, ScanText, Type, Upload, X } from 'lucide-react';
import { Button } from './Button';

type Tool = 'select' | 'pen' | 'eraser' | 'highlighter' | 'ruler';
type Point = { x: number; y: number };
type View = { x: number; y: number; z: number };
type Stroke = { id: number; kind: Tool; color: string; width: number; points: Point[] };
type Item = { id: number; kind: 'image' | 'text'; x: number; y: number; w: number; h: number; content: string; fontSize?: number; weight?: string; color?: string };
type Page = { src: string; w: number; h: number };
type AgentFrame = { delta?: string; done?: boolean; error?: string };
const PW = 794, PH = 1123, GAP = 36;
const colors = ['#293044', '#496ed5', '#e46b72', '#3da782', '#e8ab3e'];
const tools: { id: Tool; label: string; icon: typeof MousePointer2 }[] = [
  { id: 'select', label: '选择', icon: MousePointer2 }, { id: 'pen', label: '画笔', icon: PenLine },
  { id: 'eraser', label: '橡皮', icon: Eraser }, { id: 'highlighter', label: '荧光笔', icon: Highlighter },
  { id: 'ruler', label: '直尺', icon: Ruler },
];
const limit = (n: number, a: number, b: number) => Math.min(b, Math.max(a, n));
const distanceToSegment = (point: Point, start: Point, end: Point) => {
  const dx = end.x - start.x, dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? limit(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1) : 0;
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
};
const pdfHeight = (count: number) => count * PH + Math.max(0, count - 1) * GAP;
const initialPdfView = (size: { w: number; h: number }): View => {
  const z = limit(size.w * .6 / PW, .2, 3.5);
  return { x: (size.w - PW * z) / 2, y: size.h * .15, z };
};
const constrainPdfView = (view: View, size: { w: number; h: number }, count: number): View => {
  if (!count) return view;
  const pageWidth = PW * view.z;
  const totalHeight = pdfHeight(count) * view.z;
  const minY = size.h * .85 - totalHeight;
  const maxY = size.h * .15;
  return {
    ...view,
    // Keep part of the paper visible while allowing horizontal movement at every zoom level.
    x: limit(view.x, size.w * .15 - pageWidth, size.w * .85),
    y: limit(view.y, Math.min(minY, maxY), Math.max(minY, maxY)),
  };
};

async function readAgentStream(response: Response, onDelta: (delta: string) => void) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('浏览器无法读取流式回复');
  const decoder = new TextDecoder();
  let buffer = '', done = false;
  const consume = (line: string) => {
    if (!line.trim()) return;
    const frame = JSON.parse(line) as AgentFrame;
    if (frame.error) throw new Error(frame.error);
    if (frame.delta) onDelta(frame.delta);
    if (frame.done) done = true;
  };
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    buffer += decoder.decode(result.value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      consume(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
    }
  }
  buffer += decoder.decode();
  consume(buffer);
  if (!done) throw new Error('回复中断，请重试');
}

export default function Whiteboard() {
  const atomId = new URLSearchParams(location.search).get('atom');
  const loadedAtom = useRef(false), saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const studyClock = useRef({ started: 0, elapsed: 0 });
  const exitAttempt = useRef<{ id: string; duration: number } | null>(null);
  const wrap = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const assistScroll = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null), imageInput = useRef<HTMLInputElement>(null);
  const cache = useRef(new Map<string, HTMLImageElement>());
  const pdfSource = useRef<Uint8Array | null>(null);
  const gesture = useRef<{ kind: 'pan' | 'draw' | 'erase' | 'move-image'; start: Point; view: View; stroke?: Stroke; itemId?: number; itemStart?: Point } | null>(null);
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
  const [selectedImageId, setSelectedImageId] = useState<number | null>(null);
  const [pages, setPages] = useState<Page[]>([]), [pdfName, setPdfName] = useState('');
  const [files, setFiles] = useState<{ name: string; url: string }[]>([]);
  const [tick, setTick] = useState(0), [busyPdf, setBusyPdf] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false), [textOpen, setTextOpen] = useState(false), [textValue, setTextValue] = useState('');
  const [ocrOpen, setOcrOpen] = useState(false), [ocrBusy, setOcrBusy] = useState(false), [ocrText, setOcrText] = useState('');
  const [assistOpen, setAssistOpen] = useState(false), [assistBusy, setAssistBusy] = useState(false);
  const [assistQuestion, setAssistQuestion] = useState(''), [assistError, setAssistError] = useState('');
  const [assistNeedsKey, setAssistNeedsKey] = useState(false);
  const [assistMessages, setAssistMessages] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [needsKey, setNeedsKey] = useState(false), [keyValue, setKeyValue] = useState(''), [keyBusy, setKeyBusy] = useState(false);
  const [tray, setTray] = useState({ left: 260, top: 22 }), [ruler, setRuler] = useState({ left: 360, top: 420, angle: 0 });
  const [notice, setNotice] = useState('');
  const [memoryOpen, setMemoryOpen] = useState(false), [exitBusy, setExitBusy] = useState(false);
  const [atomTitle, setAtomTitle] = useState('');
  const [exportOpen, setExportOpen] = useState(false), [exportBusy, setExportBusy] = useState(false);
  const [exportMode, setExportMode] = useState<'all' | 'current' | 'custom'>('all');
  const [rangeFrom, setRangeFrom] = useState(1), [rangeTo, setRangeTo] = useState(1);
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
  useEffect(() => { if (pdf) setView(v => constrainPdfView(v, size, pages.length)); }, [size, pages.length, pdf]);
  useEffect(() => { if (assistScroll.current) assistScroll.current.scrollTop = assistScroll.current.scrollHeight; }, [assistMessages, assistBusy]);
  useEffect(() => {
    const clock = studyClock.current;
    const update = () => {
      if (document.visibilityState === 'visible') clock.started = performance.now();
      else if (clock.started) { clock.elapsed += performance.now() - clock.started; clock.started = 0; }
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => { document.removeEventListener('visibilitychange', update); if (clock.started) { clock.elapsed += performance.now() - clock.started; clock.started = 0; } };
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
        else {
          const fontSize = item.fontSize || 28, lineHeight = fontSize * 1.4;
          c.fillStyle = item.color || '#293044'; c.font = `${item.weight === 'bold' ? '700 ' : ''}${fontSize}px Arial, sans-serif`;
          let y = item.y + fontSize;
          for (const paragraph of item.content.split('\n')) {
            let line = '';
            for (const character of paragraph) {
              if (c.measureText(line + character).width > item.w && line) { c.fillText(line, item.x, y); y += lineHeight; line = character; }
              else line += character;
            }
            c.fillText(line, item.x, y); y += lineHeight;
          }
        }
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
      const selected = items.find(item => item.id === selectedImageId && item.kind === 'image');
      if (selected && tool === 'select') {
        c.save(); c.strokeStyle = '#4966d2'; c.lineWidth = 2 / view.z;
        c.setLineDash([7 / view.z, 5 / view.z]);
        c.strokeRect(selected.x, selected.y, selected.w, selected.h); c.restore();
      }
    };
    if (pdf) pages.forEach((_, i) => { c.save(); c.beginPath(); c.rect(0, i * (PH + GAP), PW, PH); c.clip(); content(); c.restore(); });
    else { c.save(); c.beginPath(); c.rect(0, 0, board.w, board.h); c.clip(); content(); c.restore(); }
  }, [size, view, board, pages, pdf, items, strokes, tick, selectedImageId, tool]);
  useEffect(() => { draw(); }, [draw]);

  const extend = (v: View) => { if (!pdf) setBoard(b => ({ ...b, h: Math.max(b.h, (size.h - v.y) / v.z + size.h * 2) })); };
  const zoomAt = (factor: number, at = { x: size.w / 2, y: size.h / 2 }) => {
    setView(v => { const z = limit(v.z * factor, .2, 3.5), p = point(at, v); const nv = { x: at.x - p.x * z, y: at.y - p.y * z, z }; if (pdf) return constrainPdfView(nv, size, pages.length); extend(nv); return nv; });
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = wrap.current!.getBoundingClientRect(), at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * .01), at);
    else setView(v => {
      const sideways = e.shiftKey && !e.deltaX;
      const nv = { ...v, x: v.x - (sideways ? e.deltaY : e.deltaX), y: v.y - (sideways ? 0 : e.deltaY) };
      if (pdf) return constrainPdfView(nv, size, pages.length);
      extend(nv); return nv;
    });
  };
  useEffect(() => {
    const area = wrap.current;
    if (!area) return;
    let lastScale = 1;
    let gesturing = false;
    type GestureEventWithScale = Event & { scale: number; clientX: number; clientY: number };
    const start = (event: Event) => { event.preventDefault(); lastScale = 1; gesturing = true; };
    const change = (event: Event) => {
      event.preventDefault();
      const gestureEvent = event as GestureEventWithScale;
      const rect = area.getBoundingClientRect();
      zoomAt(gestureEvent.scale / lastScale, { x: gestureEvent.clientX - rect.left, y: gestureEvent.clientY - rect.top });
      lastScale = gestureEvent.scale;
    };
    const end = () => { gesturing = false; };
    const wheel = (event: WheelEvent) => { if (!gesturing) onWheel(event); };
    area.addEventListener('wheel', wheel, { passive: false });
    area.addEventListener('gesturestart', start, { passive: false });
    area.addEventListener('gesturechange', change, { passive: false });
    area.addEventListener('gestureend', end);
    return () => { area.removeEventListener('wheel', wheel); area.removeEventListener('gesturestart', start); area.removeEventListener('gesturechange', change); area.removeEventListener('gestureend', end); };
  }, [size, pdf, pages.length]);
  const erase = (p: Point) => setStrokes(all => all.filter(s => {
    const radius = 18 / view.z + s.width / 2;
    if (s.points.length === 1) return Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y) > radius;
    return !s.points.slice(1).some((end, index) => distanceToSegment(p, s.points[index], end) <= radius);
  }));
  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const screen = { x: e.clientX - bounds.left, y: e.clientY - bounds.top }, p = point(screen);
    if (tool !== 'select' && (pdf ? !paperAt(p) : p.x < 0 || p.x > board.w || p.y < 0 || p.y > board.h)) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (tool === 'select') {
      const image = [...items].reverse().find(item => item.kind === 'image' && p.x >= item.x && p.x <= item.x + item.w && p.y >= item.y && p.y <= item.y + item.h);
      setSelectedImageId(image?.id ?? null);
      gesture.current = image ? { kind: 'move-image', start: p, view, itemId: image.id, itemStart: { x: image.x, y: image.y } } : { kind: 'pan', start: screen, view };
    }
    else if (tool === 'eraser') { gesture.current = { kind: 'erase', start: screen, view }; erase(p); }
    else { gesture.current = { kind: 'draw', start: screen, view, stroke: { id: next(), kind: tool, color: tool === 'highlighter' && color === colors[0] ? '#f4ce46' : color, width: tool === 'highlighter' ? 18 : tool === 'ruler' ? 2 : width, points: [p] } }; draw(); }
  };
  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current; if (!g) return;
    const bounds = e.currentTarget.getBoundingClientRect();
    const screen = { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
    if (g.kind === 'pan') {
      const v = { ...g.view, x: g.view.x + screen.x - g.start.x, y: g.view.y + screen.y - g.start.y };
      setView(pdf ? constrainPdfView(v, size, pages.length) : v);
      if (!pdf) extend(v);
      return;
    }
    if (g.kind === 'move-image' && g.itemStart) {
      const p = point(screen);
      setItems(all => all.map(item => {
        if (item.id !== g.itemId) return item;
        const x = g.itemStart!.x + p.x - g.start.x, y = g.itemStart!.y + p.y - g.start.y;
        if (!pdf) return { ...item, x: limit(x, 0, Math.max(0, board.w - item.w)), y: limit(y, 0, Math.max(0, board.h - item.h)) };
        const page = limit(Math.round(y / (PH + GAP)), 0, pages.length - 1);
        return { ...item, x: limit(x, 0, PW - item.w), y: limit(y, page * (PH + GAP), page * (PH + GAP) + PH - item.h) };
      }));
      return;
    }
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
    const scale = Math.min(600 / img.naturalWidth, size.w * .7 / img.naturalWidth,
      (pdf ? PH * .72 : size.h * .7) / img.naturalHeight, 1.5);
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    const center = point({ x: size.w / 2, y: size.h / 2 });
    const id = next();
    setItems(all => [...all, { id, kind: 'image', x: pdf ? limit(center.x - w / 2, 0, PW - w) : center.x - w / 2, y: pdf ? limit(center.y - h / 2, 0, PH - h) : center.y - h / 2, w, h, content: src }]);
    setSelectedImageId(id); setTool('select');
  };
  const handleFile = async (file?: File) => {
    if (!file) return;
    if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
      setBusyPdf(true);
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
        const source = new Uint8Array(await file.arrayBuffer());
        const doc = await pdfjs.getDocument({ data: source.slice(), useSystemFonts: true }).promise;
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
        pdfSource.current = source;
        setPages(result); setPdfName(file.name); setStrokes([]); setItems([]); setSelectedImageId(null); setTool('select');
        setView(constrainPdfView(initialPdfView(size), size, result.length));
        setRangeFrom(1); setRangeTo(result.length); setExportMode('all');
      } catch (err) { setNotice(err instanceof Error ? `PDF 打开失败：${err.message}` : 'PDF 打开失败'); }
      setBusyPdf(false);
    } else if (file.type.startsWith('image/')) await addImage(file);
    else { setFiles(all => [...all, { name: file.name, url: URL.createObjectURL(file) }]); setNotice(`已添加文件：${file.name}`); }
  };
  useEffect(() => {
    if (!atomId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(`/api/atoms/${encodeURIComponent(atomId)}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '无法读取原子');
        if (cancelled) return;
        const atom = result.atom;
        setAtomTitle(atom.title || '未命名原子');
        if (atom.pdfAsset) {
          const pdfResponse = await fetch(atom.pdfAsset);
          if (!pdfResponse.ok) throw new Error('无法读取 PDF 来源');
          await handleFile(new File([await pdfResponse.blob()], atom.sources?.find((source: { kind: string }) => source.kind === 'pdf')?.name || '资料.pdf', { type: 'application/pdf' }));
        }
        if (cancelled) return;
        const saved = atom.board || {};
        setItems(Array.isArray(saved.items) ? saved.items : []);
        setSelectedImageId(null);
        setStrokes(Array.isArray(saved.strokes) ? saved.strokes : []);
        setBoard({ w: Math.max(3600, Number(saved.width) || 3600), h: Math.max(2400, Number(saved.height) || 2400) });
        if (atom.format !== 'pdf') setView(saved.view?.x ? saved.view : { x: size.w / 2 - 1650, y: 35, z: 1 });
        ids.current = Math.max(0, ...(saved.items || []).map((item: Item) => item.id), ...(saved.strokes || []).map((stroke: Stroke) => stroke.id));
        loadedAtom.current = true;
      } catch (error) { setNotice(error instanceof Error ? error.message : '无法读取原子'); }
    };
    void load(); return () => { cancelled = true; };
  // Load once for the atom URL. Changes are saved by the effect below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atomId]);
  const createPreview = () => {
    const preview = document.createElement('canvas'); preview.width = 800; preview.height = 600;
    const context = preview.getContext('2d'); if (!context) return null;
    context.fillStyle = '#fff'; context.fillRect(0, 0, 800, 600);
    if (pdf && pages[0]) {
      const firstPage = getImage(pages[0].src);
      if (firstPage.complete && firstPage.naturalWidth) {
        const scale = Math.min(760 / firstPage.naturalWidth, 560 / firstPage.naturalHeight);
        const width = firstPage.naturalWidth * scale, height = firstPage.naturalHeight * scale;
        context.drawImage(firstPage, (800 - width) / 2, (600 - height) / 2, width, height);
      }
      return preview.toDataURL('image/png');
    }
    context.strokeStyle = '#e5eaf1'; context.lineWidth = 1;
    for (let x = 0; x < 800; x += 20) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, 600); context.stroke(); }
    for (let y = 0; y < 600; y += 20) { context.beginPath(); context.moveTo(0, y); context.lineTo(800, y); context.stroke(); }
    context.translate(-1200 * .65, -80 * .65); context.scale(.65, .65);
    items.forEach(item => {
      if (item.kind === 'image') { const picture = getImage(item.content); if (picture.complete && picture.naturalWidth) context.drawImage(picture, item.x, item.y, item.w, item.h); return; }
      const fontSize = item.fontSize || 28; context.fillStyle = item.color || '#293044'; context.font = `${item.weight === 'bold' ? '700 ' : ''}${fontSize}px Arial, sans-serif`;
      let y = item.y + fontSize;
      for (const paragraph of item.content.split('\n')) {
        let line = '';
        for (const character of paragraph) {
          if (context.measureText(line + character).width > item.w && line) { context.fillText(line, item.x, y); y += fontSize * 1.4; line = character; }
          else line += character;
        }
        context.fillText(line, item.x, y); y += fontSize * 1.4;
      }
    });
    strokes.forEach(stroke => { if (!stroke.points.length) return; context.strokeStyle = stroke.color; context.lineWidth = stroke.width; context.lineCap = 'round'; context.beginPath(); context.moveTo(stroke.points[0].x, stroke.points[0].y); stroke.points.slice(1).forEach(point => context.lineTo(point.x, point.y)); context.stroke(); });
    return preview.toDataURL('image/png');
  };
  const saveAtom = async (withPreview = false) => {
    if (!atomId || !loadedAtom.current) return;
    const response = await fetch(`/api/atoms/${encodeURIComponent(atomId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ board: { width: board.w, height: board.h, background: 'grid', items, strokes, view }, ...(withPreview ? { previewData: createPreview() } : {}) }) });
    if (!response.ok) throw new Error('白板保存失败');
  };
  useEffect(() => {
    if (!atomId || !loadedAtom.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void saveAtom().catch(() => setNotice('白板保存失败，请检查本机服务')); }, 650);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atomId, board, items, strokes, view]);
  const backToMain = async () => {
    if (exitBusy) return;
    setExitBusy(true);
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await saveAtom(true);
      if (!atomId) { location.href = '/main/'; return; }
      const clock = studyClock.current;
      if (!exitAttempt.current) exitAttempt.current = { id: crypto.randomUUID(), duration: Math.round(clock.elapsed + (clock.started ? performance.now() - clock.started : 0)) };
      const response = await fetch(`/api/atoms/${encodeURIComponent(atomId)}/exit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exitId: exitAttempt.current.id, studyMs: exitAttempt.current.duration }) });
      const result = await response.json() as { shouldPrompt?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error || '结束学习失败');
      if (result.shouldPrompt) setMemoryOpen(true);
      else location.href = '/main/';
    } catch (error) { setNotice(error instanceof Error ? error.message : '结束学习失败'); }
    finally { setExitBusy(false); }
  };
  const chooseMemory = async (choice: 'always' | 'never' | 'later') => {
    if (!atomId || exitBusy) return;
    setExitBusy(true);
    try {
      const response = await fetch(`/api/atoms/${encodeURIComponent(atomId)}/memory`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ choice }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || '记忆设置失败');
      location.href = '/main/';
    } catch (error) { setNotice(error instanceof Error ? error.message : '记忆设置失败'); }
    finally { setExitBusy(false); }
  };
  const removePdf = () => { pdfSource.current = null; setPages([]); setPdfName(''); setStrokes(savedStrokes); setItems(savedItems); setSelectedImageId(null); setView({ x: -size.w, y: 48, z: 1 }); setTool('select'); };
  const insertText = () => {
    if (!textValue.trim()) return;
    const center = point({ x: size.w / 2, y: size.h / 2 });
    setItems(all => [...all, { id: next(), kind: 'text', x: pdf ? limit(center.x - 130, 16, PW - 270) : center.x - 130, y: pdf ? limit(center.y, 16, PH - 70) : center.y, w: 270, h: 50, content: textValue.trim() }]);
    setTextValue(''); setTextOpen(false);
  };
  const currentPage = pdf ? limit(Math.floor((((size.h / 2 - view.y) / view.z) + GAP / 2) / (PH + GAP)) + 1, 1, pages.length) : 0;
  const firstPage = exportMode === 'all' ? 1 : exportMode === 'current' ? currentPage : rangeFrom;
  const lastPage = exportMode === 'all' ? pages.length : exportMode === 'current' ? currentPage : rangeTo;
  const validRange = !pdf || (Number.isInteger(firstPage) && Number.isInteger(lastPage) && firstPage >= 1 && firstPage <= lastPage && lastPage <= pages.length);
  const confirmDownload = async () => {
    if (!pdf) {
      if (canvas.current) { const link = document.createElement('a'); link.href = canvas.current.toDataURL('image/png'); link.download = '白板-当前视图.png'; link.click(); }
      setExportOpen(false); return;
    }
    if (!validRange || !pdfSource.current) return;
    setExportBusy(true);
    try {
      const { downloadAnnotatedPdf } = await import('./exportPdf');
      await downloadAnnotatedPdf({ source: pdfSource.current, firstPage, lastPage, filename: pdfName, strokes, items });
      setExportOpen(false);
    } catch (error) { setNotice(error instanceof Error ? `下载失败：${error.message}` : '下载失败'); }
    finally { setExportBusy(false); }
  };
  const ocr = async () => {
    if (!canvas.current) return;
    setAssistOpen(false);
    setOcrOpen(true); setOcrBusy(true); setOcrText('');
    try {
      const response = await fetch('/api/ocr', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: canvas.current.toDataURL('image/jpeg', .85) }) });
      const data = await response.json() as { error?: string; text?: string };
      if (response.status === 401 || response.status === 503) { setNeedsKey(true); setOcrText(data.error || '请输入 DeepSeek API 密钥'); return; }
      if (!response.ok) throw new Error(data.error || '识别失败');
      setNeedsKey(false); setOcrText(data.text || '未识别到文字');
    } catch (err) { setOcrText(err instanceof Error ? err.message : '识别失败，请通过本机启动器打开白板'); }
    finally { setOcrBusy(false); }
  };
  const askAssist = async () => {
    const question = assistQuestion.trim();
    if (!question || !canvas.current || assistBusy) return;
    if (!atomId) { setAssistError('请先从主页打开一个项目，再让 gigle 结合项目学习方案回答。'); return; }
    setAssistBusy(true); setAssistError('');
    let started = false;
    try {
      const context = { viewport: { width: size.w, height: size.h }, view, pdfPage: pdf ? currentPage : null,
        items: items.map(item => ({ id: item.id, kind: item.kind, x: item.x, y: item.y, w: item.w, h: item.h,
          content: item.kind === 'text' ? item.content.slice(0, 500) : '' })) };
      const response = await fetch('/api/visual-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ atomId, question, image: canvas.current.toDataURL('image/jpeg', .85), context, history: assistMessages.slice(-8) }) });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        if (response.status === 401 || response.status === 503) setAssistNeedsKey(true);
        throw new Error(data.error || 'gigle 暂时无法回答');
      }
      setAssistNeedsKey(false);
      setAssistMessages(all => [...all, { role: 'user', content: question }, { role: 'assistant', content: '' }]);
      started = true;
      setAssistQuestion('');
      await readAgentStream(response, delta => setAssistMessages(all => all.map((message, index) => index === all.length - 1 ? { ...message, content: message.content + delta } : message)));
    } catch (error) {
      if (started) setAssistMessages(all => all.slice(0, -2));
      setAssistError(error instanceof Error ? error.message : 'gigle 暂时无法回答');
    }
    finally { setAssistBusy(false); }
  };
  const configureKey = async (target: 'ocr' | 'assist' = 'ocr') => {
    if (!keyValue.trim()) return;
    setKeyBusy(true);
    try {
      const response = await fetch('/api/ocr/key', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: keyValue.trim() }) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || '密钥设置失败');
      setKeyValue(''); setNeedsKey(false);
      if (target === 'assist') { setAssistNeedsKey(false); await askAssist(); }
      else await ocr();
    } catch (error) { setOcrText(error instanceof Error ? error.message : '密钥设置失败'); }
    finally { setKeyBusy(false); }
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
    <header className="topbar"><div className="brand"><button className="home-link" onClick={() => void backToMain()} aria-label="返回主页">← 主页</button><span className="brand-mark"><span /></span><strong>gigle</strong><span className="brand-divider" /><span title={atomTitle}>{atomTitle || '学习白板'}</span></div><div className="header-actions">
      {pdfName && <div className="pdf-chip"><FileText size={16} /><span title={pdfName}>{pdfName}</span><button onClick={removePdf} title="删除 PDF，返回白板" aria-label="删除 PDF，返回白板"><X size={15} /></button></div>}
      {files.map((file, i) => <a className="file-chip" href={file.url} download={file.name} key={`${file.name}-${i}`}>{file.name}</a>)}
      <Button className="upload-button" onClick={() => upload.current?.click()}><Upload size={17} />上传</Button>
      <input className="sr-only" ref={upload} type="file" onChange={e => { void handleFile(e.target.files?.[0]); e.target.value = ''; }} aria-label="上传文件" />
    </div></header>
    <div className="canvas-area" ref={wrap}>
      <canvas ref={canvas} className={`drawing-canvas cursor-${tool}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} aria-label={pdf ? 'PDF 批注画布' : '网格白板'} />
      <div className="canvas-caption"><span className="green-dot" />{pdf ? `PDF · ${pages.length} 页` : '无限白板'}<span className="caption-sep">/</span>{Math.round(view.z * 100)}%</div>
      <div className="floating-tray" style={{ left: tray.left, top: tray.top }}><button className="tray-grip" onPointerDown={beginTray} onPointerMove={moveTray} onPointerUp={() => { dragTray.current = null; }} title="拖动工具栏" aria-label="拖动工具栏"><Grip size={20} /></button><span className="tray-line" />
        {tools.map(({ id, label, icon: Icon }) => <Button key={id} variant="ghost" size="icon-lg" className={`tool-button ${tool === id ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={tool === id} onClick={() => { setTool(id); setInsertOpen(false); }}><Icon size={19} /></Button>)}
        <span className="tray-line" /><div className="insert-holder"><Button variant="ghost" size="icon-lg" className={`tool-button ${insertOpen ? 'active' : ''}`} title="插入" aria-label="插入" aria-expanded={insertOpen} onClick={() => setInsertOpen(v => !v)}><Plus size={21} /></Button>{insertOpen && <div className="insert-menu"><button onClick={() => { setTextOpen(true); setInsertOpen(false); }}><Type size={17} />文本</button><button onClick={() => { imageInput.current?.click(); setInsertOpen(false); }}><ImagePlus size={17} />图片</button><button onClick={() => { upload.current?.click(); setInsertOpen(false); }}><Upload size={17} />文件</button></div>}</div>
        <input className="sr-only" ref={imageInput} type="file" accept="image/*" onChange={e => { if (e.target.files?.[0]) void addImage(e.target.files[0]); e.target.value = ''; }} aria-label="插入图片" />
      </div>
      {tool !== 'select' && tool !== 'eraser' && <div className="style-tray"><span>颜色</span>{colors.map(c => <button key={c} className={`swatch ${color === c ? 'chosen' : ''}`} style={{ background: c }} title={c} aria-label={`选择颜色 ${c}`} onClick={() => setColor(c)} />)}<span className="style-line" /><span>粗细</span><input type="range" min="1" max="12" value={width} onChange={e => setWidth(Number(e.target.value))} aria-label="笔画粗细" /><b>{width}</b></div>}
      {tool === 'ruler' && <div className="ruler-overlay" style={{ left: ruler.left, top: ruler.top, transform: `rotate(${ruler.angle}deg)` }}><div className="ruler-body" onPointerDown={beginRuler} onPointerMove={moveRuler} onPointerUp={() => { dragRuler.current = null; }}><div className="ruler-ticks" /><span>拖动直尺 · 在纸上拖动画直线</span></div><button onClick={() => setRuler(r => ({ ...r, angle: r.angle + 15 }))} title="旋转直尺"><RotateCw size={16} /></button></div>}
      <div className="zoom-controls"><Button variant="ghost" size="icon" onClick={() => zoomAt(1 / 1.2)} aria-label="缩小"><Minus size={17} /></Button><span>{Math.round(view.z * 100)}%</span><Button variant="ghost" size="icon" onClick={() => zoomAt(1.2)} aria-label="放大"><Plus size={17} /></Button><span className="zoom-line" /><Button variant="ghost" size="icon" onClick={() => pdf ? setView(constrainPdfView(initialPdfView(size), size, pages.length)) : setView({ x: -size.w, y: 48, z: 1 })} aria-label="重置视图"><Maximize2 size={16} /></Button></div>
      {!pdf && strokes.length === 0 && items.length === 0 && <div className="empty-hint"><div><PenLine size={22} /></div><strong>从这里开始思考</strong><span>拖动白板探索空间，或选择画笔写下第一笔</span></div>}
      {ocrOpen && <section className="ocr-panel" aria-live="polite"><div className="ocr-top"><span className="ocr-icon"><ScanText size={18} /></span><div><strong>可见内容识别</strong><small>当前屏幕的画布内容</small></div><button onClick={() => setOcrOpen(false)} aria-label="关闭识别结果"><X size={18} /></button></div><div className="ocr-body">{ocrBusy ? <span className="ocr-wait"><i />正在识别可见内容…</span> : <><p>{ocrText}</p>{needsKey && <form className="ocr-key-form" onSubmit={e => { e.preventDefault(); void configureKey(); }}><label htmlFor="deepseek-key">DeepSeek API 密钥（只保存在本次本机运行内存中）</label><input id="deepseek-key" type="password" autoComplete="off" value={keyValue} onChange={e => setKeyValue(e.target.value)} placeholder="粘贴 API 密钥" /><Button type="submit" disabled={keyBusy || !keyValue.trim()}>{keyBusy ? '正在连接…' : '启用并重新识别'}</Button></form>}</>}</div></section>}
      {assistOpen && <section className="ocr-panel assist-panel" aria-label="gigle AI 辅助"><div className="ocr-top"><span className="gigle-bot" aria-hidden="true"><i /><b /><b /></span><div><strong>gigle</strong><small>看着当前画布，陪你一起思考</small></div><button onClick={() => setAssistOpen(false)} aria-label="关闭 AI 辅助"><X size={18} /></button></div>
        <div className="assist-messages" ref={assistScroll} aria-live="polite">
          {!assistMessages.length && <p className="assist-greeting">你好，我是 gigle。你可以问我画面里的内容、题目或下一步怎么做。发送时我会看当前可见画布。</p>}
          {assistMessages.map((message, index) => <p key={index} className={`assist-message ${message.role}`}>{message.content}</p>)}
          {assistBusy && !assistMessages.at(-1)?.content && <p className="assist-thinking"><i />gigle 正在看画布…</p>}
        </div>
        {assistError && <p className="assist-error" role="alert">{assistError}</p>}
        {assistNeedsKey && <form className="ocr-key-form assist-key-form" onSubmit={e => { e.preventDefault(); void configureKey('assist'); }}><label htmlFor="visual-deepseek-key">DeepSeek API 密钥（只保存在本次本机运行内存中）</label><input id="visual-deepseek-key" type="password" autoComplete="off" value={keyValue} onChange={e => setKeyValue(e.target.value)} placeholder="粘贴 API 密钥" /><Button type="submit" disabled={keyBusy || !keyValue.trim()}>{keyBusy ? '正在连接…' : '启用并发送问题'}</Button></form>}
        <form className="assist-composer" onSubmit={e => { e.preventDefault(); void askAssist(); }}><textarea autoFocus value={assistQuestion} onChange={e => setAssistQuestion(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void askAssist(); } }} placeholder="问 gigle：这道题下一步怎么做？" maxLength={2000} aria-label="向 gigle 提问" /><Button type="submit" disabled={assistBusy || !assistQuestion.trim()}>发送</Button></form>
      </section>}
      <div className="bottom-actions"><Button variant="outline" onClick={() => setExportOpen(true)}><ArrowDownToLine size={18} />下载</Button><Button className="ai-button" disabled={ocrBusy} onClick={() => void ocr()}><ScanText size={18} />AI 识别</Button><Button className="ai-assist-button" onClick={() => { setOcrOpen(false); setAssistOpen(true); }}>✦ AI 辅助</Button></div>
      {busyPdf && <div className="loading-mask"><i />正在打开 PDF…</div>}
      {notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></button></div>}
    </div>
    {textOpen && <div className="dialog-backdrop" onClick={() => setTextOpen(false)}><div className="text-dialog" role="dialog" aria-modal="true" aria-label="插入文本" onClick={e => e.stopPropagation()}><div className="dialog-heading"><Type size={19} /><strong>插入文本</strong><button onClick={() => setTextOpen(false)} aria-label="关闭"><X size={18} /></button></div><textarea autoFocus value={textValue} onChange={e => setTextValue(e.target.value)} placeholder="输入要放在白板上的内容…" /><div className="dialog-actions"><Button variant="ghost" onClick={() => setTextOpen(false)}>取消</Button><Button onClick={insertText} disabled={!textValue.trim()}>插入</Button></div></div></div>}
    {exportOpen && <div className="dialog-backdrop" onClick={() => !exportBusy && setExportOpen(false)}><div className="text-dialog export-dialog" role="dialog" aria-modal="true" aria-label="确认下载范围" onClick={e => e.stopPropagation()}>
      <div className="dialog-heading"><ArrowDownToLine size={19} /><strong>确认下载范围</strong><button onClick={() => setExportOpen(false)} disabled={exportBusy} aria-label="关闭"><X size={18} /></button></div>
      {pdf ? <><p className="export-file">{pdfName} · 共 {pages.length} 页</p><div className="export-options">
        <label><input type="radio" name="export-mode" checked={exportMode === 'all'} onChange={() => setExportMode('all')} /><span>全部页面</span><small>第 1–{pages.length} 页</small></label>
        <label><input type="radio" name="export-mode" checked={exportMode === 'current'} onChange={() => setExportMode('current')} /><span>当前页面</span><small>第 {currentPage} 页</small></label>
        <label><input type="radio" name="export-mode" checked={exportMode === 'custom'} onChange={() => setExportMode('custom')} /><span>指定范围</span><small>选择起止页码</small></label>
      </div>{exportMode === 'custom' && <div className="export-range"><label>从第 <input type="number" min="1" max={pages.length} value={rangeFrom} onChange={e => setRangeFrom(Number(e.target.value))} /> 页</label><span>至</span><label>第 <input type="number" min="1" max={pages.length} value={rangeTo} onChange={e => setRangeTo(Number(e.target.value))} /> 页</label></div>}
      <p className={`export-summary ${validRange ? '' : 'invalid'}`}>{validRange ? `将下载第 ${firstPage}–${lastPage} 页，共 ${lastPage - firstPage + 1} 页（含批注）` : `页码须在 1–${pages.length} 之间，且起始页不大于结束页`}</p></> : <p className="export-summary">将下载当前屏幕可见的白板内容（PNG 图片）。</p>}
      <div className="dialog-actions"><Button variant="ghost" onClick={() => setExportOpen(false)} disabled={exportBusy}>取消</Button><Button onClick={() => void confirmDownload()} disabled={exportBusy || !validRange}>{exportBusy ? '正在生成…' : pdf ? '下载 PDF' : '下载 PNG'}</Button></div>
    </div></div>}
    {memoryOpen && <div className="dialog-backdrop"><div className="text-dialog memory-dialog" role="dialog" aria-modal="true" aria-label="同步学习记忆">
      <div className="dialog-heading"><strong>是否同步本次经历进入你的记忆？</strong></div>
      <p>会将本项目的学习时长、资料名称、白板文字和笔迹数量写入本机 mem0 记忆，供以后创建项目时参考。</p>
      <div className="memory-choices">
        <Button onClick={() => void chooseMemory('always')} disabled={exitBusy}>本项目永远是</Button>
        <Button variant="ghost" onClick={() => void chooseMemory('never')} disabled={exitBusy}>永远不要</Button>
        <Button variant="ghost" onClick={() => void chooseMemory('later')} disabled={exitBusy}>这次先不了，下次问我</Button>
      </div>
    </div></div>}
  </main>;
}
