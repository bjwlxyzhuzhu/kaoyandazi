// 文献导入解析与导出格式化（M12）
// 导入：BibTeX、RIS、知网导出的 EndNote / NoteExpress / RefWorks 文本（自动识别 GBK）、CSV、DOI 列表
// 导出：BibTeX、RIS、CSV、Markdown（带 YAML 头，可直接放进 Obsidian）
import { AppError } from '../errors.js';

// ---------- 编码识别：知网导出的文件常是 GBK ----------

/**
 * 把字节流解码成文本。知网导出的 EndNote/NoteExpress/RefWorks 文本多为 GBK。
 * 策略：先按 UTF-8 严格解码，失败就按 GBK；都不可靠时按替换字符比例挑更好的那个。
 */
export function decodeText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf.subarray(3));
  }
  let utf8 = '';
  let utf8Ok = true;
  try {
    utf8 = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    utf8Ok = false;
  }
  let gbk = '';
  try {
    gbk = new TextDecoder('gbk').decode(buf);
  } catch {
    gbk = '';
  }
  if (utf8Ok) return utf8;
  if (!gbk) return new TextDecoder('utf-8').decode(buf);
  // 两个都有问题时，按“替换字符”多少挑
  const bad = (s) => (s.match(/�/g) || []).length;
  return bad(gbk) <= bad(utf8) ? gbk : utf8;
}

// ---------- 统一条目形状 ----------

function emptyItem() {
  return { title: '', authors: [], year: null, venue: '', doi: '', url: '', abstract: '', lang: '', type: '', source: '' };
}

function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function splitAuthors(s) {
  return String(s || '')
    .split(/\s+and\s+|;|；|\n/)
    .map((x) => clean(x).replace(/,\s*$/, ''))
    .filter(Boolean);
}

function yearOf(v) {
  const m = String(v || '').match(/\d{4}/);
  return m ? Number(m[0]) : null;
}

function doiOf(v) {
  const m = String(v || '').match(/10\.\d{4,9}\/[^\s"'<>]+/);
  return m ? m[0].replace(/[.,;)\]]+$/, '') : '';
}

// ---------- BibTeX ----------

/** 解析 BibTeX：支持 @article{key, field = {value}, ...} 与 "value"、嵌套花括号 */
export function parseBibtex(text) {
  const items = [];
  const src = String(text || '');
  const entryRe = /@(\w+)\s*\{/g;
  let m;
  while ((m = entryRe.exec(src))) {
    const type = m[1].toLowerCase();
    if (['comment', 'preamble', 'string'].includes(type)) continue;
    // 从 { 开始按括号配平找结束
    let i = entryRe.lastIndex;
    let depth = 1;
    let body = '';
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') { depth -= 1; if (depth === 0) break; }
      body += ch;
      i += 1;
    }
    entryRe.lastIndex = i + 1;
    if (!body) continue;
    // 第一个逗号之前是引用键
    const firstComma = body.indexOf(',');
    const fieldsText = firstComma >= 0 ? body.slice(firstComma + 1) : body;
    const fields = {};
    const fieldRe = /(\w+)\s*=\s*/g;
    let f;
    while ((f = fieldRe.exec(fieldsText))) {
      const key = f[1].toLowerCase();
      let j = fieldRe.lastIndex;
      let value = '';
      while (j < fieldsText.length && /\s/.test(fieldsText[j])) j += 1;
      if (fieldsText[j] === '{') {
        let d = 1;
        j += 1;
        while (j < fieldsText.length && d > 0) {
          if (fieldsText[j] === '{') d += 1;
          else if (fieldsText[j] === '}') { d -= 1; if (d === 0) break; }
          value += fieldsText[j];
          j += 1;
        }
        j += 1;
      } else if (fieldsText[j] === '"') {
        j += 1;
        while (j < fieldsText.length && fieldsText[j] !== '"') { value += fieldsText[j]; j += 1; }
        j += 1;
      } else {
        while (j < fieldsText.length && fieldsText[j] !== ',' && fieldsText[j] !== '\n') { value += fieldsText[j]; j += 1; }
      }
      fields[key] = value.trim();
      fieldRe.lastIndex = j;
    }
    const it = emptyItem();
    it.title = clean(fields.title).replace(/[{}]/g, '');
    it.authors = splitAuthors(clean(fields.author).replace(/[{}]/g, ''));
    it.year = yearOf(fields.year || fields.date);
    it.venue = clean(fields.journal || fields.booktitle || fields.publisher);
    it.doi = doiOf(fields.doi) || doiOf(fields.url);
    it.url = clean(fields.url);
    it.abstract = clean(fields.abstract).replace(/[{}]/g, '').slice(0, 3000);
    it.type = type;
    it.source = 'bibtex';
    if (it.title) items.push(it);
  }
  if (!items.length) throw new AppError(400, 'NO_ENTRY', '这个文件里没有解析出文献条目。支持 BibTeX（@article{…}）格式。');
  return items;
}

