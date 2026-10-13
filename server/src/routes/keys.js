// 学生的 Key、模块权限、额度与用量（PRD 5.4、5.5）
import { Router } from 'express';
import { db } from '../db.js';
import { encrypt } from '../crypto.js';
import { AppError } from '../errors.js';
import { requireStudent, rateLimit } from '../auth.js';
import { allModuleTiers, noKeyFeatures } from '../registry.js';
import { getLlmConfig } from '../llm/settings.js';
import { listModels } from '../llm/client.js';
import { userOwnKey, quotaStatus } from '../llm/keys.js';
import { publicMe } from './account.js';
import { CURRENT_STAGE } from '../stage.js';

const r = Router();
const keyTestLimit = rateLimit({ windowMs: 60 * 1000, max: 10, key: (req) => `keytest:${req.user?.id}` });

const reload = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function readKey(req) {
  const fromBody = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  return fromBody || String(req.get('X-User-Key') || '').trim();
}

function checkKeyShape(key) {
  if (!key) throw new AppError(400, 'NO_KEY', '请先粘贴你的 API Key。');
  if (key.length < 8 || key.length > 300 || /\s/.test(key)) throw new AppError(400, 'BAD_KEY', 'Key 的格式看起来不对，请重新复制（不要带空格或换行）。');
}

/** 测试连通：用学生的 Key 拉取模型列表；Key 用完即弃 */
r.post('/me/key/test', requireStudent, keyTestLimit, async (req, res) => {
  const key = readKey(req);
  checkKeyShape(key);
  const c = getLlmConfig();
  const models = await listModels({ baseUrl: c.baseUrl, key, source: 'user' });
  res.json({ ok: true, models, mock: c.mock });
});

/** 保存：默认只保存在浏览器；勾选“在服务器上加密保存”才入库 */
r.put('/me/key', requireStudent, (req, res) => {
  const key = readKey(req);
  checkKeyShape(key);
  const onServer = req.body?.save_on_server === true;
  db.prepare('UPDATE users SET key_enc = ? WHERE id = ?').run(onServer ? encrypt(key) : null, req.user.id);
  res.json({ me: publicMe(reload(req.user.id)) });
});

r.delete('/me/key', requireStudent, (req, res) => {
  db.prepare('UPDATE users SET key_enc = NULL WHERE id = ?').run(req.user.id);
  res.json({ me: publicMe(reload(req.user.id)) });
});

r.put('/me/key-preference', requireStudent, (req, res) => {
  const v = req.body?.use_own_key_basic === true ? 1 : 0;
  db.prepare('UPDATE users SET use_own_key_basic = ? WHERE id = ?').run(v, req.user.id);
  res.json({ me: publicMe(reload(req.user.id)) });
});

/** 模块权限表：每行的当前状态 */
r.get('/me/modules', requireStudent, (req, res) => {
  const hasKey = !!userOwnKey(req.user, req.get('X-User-Key'));
  const q = quotaStatus(req.user);
  const basicBlocked = q.daily_exhausted || q.monthly_blocked;
  const usesOwnForBasic = !!req.user.use_own_key_basic && hasKey;
  const modules = allModuleTiers().map((m) => {
    let status = 'available';
    if (m.tier === 'advanced' && !hasKey) status = 'need_key';
    if (m.tier === 'basic' && basicBlocked && !usesOwnForBasic) status = 'quota_exhausted';
    return {
      id: m.id, name: m.name, module: m.module, tier: m.tier, note: m.note, route: m.route,
      open: m.stage <= CURRENT_STAGE, status,
    };
  });
  res.json({ modules, no_key: noKeyFeatures, has_key: hasKey });
});

r.get('/me/quota', requireStudent, (req, res) => {
  res.json(quotaStatus(req.user));
});

/** 我的用量：只统计学生自己的 Key */
r.get('/me/usage', requireStudent, (req, res) => {
  const rows = db.prepare(`SELECT kind, COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens
    FROM ai_calls WHERE user_id = ? AND key_source = 'user' AND ok = 1 GROUP BY kind ORDER BY calls DESC`).all(req.user.id);
  res.json({ by_module: rows });
});

export default r;
