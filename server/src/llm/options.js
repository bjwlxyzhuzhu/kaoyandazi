// 选项协议解析（PRD 4.2、7.3）：正文 + 末尾一个 ```json 代码块。
// 解析失败时只返回正文，options 为 null（前端只显示正文和自由输入框），绝不把 JSON 当正文给学生看。

const FENCE = /```json\s*([\s\S]*?)(```|$)/gi;

function tryParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* 继续尝试 */ }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch { /* 放弃 */ }
  }
  return null;
}

/** 校验并规范化选项块；不合规返回 null */
export function normalizeOptions(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.options)) return null;
  const options = raw.options
    .filter((o) => o && typeof o.label === 'string' && o.label.trim())
    .slice(0, 5)
    .map((o, i) => {
      const item = { key: typeof o.key === 'string' && o.key.trim() ? o.key.trim().slice(0, 4) : String.fromCharCode(65 + i), label: o.label.trim().slice(0, 80) };
      if (typeof o.hint === 'string' && o.hint.trim()) item.hint = o.hint.trim().slice(0, 120);
      return item;
    });
  if (options.length < 2) return null;
  return {
    options,
    multi: raw.multi === true,
    free_text: raw.free_text !== false,
    stage_done: raw.stage_done === true,
    artifact: raw.artifact ?? null,
  };
}

/**
 * 把模型回复拆成 { body, block }。
 * 顺序：```json 代码块 → 末尾裸 JSON（以 {"options" 开头）→ 无选项。
 */
export function splitReply(text) {
  const src = String(text || '');
  let lastMatch = null;
  for (const m of src.matchAll(FENCE)) lastMatch = m;
  if (lastMatch) {
    const body = (src.slice(0, lastMatch.index) + src.slice(lastMatch.index + lastMatch[0].length)).trim();
    return { body, block: normalizeOptions(tryParse(lastMatch[1])) };
  }
  const bare = src.search(/\{\s*"options"\s*:/);
  if (bare >= 0) {
    return { body: src.slice(0, bare).trim(), block: normalizeOptions(tryParse(src.slice(bare))) };
  }
  return { body: src.trim(), block: null };
}