// ---------- RIS ----------

export function parseRis(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  let cur = null;
  const push = () => { if (cur && cur.title) items.push(cur); cur = null; };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('ER')) { push(); continue; }
    const m = line.match(/^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/);
    if (!m) continue;
    const [, tag, value] = m;
    if (tag === 'TY') { push(); cur = emptyItem(); cur.type = clean(value); cur.source = 'ris'; continue; }
    if (!cur) cur = emptyItem();
    cur.source = cur.source || 'ris';
    switch (tag) {
      case 'TI': case 'T1': cur.title = clean(value); break;
      case 'AU': case 'A1': cur.authors.push(clean(value)); break;
      case 'PY': case 'Y1': cur.year = yearOf(value); break;
      case 'JO': case 'JF': case 'T2': case 'JA': cur.venue = clean(value); break;
      case 'DO': cur.doi = doiOf(value) || clean(value); break;
      case 'UR': case 'L1': if (!cur.url) cur.url = clean(value); break;
      case 'AB': case 'N2': cur.abstract = clean(value).slice(0, 3000); break;
      case 'LA': cur.lang = clean(value); break;
      default: break;
    }
  }
  push();
  if (!items.length) throw new AppError(400, 'NO_ENTRY', '这个文件里没有解析出文献条目。支持 RIS（TY  - JOUR 开头）格式。');
  return items;
}

// ---------- 知网导出的 EndNote / NoteExpress / RefWorks 文本 ----------

/** 这几个格式都是“%X 值”或“XX 值”的纯文本，按字段首字母识别 */
export function parseTagged(text) {
  const lines = String(text || '').split(/\r?\n/);
  const items = [];
  let cur = null;

  // RefWorks 用 "RT Journal Article"，EndNote/NoteExpress 用 "%0 Journal Article"
  const isRefworks = lines.some((l) => /^RT\s+\S/.test(l.trim()));
  const isTagged = lines.some((l) => /^%[A-Z0-9@!]/.test(l.trim()));
  if (!isRefworks && !isTagged) throw new AppError(400, 'NO_ENTRY', '这个文件里没有解析出文献条目。支持的格式：EndNote、NoteExpress、RefWorks 导出的文本。');

  const start = () => {
    if (cur && (cur.title || cur.authors.length)) items.push(cur);
    cur = emptyItem();
    cur.source = isRefworks ? 'refworks' : 'tagged';
  };
  start();

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let tag = '';
    let value = '';
    const m = line.match(/^%([A-Z0-9@!])\s*(.*)$/);
    if (m) { tag = m[1]; value = m[2]; }
    else {
      // RefWorks 用两字符标签，第二位可能是数字（T1、A1、YR、DO）
      const rw = line.match(/^([A-Z][A-Z0-9])\s+(.*)$/);
      if (rw) { tag = rw[1]; value = rw[2]; }
    }
    if (!tag) continue;
    // 遇到“新条目”的起始标签就切分
    if ((isRefworks && tag === 'RT') || (!isRefworks && tag === '0')) { start(); cur.type = clean(value); continue; }
    switch (tag) {
      case 'T': case 'T1': cur.title = clean(value); break;            // %T 题名 / RefWorks T1
      case 'A': case 'A1': cur.authors.push(clean(value)); break;      // %A 作者 / RefWorks A1
      case 'D': case 'Y1': case 'YR': cur.year = yearOf(value); break; // 年份
      case 'J': case 'B': case 'T2': case 'JF': case 'JA':
        if (!cur.venue) cur.venue = clean(value); break;               // 期刊/书名
      case 'R': case 'DO': if (!cur.doi) cur.doi = doiOf(value) || clean(value); break;  // DOI
      case 'U': case 'L': case 'OP': case 'UL': if (!cur.url) cur.url = clean(value); break; // 链接
      case 'X': case 'AB': case 'N2': cur.abstract = clean(value).slice(0, 3000); break;     // 摘要
      case 'LA': cur.lang = clean(value); break;                       // 语言
      default: break;
    }
  }
  if (cur && (cur.title || cur.authors.length)) items.push(cur);
  if (!items.length) throw new AppError(400, 'NO_ENTRY', '这个文件里没有解析出文献条目。');
  return items;
}

