// 学术文献检索与核验（M11）：OpenAlex 检索、Crossref 核验。
// 这两个工具本身不调用大模型，所以“关键词检索 + 核验”对所有学生开放，不需要任何 Key。
import { config } from '../config.js';
import { AppError } from '../errors.js';

const UA = 'ShanhaiWenzhi/0.1 (educational; mailto:REPLACE)';
const TIMEOUT_MS = 25_000;

function mailto() {
  const m = config.research?.openalexMailto;
  return m ? `mailto:${m}` : '';
}

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA.replace('REPLACE', mailto() || 'none') },
    });
    if (res.status === 404) return { notFound: true };
    if (!res.ok) throw new AppError(502, 'API_FAILED', `文献服务返回 ${res.status}，请稍后再试。`);
    return await res.json();
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (e?.name === 'AbortError') throw new AppError(504, 'TIMEOUT', '文献服务响应太慢，请稍后再试。');
    throw new AppError(502, 'API_FAILED', '连不上文献服务，请检查网络后重试。');
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 规范化与相似度（PRD 7.x：题名比对阈值 0.85 且第一作者姓氏一致） ----------

/** 规范化题名：去标点、去空格、全角转半角、转小写；中英文都适用 */
export function normalizeTitle(s) {
  return String(s || '')
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ')          // 全角空格
    .toLowerCase()
    .trim()
    // 冠词只按“整词”去（带空格），否则 ai、theory 开头的题名会被咬掉首字母
    .replace(/^(a|an|the)\s+/, '')
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 字符级相似度（Dice 系数），对中英文题名都够用 */
export function titleSimilarity(a, b) {
  const x = normalizeTitle(a);
  const y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return x === y ? 1 : 0;
  const bigrams = new Map();
  for (let i = 0; i < x.length - 1; i += 1) {
    const g = x.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < y.length - 1; i += 1) {
    const g = y.slice(i, i + 2);
    const n = bigrams.get(g) || 0;
    if (n > 0) { bigrams.set(g, n - 1); hit += 1; }
  }
  return (2 * hit) / (x.length - 1 + y.length - 1);
}

export const SIMILARITY_THRESHOLD = 0.85;

/** 第一作者姓氏：中英文都取第一个词/姓 */
export function firstAuthorSurname(authors) {
  const first = Array.isArray(authors) ? authors[0] : null;
  if (!first) return '';
  const name = typeof first === 'string' ? first : (first.name || first.family || '');
  const s = String(name).trim();
  if (!s) return '';
  // 英文“Given Family”取最后一段；中文姓名取第一个字
  if (/[一-龥]/.test(s)) return s.slice(0, 1);
  const parts = s.split(/[\s,]+/).filter(Boolean);
  return (parts[parts.length - 1] || '').toLowerCase();
}

// ---------- OpenAlex 检索 ----------

function mapWork(w) {
  const authors = (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean);
  const doi = (w.doi || '').replace(/^https?:\/\/doi\.org\//, '');
  const oa = w.open_access || {};
  const best = w.best_oa_location || w.primary_location || {};
  return {
    work_id: w.id || '',
    title: w.title || w.display_name || '',
    authors,
    year: w.publication_year || null,
    venue: w.primary_location?.source?.display_name || w.host_venue?.display_name || '',
    doi,
    url: doi ? `https://doi.org/${doi}` : (w.id || ''),
    abstract: w.abstract_inverted_index ? rebuildAbstract(w.abstract_inverted_index) : '',
    lang: w.language || '',
    cited_by: w.cited_by_count ?? null,
    type: w.type || '',
    is_oa: !!oa.is_oa,
    oa_url: oa.oa_url || best.pdf_url || best.landing_page_url || '',
    source: 'openalex',
  };
}

/** OpenAlex 的摘要是倒排索引，拼回文本 */
function rebuildAbstract(inv) {
  const slots = [];
  for (const [word, positions] of Object.entries(inv)) {
    for (const p of positions) slots[p] = word;
  }
  return slots.filter(Boolean).join(' ').slice(0, 3000);
}

/**
 * 关键词检索。返回 { works, total, query }。
 * 支持中英文；OpenAlex 对中文覆盖有限，中文结果少时由调用方引导去知网。
 */
export async function searchWorks({ query, limit = 10, yearFrom = null, yearTo = null, lang = '' } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new AppError(400, 'EMPTY_QUERY', '请先填写要检索的关键词。');
  const params = new URLSearchParams({ search: q, per_page: String(Math.min(25, Math.max(1, limit))) });
  const filters = [];
  if (yearFrom) filters.push(`from_publication_date:${Number(yearFrom)}-01-01`);
  if (yearTo) filters.push(`to_publication_date:${Number(yearTo)}-12-31`);
  if (lang) filters.push(`language:${lang}`);
  if (filters.length) params.set('filter', filters.join(','));
  if (mailto()) params.set('mailto', mailto());

  const data = await getJson(`https://api.openalex.org/works?${params.toString()}`);
  const works = (data.results || []).map(mapWork).filter((w) => w.title);
  const cjk = works.filter((w) => /[一-龥]/.test(w.title)).length;
  return {
    query: q,
    total: data.meta?.count ?? works.length,
    works,
    // 中文覆盖不足时前端提示“去知网检索后导出”
    zh_coverage_low: /[一-龥]/.test(q) && cjk < 2,
  };
}

/** 单篇详情 */
export async function getWork(workId) {
  const id = String(workId || '').trim();
  if (!id) throw new AppError(400, 'EMPTY', '请提供文献编号。');
  const path = id.replace('https://openalex.org/', '');
  const data = await getJson(`https://api.openalex.org/works/${encodeURIComponent(path)}${mailto() ? `?mailto=${encodeURIComponent(mailto())}` : ''}`);
  if (data.notFound) throw new AppError(404, 'NOT_FOUND', '没有找到这篇文献。');
  return mapWork(data);
}

/** DOI 列表补全（导入用）：逐个查 Crossref，返回条目（不写库） */
export async function lookupDoi(doi) {
  const clean = String(doi || '').trim().replace(/^https?:\/\/doi\.org\//i, '');
  if (!clean) throw new AppError(400, 'EMPTY_DOI', '请提供 DOI。');
  const data = await getJson(`https://api.crossref.org/works/${encodeURIComponent(clean)}?mailto=${encodeURIComponent(mailto() || 'none')}`);
  if (data.notFound) return { found: false, doi: clean };
  const m = data.message || {};
  const authors = (m.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean);
  return {
    found: true,
    doi: clean,
    title: (m.title || [])[0] || '',
    authors,
    year: m.issued?.['date-parts']?.[0]?.[0] || null,
    venue: (m['container-title'] || [])[0] || '',
    abstract: m.abstract ? String(m.abstract).replace(/<[^>]+>/g, '').slice(0, 3000) : '',
    url: m.URL || `https://doi.org/${clean}`,
    source: 'crossref',
  };
}

/**
 * 解析 DOI（权威判断）：向 doi.org 发请求，看它能不能解析到真实页面。
 * 中文期刊的 DOI 大多注册在中文 DOI 机构，不在 Crossref——只看 Crossref 会把它们误判成编造。
 * 假 DOI 会返回 404（已实测 10.9999/fake.2026.001 → 404）。
 */
export async function resolveDoi(doi) {
  const clean = String(doi || '').trim().replace(/^https?:\/\/doi\.org\//i, '');
  if (!clean) return { resolvable: false, doi: clean, status: 0 };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://doi.org/${encodeURIComponent(clean)}`, {
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    // 302/301 说明 DOI 存在并指向真实页面；404 说明不存在
    const location = res.headers.get('location') || '';
    return { resolvable: res.status >= 300 && res.status < 400 && !!location, doi: clean, status: res.status, location };
  } catch (e) {
    // 网络问题不能当成“这个 DOI 是假的”，要单独区分开
    if (e?.name === 'AbortError') return { resolvable: false, doi: clean, status: 0, error: 'timeout' };
    return { resolvable: false, doi: clean, status: 0, error: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * DOI 核验（PRD：verify_doi）。
 * 判断顺序：① doi.org 能不能解析（权威，中英文都适用）② Crossref 补元数据（查得到就更可信）
 * ③ 题名相似度与第一作者姓氏比对（有元数据时）。
 * 返回 { status: 'verified'|'unverified'|'failed', ... }
 */
export async function verifyWork({ doi = '', title = '', authors = [] }) {
  const clean = String(doi || '').trim().replace(/^https?:\/\/doi\.org\//i, '');
  if (clean) {
    const resolved = await resolveDoi(clean);
    // 查不到时先看 Crossref，两处都查不到才判定为失败
    const crossref = await lookupDoi(clean).catch(() => ({ found: false }));

    if (!resolved.resolvable && !crossref.found) {
      if (resolved.error) {
        return { status: 'unverified', method: 'resolve', doi: clean, reason: '核验服务暂时连不上，这条先标成“待核验”，稍后可以再点一次核验。' };
      }
      return {
        status: 'failed', method: 'resolve', doi: clean,
        reason: `这个 DOI 解析不到真实页面（doi.org 返回 ${resolved.status}）。可能是编造的或抄错了，请回到文献原文核对。`,
      };
    }

    // 有题名时做一次相似度比对，防止 DOI 与题名张冠李戴
    const known = crossref.found ? crossref.title : '';
    let similarity = null;
    if (known && title) {
      similarity = Number(titleSimilarity(title, known).toFixed(3));
      if (similarity < SIMILARITY_THRESHOLD) {
        return {
          status: 'unverified', method: 'crossref', doi: clean, record: crossref, similarity,
          reason: `DOI 能解析，但 Crossref 里的题名和你的不一致（相似度 ${similarity.toFixed(2)}）：那边是「${known}」。请核对是不是抄错了 DOI。`,
        };
      }
    }
    const surnameOk = (crossref.found && authors?.length && crossref.authors?.length)
      ? firstAuthorSurname(authors) === firstAuthorSurname(crossref.authors)
      : null;
    return {
      status: 'verified',
      method: crossref.found ? 'doi+crossref' : 'doi',
      doi: clean,
      resolved_to: resolved.location || '',
      record: crossref.found ? crossref : null,
      similarity,
      first_author_match: surnameOk,
      reason: crossref.found
        ? `DOI 已解析到 ${resolved.location ? new URL(resolved.location).hostname : '真实页面'}，Crossref 记录：「${crossref.title}」（${crossref.year || '年份不详'}）。`
        : `DOI 已解析到 ${new URL(resolved.location).hostname}（这个 DOI 不在 Crossref 注册，属于中文 DOI 机构，按解析结果判定为真实）。`,
    };
  }

  // 没有 DOI：用题名到 OpenAlex 反查
  if (!title) return { status: 'unverified', method: 'none', reason: '这条文献没有 DOI，也没有题名，无法核验。请补上 DOI 或从检索结果里添加。' };
  const found = await searchWorks({ query: title, limit: 3 });
  const best = found.works
    .map((w) => ({ w, sim: titleSimilarity(title, w.title) }))
    .sort((a, b) => b.sim - a.sim)[0];
  if (!best || best.sim < SIMILARITY_THRESHOLD) {
    return { status: 'failed', method: 'openalex', reason: `按题名没有找到匹配的文献（最接近的相似度只有 ${best ? best.sim.toFixed(2) : '0'}），这条可能是模型编造的，请换一条。` };
  }
  const surnameOk = authors?.length ? firstAuthorSurname(authors) === firstAuthorSurname(best.w.authors) : null;
  if (surnameOk === false) {
    return {
      status: 'unverified', method: 'openalex', record: best.w, similarity: Number(best.sim.toFixed(3)), first_author_match: false,
      reason: `找到了题名相近的文献，但第一作者对不上（你的是「${(Array.isArray(authors) ? authors[0] : '') || '未填'}」，查到的是「${best.w.authors[0] || '未知'}」）。请核对。`,
    };
  }
  return {
    status: 'verified', method: 'openalex', record: best.w, similarity: Number(best.sim.toFixed(3)), first_author_match: surnameOk,
    reason: `按题名核验通过：${best.w.title}（${best.w.year || '年份不详'}）。`,
  };
}
