// 平台模型配置：后台配置优先，环境变量兜底（PRD 5.3）
import { config } from '../config.js';
import { getSetting, setSetting } from '../db.js';
import { encrypt, decrypt, maskKey } from '../crypto.js';

/** 接口地址为 mock 时使用内置模拟模型（无真实 Key 时用于开发与自测，界面会明确标注） */
export const isMock = (baseUrl) => String(baseUrl || '').trim().toLowerCase() === 'mock';

export function getLlmConfig() {
  const enc = getSetting('llm.platform_key_enc');
  const fromSettings = enc ? decrypt(enc) : '';
  const platformKey = fromSettings || config.llm.platformKey;
  const num = (k, d) => {
    const v = getSetting(k);
    return v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v);
  };
  const baseUrl = (getSetting('llm.base_url') || config.llm.baseUrl || '').trim().replace(/\/+$/, '');
  return {
    baseUrl,
    mock: isMock(baseUrl),
    chatModel: getSetting('llm.chat_model') || config.llm.chatModel || (isMock(baseUrl) ? 'mock-chat' : ''),
    reasonModel: getSetting('llm.reason_model') || config.llm.reasonModel || '',
    platformKey,
    platformKeySource: fromSettings ? 'settings' : config.llm.platformKey ? 'env' : 'none',
    basicDailyLimit: num('llm.basic_daily_limit', config.llm.basicDailyLimit),
    monthlyTokenBudget: num('llm.monthly_token_budget', config.llm.monthlyTokenBudget),
    demoKey: config.llm.demoKey,
  };
}

/** 教师端可见的配置（Key 只显示末4位） */
export function publicLlmConfig() {
  const c = getLlmConfig();
  return {
    base_url: c.baseUrl,
    mock: c.mock,
    chat_model: c.chatModel,
    reason_model: c.reasonModel,
    platform_key_mask: c.platformKey ? maskKey(c.platformKey) : '',
    platform_key_source: c.platformKeySource,
    basic_daily_limit: c.basicDailyLimit,
    monthly_token_budget: c.monthlyTokenBudget,
  };
}

export function updateLlmConfig(body) {
  if (typeof body.base_url === 'string') setSetting('llm.base_url', body.base_url.trim());
  if (typeof body.chat_model === 'string') setSetting('llm.chat_model', body.chat_model.trim());
  if (typeof body.reason_model === 'string') setSetting('llm.reason_model', body.reason_model.trim());
  if (body.basic_daily_limit !== undefined) {
    const n = Math.max(0, Math.floor(Number(body.basic_daily_limit) || 0));
    setSetting('llm.basic_daily_limit', String(n));
  }
  if (body.monthly_token_budget !== undefined) {
    const n = Math.max(0, Math.floor(Number(body.monthly_token_budget) || 0));
    setSetting('llm.monthly_token_budget', String(n));
  }
  if (typeof body.platform_key === 'string' && body.platform_key.trim()) {
    setSetting('llm.platform_key_enc', encrypt(body.platform_key.trim()));
  }
  if (body.clear_platform_key === true) setSetting('llm.platform_key_enc', null);
  return publicLlmConfig();
}
