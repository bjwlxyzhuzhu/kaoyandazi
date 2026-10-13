// 两级 Key 的选择与额度控制（PRD 5.1—5.5）
import { db, getSettingJson, setSetting } from '../db.js';
import { decrypt } from '../crypto.js';
import { nowLocal, todayLocal, monthLocal } from '../time.js';
import { moduleTier } from '../registry.js';
import { getLlmConfig } from './settings.js';
import { AppError, MSG } from '../errors.js';

/** 学生自己的 Key：优先用本次请求头 X-User-Key，其次用服务器上加密保存的 Key */
export function userOwnKey(user, headerKey) {
  const h = typeof headerKey === 'string' ? headerKey.trim() : '';
  if (h) return h;
  return user.key_enc ? decrypt(user.key_enc) : '';
}

// ---------- 每日基础额度 ----------
export function dailyLimitFor(userId) {
  const c = getLlmConfig();
  const overrides = getSettingJson('quota_overrides', {});
  const o = overrides[String(userId)];
  if (o && o.until && todayLocal() <= o.until && Number.isFinite(Number(o.limit))) return Number(o.limit);
  // 评委测试账号单独一个每日上限（PRD M17：两类 Key 都设调用上限）
  if (db.prepare('SELECT is_demo FROM users WHERE id = ?').get(userId)?.is_demo) return Number(getSettingJson('demo.daily_limit', 40)) || 40;
  return c.basicDailyLimit;
}

export function dailyUsed(userId) {
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ? AND key_source IN ('platform', 'demo') AND ok = 1 AND created_at LIKE ?",
  ).get(userId, `${todayLocal()}%`);
  return row.n;
}

/** 教师为个别学生临时调整额度（until 当天及以前有效） */
export function setQuotaOverride(userId, limit, until) {
  const overrides = getSettingJson('quota_overrides', {});
  if (limit === null) delete overrides[String(userId)];
  else overrides[String(userId)] = { limit: Math.max(0, Math.floor(Number(limit) || 0)), until: until || todayLocal() };
  setSetting('quota_overrides', overrides);
}

// ---------- 班级月度预算 ----------
export function monthlyUsage() {
  const c = getLlmConfig();
  const row = db.prepare(
    `SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t FROM ai_calls
     WHERE key_source = 'platform' AND created_at LIKE ?`,
  ).get(`${monthLocal()}%`);
  const budget = c.monthlyTokenBudget;
  const ratio = budget > 0 ? row.t / budget : 0;
  return { used: row.t, budget, ratio, warning: budget > 0 && ratio >= 0.8, blocked: budget > 0 && ratio >= 1 };
}

export function quotaStatus(user) {
  const limit = dailyLimitFor(user.id);
  const used = dailyUsed(user.id);
  const m = monthlyUsage();
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    daily_exhausted: used >= limit,
    monthly_blocked: m.blocked,
  };
}

/**
 * 决定本次调用使用哪一把 Key。
 * 返回 { key, source: 'platform'|'user'|'demo', tier }；不满足条件时抛出带中文提示的 AppError。
 */
export function resolveKey(user, moduleId, headerKey) {
  const tier = moduleTier(moduleId);
  if (!tier) throw new AppError(400, 'UNKNOWN_MODULE', '未知的模块。');
  const c = getLlmConfig();
  const own = userOwnKey(user, headerKey);
  // 模拟模型不需要平台 Key
  const platformKey = c.mock ? 'mock-platform' : c.platformKey;

  if (tier === 'advanced') {
    if (own) return { key: own, source: 'user', tier };
    if (user.is_demo && c.demoKey) {
      checkDaily(user);
      return { key: c.demoKey, source: 'demo', tier };
    }
    throw new AppError(403, 'NEED_USER_KEY', MSG.NEED_USER_KEY, { module: moduleId });
  }

  // 基础模块：教师不受学生额度限制
  if (user.role === 'teacher') {
    if (!platformKey || !c.baseUrl) throw new AppError(503, 'PLATFORM_NOT_CONFIGURED', MSG.PLATFORM_NOT_CONFIGURED);
    return { key: platformKey, source: 'platform', tier };
  }
  if (user.use_own_key_basic && own) return { key: own, source: 'user', tier };
  if (!platformKey || !c.baseUrl) throw new AppError(503, 'PLATFORM_NOT_CONFIGURED', MSG.PLATFORM_NOT_CONFIGURED);
  if (monthlyUsage().blocked) throw new AppError(429, 'QUOTA_MONTHLY', MSG.QUOTA_MONTHLY);
  checkDaily(user);
  return { key: platformKey, source: 'platform', tier };
}

function checkDaily(user) {
  if (dailyUsed(user.id) >= dailyLimitFor(user.id)) throw new AppError(429, 'QUOTA_DAILY', MSG.QUOTA_DAILY);
}

/** 每一次 AI 调用都留痕（PRD M14：AI使用与核验说明的数据来源） */
export function recordCall({ userId, kind, purpose, model, source, usage, toolCalls = 0, ok = true, error = null }) {
  db.prepare(`INSERT INTO ai_calls(user_id, kind, purpose, model, key_source, prompt_tokens, completion_tokens, tool_calls, ok, error, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    userId ?? null, kind, purpose, model || '', source,
    usage?.prompt_tokens || 0, usage?.completion_tokens || 0, toolCalls, ok ? 1 : 0, error, nowLocal(),
  );
}
