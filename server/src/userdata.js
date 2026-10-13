// 本人数据的导出与清除（PRD 第9章 M1：GET /me/export、DELETE /me；M19 一键删除分身）
import { db } from './db.js';

/** 所有带 user_id 列的表（运行时从库里读，表结构变了也不会漏） */
export function userTables() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map((r) => r.name)
    .filter((t) => db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'user_id'));
}

/** 导出时不给出去的列：密码哈希、加密 Key */
const HIDDEN = new Set(['pw_hash', 'key_enc']);

export function exportUserData(userId) {
  const out = {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  out.users = [Object.fromEntries(Object.entries(user || {}).filter(([k]) => !HIDDEN.has(k)))];
  for (const t of userTables()) {
    if (t === 'users') continue;
    out[t] = db.prepare(`SELECT * FROM ${t} WHERE user_id = ?`).all(userId);
  }
  out.messages = db.prepare('SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conv_id WHERE c.user_id = ?').all(userId);
  out.group_messages = db.prepare('SELECT g.* FROM group_messages g JOIN group_sessions s ON s.id = g.session_id WHERE s.user_id = ?').all(userId);
  return out;
}

/** 删除一个或多个用户的全部数据（事务）；返回每张表删了多少行 */
export function purgeUsers(ids) {
  if (!ids.length) return {};
  const ph = ids.map(() => '?').join(',');
  const counts = {};
  db.exec('BEGIN');
  try {
    const add = (t, n) => { if (n) counts[t] = (counts[t] || 0) + n; };
    add('messages', db.prepare(`DELETE FROM messages WHERE conv_id IN (SELECT id FROM conversations WHERE user_id IN (${ph}))`).run(...ids).changes);
    add('group_messages', db.prepare(`DELETE FROM group_messages WHERE session_id IN (SELECT id FROM group_sessions WHERE user_id IN (${ph}))`).run(...ids).changes);
    // 互评没有 user_id 列：本人评别人的、别人评本人作业的都要删
    add('peer_reviews', db.prepare(`DELETE FROM peer_reviews WHERE reviewer_id IN (${ph}) OR submission_id IN (SELECT id FROM submissions WHERE user_id IN (${ph}))`).run(...ids, ...ids).changes);
    for (const t of userTables()) {
      if (t === 'users') continue;
      add(t, db.prepare(`DELETE FROM ${t} WHERE user_id IN (${ph})`).run(...ids).changes);
    }
    add('users', db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...ids).changes);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return counts;
}
