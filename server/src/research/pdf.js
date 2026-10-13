// PDF 正文提取（M11 阅读导师的文献来源之一）
// 只用文字层：扫描件提不出文字时如实告诉学生改贴摘要，不静默失败。
// 平台不保存 PDF 原件，提取完即丢弃（版权与赛事要求：公开访问的站点不留存受版权保护的全文）。
import { AppError } from '../errors.js';

const MAX_BYTES = 20 * 1024 * 1024;   // 单份 20MB
const MAX_CHARS = 60_000;             // 提取上限，够精读用
const MAX_PAGES = 60;

let pdfjsPromise = null;
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => import('pdfjs-dist'));
  }
  return pdfjsPromise;
}

/** 把 PDF 页面的文字项拼成正文：按 y 坐标分行、按 x 排序，尽量还原阅读顺序 */
function linesFromItems(items) {
  const rows = new Map();
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    const y = Math.round(it.transform?.[5] ?? 0);
    const x = it.transform?.[4] ?? 0;
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push({ x, s: it.str });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])                       // PDF 的 y 从下往上
    .map(([, cells]) => cells.sort((a, b) => a.x - b.x).map((c) => c.s).join('').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/**
 * 从 PDF 缓冲区提取正文。返回 { text, pages, chars, hasText, note }。
 * 提不出文字（扫描件）时 hasText=false，由调用方提示学生改贴摘要。
 */
export async function extractPdfText(buffer) {
  if (!buffer?.length) throw new AppError(400, 'EMPTY_FILE', '这个文件是空的。');
  if (buffer.length > MAX_BYTES) throw new AppError(400, 'TOO_LARGE', '这份 PDF 太大了（超过20MB），请换一份或只贴摘要。');

  const pdfjs = await loadPdfjs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buffer),
      // 服务器环境无需渲染与字体
      useSystemFonts: false,
      disableFontFace: true,
      isEvalSupported: false,
    }).promise;
  } catch (e) {
    throw new AppError(400, 'BAD_PDF', `这份文件打不开，可能不是 PDF 或已损坏。${e?.message ? '' : ''}`);
  }

  const pageCount = Math.min(doc.numPages, MAX_PAGES);
  const chunks = [];
  let totalChars = 0;
  for (let p = 1; p <= pageCount; p += 1) {
    let page;
    try {
      page = await doc.getPage(p);
    } catch {
      continue;
    }
    const content = await page.getTextContent();
    const text = linesFromItems(content.items);
    page.cleanup?.();
    if (text) {
      chunks.push(text);
      totalChars += text.length;
    }
    if (totalChars >= MAX_CHARS) break;
  }
  try { await doc.destroy(); } catch { /* 忽略 */ }

  const text = chunks.join('\n\n').slice(0, MAX_CHARS).trim();
  // 提不出文字，或提出来基本是乱码/空白，都算“没有文字层”
  const meaningful = text.replace(/[\s\d\p{P}]/gu, '').length;
  const hasText = meaningful >= 200;

  return {
    text,
    pages: pageCount,
    page_count: doc.numPages,
    chars: text.length,
    hasText,
    note: hasText
      ? (doc.numPages > MAX_PAGES ? `这份 PDF 共 ${doc.numPages} 页，只提取了前 ${MAX_PAGES} 页。` : '')
      : '这份 PDF 没有可提取的文字，可能是扫描件或图片版。请改为粘贴摘要或关键段落，我照样能带你精读。',
  };
}

/** 从 PDF 文件名或正文第一段猜标题（只作默认值，学生可改） */
export function guessTitle(text, fallback = '') {
  const firstLine = String(text || '').split('\n').map((l) => l.trim()).find((l) => l.length >= 6 && l.length <= 120);
  return firstLine || fallback;
}