// ---------- CSV ----------

export function parseCsv(text) {
  const rows = [];
  const src = String(text || '').replace(/^﻿/, '');
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); if (row.some((c) => c.trim())) rows.push(row); }
  if (rows.length < 2) throw new AppError(400, 'NO_ENTRY', 'CSV 里没有数据行。表头可以写：题名,作者,年份,期刊,DOI,链接,摘要');

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (...names) => {
    for (const n of names) {
      const i = header.findIndex((h) => h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const iTitle = idx('题名', 'title', '标题');
  const iAuthors = idx('作者', 'author');
  const iYear = idx('年份', 'year', '年');
  const iVenue = idx('期刊', 'venue', '来源', '刊名');
  const iDoi = idx('doi');
  const iUrl = idx('链接', 'url', '地址');
  const iAbs = idx('摘要', 'abstract');
  if (iTitle < 0) throw new AppError(400, 'NO_TITLE_COL', 'CSV 里找不到“题名”列。表头可以写：题名,作者,年份,期刊,DOI,链接,摘要');

  const items = [];
  for (const r of rows.slice(1)) {
    const it = emptyItem();
    it.title = clean(r[iTitle]);
    it.authors = iAuthors >= 0 ? splitAuthors(clean(r[iAuthors])) : [];
    it.year = iYear >= 0 ? yearOf(r[iYear]) : null;
    it.venue = iVenue >= 0 ? clean(r[iVenue]) : '';
    it.doi = iDoi >= 0 ? doiOf(r[iDoi]) : '';
    it.url = iUrl >= 0 ? clean(r[iUrl]) : '';
    it.abstract = iAbs >= 0 ? clean(r[iAbs]).slice(0, 3000) : '';
    it.source = 'csv';
    if (it.title) items.push(it);
  }
  if (!items.length) throw new AppError(400, 'NO_ENTRY', 'CSV 里没有解析出文献条目。');
  return items;
}

// ---------- DOI 列表 ----------

export function parseDoiList(text) {
  const found = String(text || '').match(/10\.\d{4,9}\/[^\s"'<>,;]+/g) || [];
  const dois = [...new Set(found.map((d) => d.replace(/[.,;)\]]+$/, '')))];
  if (!dois.length) throw new AppError(400, 'NO_DOI', '没有找到 DOI。每行写一个 DOI 就行，例如 10.1038/nature14539。');
  return dois.slice(0, 200);
}

/** 按内容自动判断格式 */
export function parseAuto(text, filename = '') {
  const t = String(text || '');
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.bib') || /@\w+\s*\{/.test(t)) return { format: 'bibtex', items: parseBibtex(t) };
  if (/^TY\s{1,2}-/m.test(t)) return { format: 'ris', items: parseRis(t) };
  if (/^%[A-Z0-9@!]\s/m.test(t) || /^RT\s+\S/m.test(t)) return { format: 'tagged', items: parseTagged(t) };
  if (lower.endsWith('.csv') || (t.split('\n')[0] || '').includes(',')) return { format: 'csv', items: parseCsv(t) };
  if (/10\.\d{4,9}\//.test(t)) {
    const dois = parseDoiList(t);
    return { format: 'doi_list', items: dois.map((d) => ({ ...emptyItem(), doi: d, source: 'doi_list' })), dois };
  }
  throw new AppError(400, 'UNKNOWN_FORMAT', '认不出这个文件的格式。支持的格式：BibTeX、RIS、EndNote/NoteExpress/RefWorks 文本、CSV、DOI 列表。');
}

// ---------- 导出 ----------

function bibKey(it, i) {
  const first = (it.authors[0] || 'anon').split(/\s+/).pop().replace(/[^\w]/g, '') || 'anon';
  return `${first}${it.year || ''}${i}`.toLowerCase();
}

export function toBibtex(items) {
  return items.map((it, i) => {
    const lines = [`@article{${bibKey(it, i)},`];
    lines.push(`  title = {${it.title}},`);
    if (it.authors.length) lines.push(`  author = {${it.authors.join(' and ')}},`);
    if (it.year) lines.push(`  year = {${it.year}},`);
    if (it.venue) lines.push(`  journal = {${it.venue}},`);
    if (it.doi) lines.push(`  doi = {${it.doi}},`);
    if (it.url) lines.push(`  url = {${it.url}},`);
    lines.push('}');
    return lines.join('\n');
  }).join('\n\n') + '\n';
}

export function toRis(items) {
  return items.map((it) => {
    const out = ['TY  - JOUR'];
    if (it.title) out.push(`TI  - ${it.title}`);
    for (const a of it.authors) out.push(`AU  - ${a}`);
    if (it.year) out.push(`PY  - ${it.year}`);
    if (it.venue) out.push(`JO  - ${it.venue}`);
    if (it.doi) out.push(`DO  - ${it.doi}`);
    if (it.url) out.push(`UR  - ${it.url}`);
    if (it.abstract) out.push(`AB  - ${it.abstract}`);
    out.push('ER  - ');
    return out.join('\n');
  }).join('\n\n') + '\n';
}

function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

export function toCsv(items) {
  const head = ['题名', '作者', '年份', '期刊', 'DOI', '链接', '摘要'];
  const lines = [head.map(csvCell).join(',')];
  for (const it of items) {
    lines.push([it.title, it.authors.join('; '), it.year || '', it.venue, it.doi, it.url, (it.abstract || '').slice(0, 500)].map(csvCell).join(','));
  }
  return `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`;
}

function yamlStr(s) {
  return `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`;
}

/** 阅读卡导出为 Markdown（带 YAML 头，可直接放进 Obsidian） */
export function cardToMarkdown(card, paper) {
  const front = [
    '---',
    `title: ${yamlStr(paper?.title || `阅读卡 ${card.id}`)}`,
    `authors: [${(paper?.authors || []).map(yamlStr).join(', ')}]`,
    `year: ${paper?.year || ''}`,
    `doi: ${yamlStr(paper?.doi || '')}`,
    `venue: ${yamlStr(paper?.venue || '')}`,
    `verify: ${paper?.verify_status || 'unverified'}`,
    `created: ${card.created_at || ''}`,
    'tags: [阅读卡, 山海问知]',
    '---',
    '',
  ].join('\n');
  const body = [
    `# ${paper?.title || '阅读卡'}`,
    '',
    '## 研究问题',
    card.question || '',
    '',
    '## 方法',
    card.method || '',
    '',
    '## 证据',
    card.evidence || '',
    '',
    '## 结论',
    card.conclusion || '',
    '',
    '## 局限',
    card.limitation || '',
    '',
    '## 我的判断',
    card.my_judgment || '',
    '',
    '## 我的疑问',
    ...(Array.isArray(card.doubts) ? card.doubts.map((d) => `- ${d}`) : []),
    '',
    card.ai_note ? `> AI 说明：${card.ai_note}` : '',
    '',
  ].join('\n');
  return front + body;
}
