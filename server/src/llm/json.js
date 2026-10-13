// 结构化输出的稳健性（PRD 7.3）：优先 response_format json_object；失败重试1次；仍失败则报错，不写入脏数据。
import { getLlmConfig } from './settings.js';
import { streamChat } from './client.js';
import { recordCall } from './keys.js';
import { AppError } from '../errors.js';

/** 解析顺序：直接解析 → 去掉代码块 → 截取第一个 { 到最后一个 } */
export function parseJsonLoose(text) {
  const s = String(text || '').trim();
  const attempts = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) attempts.push(fence[1]);
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) attempts.push(s.slice(a, b + 1));
  const a2 = s.indexOf('[');
  const b2 = s.lastIndexOf(']');
  if (a2 >= 0 && b2 > a2) attempts.push(s.slice(a2, b2 + 1));
  for (const t of attempts) {
    try { return JSON.parse(t); } catch { /* 继续尝试 */ }
  }
  return null;
}

/**
 * 生成结构化 JSON。useReason 为 true 时优先用推理模型，不支持时自动回退对话模型。
 * 返回 { data, model, usage, source }
 */
export async function generateJson({ user, moduleId, purpose, prompt, key, source, useReason = false, maxTokens = 4000, temperature = 0.4 }) {
  const llm = getLlmConfig();
  const model = (useReason && llm.reasonModel) ? llm.reasonModel : llm.chatModel;
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const messages = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: attempt === 0 ? prompt.user : `${prompt.user}\n\n（提醒：只输出一个合法的 JSON 对象，不要写任何解释文字。）` },
    ];
    try {
      const out = await streamChat({ baseUrl: llm.baseUrl, key, model, messages, temperature, maxTokens, source, jsonMode: true });
      const data = parseJsonLoose(out.content);
      recordCall({ userId: user.id, kind: moduleId, purpose, model: out.model, source, usage: out.usage, error: out.usage?.estimated ? 'usage_estimated' : null });
      if (data) return { data, model: out.model, usage: out.usage, source };
      lastError = new AppError(502, 'BAD_JSON', '模型这次没有返回合规的内容，请重试一次。');
    } catch (e) {
      lastError = e;
      recordCall({ userId: user.id, kind: moduleId, purpose, model, source, usage: null, ok: false, error: e.code || 'LLM_FAILED' });
      // Key 或额度类错误不重试
      if (['NEED_USER_KEY', 'QUOTA_DAILY', 'QUOTA_MONTHLY', 'USER_KEY_INVALID', 'USER_NO_BALANCE', 'RATE_LIMITED', 'NETWORK'].includes(e.code)) throw e;
    }
  }
  throw lastError || new AppError(502, 'BAD_JSON', '生成失败，请重试一次。');
}
