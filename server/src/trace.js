// AI 产物的确认 / 修改 / 核验留痕（PRD M14“AI使用与核验说明”的数据来源）
// 生成时记下 AI 原稿的指纹；学生确认时比对：一致记 confirm，不同记 modify。
import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.js';
import { nowLocal } from './time.js';

const fp = (data) => crypto.createHash('sha256').update(JSON.stringify(data ?? null)).digest('hex').slice(0, 24);

/** AI 生成了一份草稿（画像、方案……），记下指纹 */
export function rememberDraft(userId, type, data) {
  setSetting(`ai_draft.${type}.${userId}`, fp(data));
}

export function logAction(userId, objectType, objectId, action) {
  db.prepare('INSERT INTO ai_actions(user_id, object_type, object_id, action, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(userId, objectType, objectId ?? null, action, nowLocal());
}

/**
 * 学生确认了一份 AI 草稿：与记下的指纹比对，记 confirm 或 modify。
 * 没有对应草稿（学生完全手写）时不记，免得把手写内容算成“AI 产物”。
 */
export function recordAdoption(userId, type, objectId, finalData) {
  const key = `ai_draft.${type}.${userId}`;
  const draft = getSetting(key);
  if (!draft) return null;
  const action = draft === fp(finalData) ? 'confirm' : 'modify';
  logAction(userId, type, objectId, action);
  setSetting(key, '');
  return action;
}
