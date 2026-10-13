// 检索服务（PRD 5.7）：可插拔。①中转站自带的检索模型 ②第三方中文搜索接口（博查）③都没有时禁用。
// 无论哪条路径，返回的每条事实都必须带来源链接与证据等级。
import { config } from '../config.js';
import { AppError } from '../errors.js';

export const LEVELS = ['官方', '院校', '经验帖', 'AI推断'];

export function searchProvider() {
  const p = String(config.search.provider || 'none').toLowerCase();
  if (p === 'bocha' && config.search.bochaKey) return 'bocha';
  if (p === 'relay' && config.search.relayModel) return 'relay';
  return 'none';
}

export function searchEnabled() {
  return searchProvider() !== 'none';
}

/** 按域名推断证据等级（官方 > 院校 > 经验帖） */
export function guessLevel(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return 'AI推断';
  if (/(gov\.cn|moe\.gov\.cn|yz\.chsi\.com\.cn|chsi\.com\.cn|neea\.edu\.cn)/.test(u)) return '官方';
  if (/\.edu\.cn|\.ac\.cn/.test(u)) return '院校';
  return '经验帖';
}

const TIMEOUT_MS = 20_000;

async function fetchJson(url, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw searchError(res.status, text);
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError(502, 'SEARCH_FAILED', '检索服务返回了看不懂的内容，请稍后再试。');
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(502, 'SEARCH_FAILED', '检索服务暂时不可用，请稍后再试。');
  } finally {
    clearTimeout(timer);
  }
}

/** 把检索服务的错误翻译成教师/学生看得懂的中文 */
function searchError(status, bodyText) {
  const t = String(bodyText || '').toLowerCase();
  if (status === 401 || status === 403) {
    if (/money|quota|balance|余额|额度|package/.test(t)) {
      return new AppError(402, 'SEARCH_NO_QUOTA',
        '博查账号的额度用完了：请到博查开放平台充值或领取免费额度，学生可以先把官网链接贴给我读。');
    }
    return new AppError(401, 'SEARCH_BAD_KEY', '博查的 API Key 无效，请老师在教师后台或 .env 里更新。');
  }
  if (status === 429) return new AppError(429, 'SEARCH_RATE_LIMITED', '检索请求太频繁，请稍后再试。');
  return new AppError(502, 'SEARCH_FAILED', `检索服务返回错误（${status}），请稍后再试。`);
}

/**
 * web_search：返回 [{ title, url, snippet, level }]
 * 未配置检索服务时抛出带中文提示的错误，调用方据此降级为“引导学生贴官网链接”。
 */
export async function webSearch(query, { site, count = 8 } = {}) {
  const provider = searchProvider();
  if (provider === 'none') {
    throw new AppError(503, 'SEARCH_DISABLED',
      '平台暂时没有接入联网检索。请把你查到的官网链接贴给我，我来帮你读。');
  }
  if (provider === 'bocha') {
    const data = await fetchJson(`${config.search.bochaBaseUrl}/web-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.search.bochaKey}` },
      body: JSON.stringify({ query: site ? `${query} site:${site}` : query, count, summary: true }),
    });
    const pages = data?.data?.webPages?.value || data?.webPages?.value || [];
    return pages.slice(0, count).map((p) => ({
      title: String(p.name || '').slice(0, 200),
      url: String(p.url || ''),
      snippet: String(p.summary || p.snippet || '').slice(0, 600),
      level: guessLevel(p.url),
    }));
  }
  // relay：由中转站上带检索能力的模型回答，返回其文本与引用
  throw new AppError(503, 'SEARCH_DISABLED', '中转站检索还没有配置好，请先贴官网链接给我读。');
}

// ---------- fetch_url（单页，不递归；兼容 GBK；防 SSRF） ----------

function isBlockedHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  // IPv6 本机
  if (h === '::1' || h === '[::1]') return true;
  // IPv4 私有与保留段
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;   // 链路本地（云元数据）
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
  }
  return false;
}

export function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    throw new AppError(400, 'BAD_URL', '这个链接看不懂，请确认是不是完整的网址。');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError(400, 'BAD_URL', '只支持 http 或 https 的网页链接。');
  }
  if (isBlockedHost(u.hostname)) {
    throw new AppError(400, 'SSRF_BLOCKED', '这个地址指向本机或内网，出于安全考虑不能抓取。请换成公开的官网链接。');
  }
  return u;
}

function decodeBody(buf, contentType) {
  const ct = String(contentType || '').toLowerCase();
  let charset = (ct.match(/charset=([\w-]+)/) || [])[1] || '';
  if (!charset) {
    // 中文站点常见 GB2312/GBK 且不带 charset，先按 utf-8 试，出现替换字符再回退
    const asUtf8 = new TextDecoder('utf-8').decode(buf);
    return asUtf8.includes('�') ? new TextDecoder('gbk').decode(buf) : asUtf8;
  }
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n')
    .trim();
}

/** 抓取单页正文，最多 8000 字 */
export async function fetchUrl(raw) {
  const u = assertPublicUrl(raw);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(u, {
      signal: ctrl.signal,
      redirect: 'follow',
      // 请求头只能用 ASCII 字符
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ShanhaiWenzhi/0.1; education)', Accept: 'text/html,application/xhtml+xml' },
    });
  } catch {
    throw new AppError(504, 'FETCH_FAILED', '这个网页打不开，请确认链接是否有效。');
  } finally {
    clearTimeout(timer);
  }
  // 重定向后再次校验，避免跳到内网
  if (res.url && res.url !== String(u)) assertPublicUrl(res.url);
  if (!res.ok) throw new AppError(502, 'FETCH_FAILED', `这个网页返回 ${res.status}，打不开。请换成别的链接。`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 3 * 1024 * 1024) throw new AppError(400, 'TOO_LARGE', '这个网页太大了，换个页面再试。');
  const html = decodeBody(buf, res.headers.get('content-type'));
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  const finalUrl = res.url || String(u);
  return {
    url: finalUrl,
    title: titleMatch ? htmlToText(titleMatch[1]) : '',
    text: htmlToText(html).slice(0, 8000),
    level: guessLevel(finalUrl),
  };
}

// ---------- 每日检索限额（按人） ----------
export function searchDailyLimit() {
  return config.search.dailyLimitPerUser;
}
