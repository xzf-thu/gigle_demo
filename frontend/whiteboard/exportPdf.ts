import { PDFDocument, type PDFEmbeddedPage } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';

type Point = { x: number; y: number };
type Stroke = { kind: string; color: string; width: number; points: Point[] };
type Item = { kind: 'image' | 'text'; x: number; y: number; w: number; h: number; content: string };

const PAPER_WIDTH = 794;
const PAPER_HEIGHT = 1123;
const PAGE_GAP = 36;
const PDF_WIDTH = 595.28;
const PDF_HEIGHT = 841.89;
const EXPORT_SCALE = 3;

function contain(width: number, height: number) {
  const scale = Math.min(PAPER_WIDTH / width, PAPER_HEIGHT / height);
  return { x: (PAPER_WIDTH - width * scale) / 2, y: (PAPER_HEIGHT - height * scale) / 2, w: width * scale, h: height * scale };
}

async function pngBytes(canvas: HTMLCanvasElement) {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('PDF 页面编码失败')), 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

async function imageFromDataUrl(src: string) {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

export async function downloadAnnotatedPdf(args: {
  source: Uint8Array;
  firstPage: number;
  lastPage: number;
  filename: string;
  strokes: Stroke[];
  items: Item[];
}) {
  const { source, firstPage, lastPage, filename, strokes, items } = args;
  const output = await PDFDocument.create();
  const indices = Array.from({ length: lastPage - firstPage + 1 }, (_, i) => firstPage - 1 + i);
  let embeddedPages: PDFEmbeddedPage[] | null = null;
  try {
    // Keep the source page as PDF graphics and text whenever the source allows it.
    embeddedPages = await output.embedPdf(source, indices);
  } catch {
    // Some PDFs cannot be embedded. The fallback renders those pages at about 288 DPI.
  }

  const images = new Map<string, HTMLImageElement>();
  for (const item of items) if (item.kind === 'image' && !images.has(item.content)) images.set(item.content, await imageFromDataUrl(item.content));
  let fallbackDocument: PDFDocumentProxy | null = null;
  if (!embeddedPages) {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
    fallbackDocument = await pdfjs.getDocument({ data: source.slice(), useSystemFonts: true }).promise;
  }

  for (let pageNumber = firstPage; pageNumber <= lastPage; pageNumber++) {
    const page = output.addPage([PDF_WIDTH, PDF_HEIGHT]);
    const embedded = embeddedPages?.[pageNumber - firstPage];
    if (embedded) {
      const box = contain(embedded.width, embedded.height);
      page.drawPage(embedded, { x: box.x * PDF_WIDTH / PAPER_WIDTH, y: box.y * PDF_HEIGHT / PAPER_HEIGHT, width: box.w * PDF_WIDTH / PAPER_WIDTH, height: box.h * PDF_HEIGHT / PAPER_HEIGHT });
    } else if (fallbackDocument) {
      const sourcePage = await fallbackDocument.getPage(pageNumber);
      const base = sourcePage.getViewport({ scale: 1 });
      const viewport = sourcePage.getViewport({ scale: PAPER_WIDTH * EXPORT_SCALE / base.width });
      const raster = document.createElement('canvas');
      raster.width = Math.ceil(viewport.width); raster.height = Math.ceil(viewport.height);
      const context = raster.getContext('2d'); if (!context) throw new Error('无法绘制 PDF 页面');
      await sourcePage.render({ canvas: raster, canvasContext: context, viewport }).promise;
      const image = await output.embedPng(await pngBytes(raster));
      const box = contain(raster.width, raster.height);
      page.drawImage(image, { x: box.x * PDF_WIDTH / PAPER_WIDTH, y: box.y * PDF_HEIGHT / PAPER_HEIGHT, width: box.w * PDF_WIDTH / PAPER_WIDTH, height: box.h * PDF_HEIGHT / PAPER_HEIGHT });
    }

    if (items.length || strokes.length) {
      const top = (pageNumber - 1) * (PAPER_HEIGHT + PAGE_GAP);
      const overlay = document.createElement('canvas');
      overlay.width = PAPER_WIDTH * EXPORT_SCALE;
      overlay.height = PAPER_HEIGHT * EXPORT_SCALE;
      const c = overlay.getContext('2d'); if (!c) throw new Error('无法绘制批注');
      c.scale(EXPORT_SCALE, EXPORT_SCALE);
      c.beginPath(); c.rect(0, 0, PAPER_WIDTH, PAPER_HEIGHT); c.clip();
      items.forEach(item => {
        if (item.kind === 'image') { const image = images.get(item.content); if (image) c.drawImage(image, item.x, item.y - top, item.w, item.h); }
        else { c.fillStyle = '#293044'; c.font = '28px Arial, sans-serif'; item.content.split('\n').forEach((line, i) => c.fillText(line, item.x, item.y - top + 30 + i * 38)); }
      });
      strokes.forEach(stroke => {
        if (!stroke.points.length) return;
        c.save(); c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = stroke.width; c.strokeStyle = stroke.color; c.fillStyle = stroke.color; c.globalAlpha = stroke.kind === 'highlighter' ? .38 : 1;
        c.beginPath(); c.moveTo(stroke.points[0].x, stroke.points[0].y - top);
        if (stroke.points.length === 1) { c.arc(stroke.points[0].x, stroke.points[0].y - top, stroke.width / 2, 0, Math.PI * 2); c.fill(); }
        else { stroke.points.slice(1).forEach(point => c.lineTo(point.x, point.y - top)); c.stroke(); }
        c.restore();
      });
      const annotation = await output.embedPng(await pngBytes(overlay));
      page.drawImage(annotation, { x: 0, y: 0, width: PDF_WIDTH, height: PDF_HEIGHT });
    }
  }

  const bytes = await output.save();
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename.replace(/\.pdf$/i, '')}-第${firstPage}-${lastPage}页.pdf`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
