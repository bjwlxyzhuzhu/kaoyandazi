// M9 长期记忆：整理器“拾光”每2条消息整理一次；上限60条；敏感信息不记
import { db } from './db.js';
import { nowLocal } from './time.js';
import { AppError } from './errors.js';
import { generateJson } from './llm/json.js';
import { resolveKey } from './llm/keys.js';
import { getAgent, displayName } from './registry.js';
import { renderPrompt, commonRules, verifiedMaterials, userBrief } from './prompts.js';

export const MEMORY_LIMIT = 60;
export const MAX_ADD = 3;

/** 明确不许记的内容（PRD 7.9 / M9）：在写入前做一次兜底过滤 */
const SENSITIVE = [
  /身份证|身份号|\d{15,18}[^\d]?(号|证)?/,
  /家庭住址|住址|门牌|详细地址|住在|居住地|小区|宿舍楼|公寓|幢|栋\s*\d/,
  /(手机|电话|联系方式|微信|QQ)\s*[:：]?\s*\d{5,}/,
  /月收入|家庭收入|家里.*(多少钱|收入|经济)|贫困|低保|助学贷款/,
  /抑郁症|焦虑症|确诊|病历|吃药|精神科|自残|自杀|伤害自己/,
];

export function isSensitive(text) {
  const t = String(text || '');
  if (/(自我|自伤|自杀|伤害自己|不想活|活着没意思)/.test(t)) return { blocked: true, reason: 'crisis' };
  return { blocked: SENSITIVE.some((re) => re.test(t)), reason: 'privacy' };
}

export function listMemories(userId, { limit = MEMORY_LIMIT } = {}) {
  return db.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit);
}

export function memoryCount(userId) {
  return db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').get(userId).n;
}

/** 学生手动添加 */
export function addMemory(userId, content, category = '其他') {
  const text = String(content || '').trim().slice(0, 200);
  if (!text) throw new AppError(400, 'EMPTY', '请填写要记住的内容。');
  if (isSensitive(text).blocked) throw new AppError(400, 'SENSITIVE', '这类信息（隐私或健康）平台不记录，请换一条。');
  if (memoryCount(userId) >= MEMORY_LIMIT) throw new AppError(400, 'FULL', `记忆最多保存 ${MEMORY_LIMIT} 条，请先删掉一些。`);
  const info = db.prepare('INSERT INTO memories(user_id, content, category, created_at) VALUES(?, ?, ?, ?)')
    .run(userId, text, String(category || '其他').slice(0, 20), nowLocal());
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(info.lastInsertRowid);
}

export function deleteMemory(userId, id) {
  const info = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(Number(id), userId);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '没有这条记忆。');
}

/** 记忆进提示词的文本 */
export function memoryText(userId) {
  const rows = listMemories(userId, { limit: 40 });
  if (!rows.length) return '（还没有长期记忆）';
  return rows.slice().reverse().map((m) => `- [${m.category || '其他'}] ${m.content}`).join('\n');
}

/** 该学生在这一类对话里已经发过几条消息（用来判断是否该整理记忆） */
export function userMessageCount(userId, kind) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM messages m
    JOIN conversations c ON c.id = m.conv_id
    WHERE c.user_id = ? AND c.kind = ? AND m.role = 'user'`).get(userId, kind);
  return row?.n || 0;
}

/**
 * 整理记忆（附录B.8）。返回 { added, removed, skipped }。
 * 出错不抛出：记不上不该影响学生和导师的对话。
 */
export async function organizeMemory({ user, kind, agentKey, recent }) {
  const keyInfo = safeResolveKey(user);
  if (!keyInfo) return { added: 0, removed: 0, skipped: 'no_key' };
  const agent = getAgent('memory');
  const prompt = {
    system: renderPrompt('memory', {
      ...userBrief(user),
      导师显示名: displayName(agent),
      共同规则: commonRules(),
      已核实资料: verifiedMaterials(),
      已有记忆: memoryText(user.id),
      记忆条数: memoryCount(user.id),
      上限: MEMORY_LIMIT,
    }),
    user: `【最新对话】\n${recent}\n\n请按 JSON 格式输出需要新增和删除的记忆。`,
  };
  try {
    const { data } = await generateJson({
      user, moduleId: 'M9_memory', purpose: '记忆整理', prompt,
      key: keyInfo.key, source: keyInfo.source, maxTokens: 800, temperature: 0.2,
    });
    return applyMemoryUpdate(user.id, data);
  } catch (e) {
    console.warn('[记忆] 整理失败：', e?.code || e?.message);
    return { added: 0, removed: 0, skipped: e?.code || 'failed' };
  }
}

function safeResolveKey(user) {
  try {
    return resolveKey(user, 'M9_memory', null);
  } catch {
    return null;
  }
}

/** 把整理器的输出写库：最多加3条、过滤敏感信息、超上限时删掉最旧的 */
export function applyMemoryUpdate(userId, data) {
  let added = 0;
  let removed = 0;
  const removeIds = Array.isArray(data?.remove_ids) ? data.remove_ids.map(Number).filter(Number.isInteger) : [];
  for (const id of removeIds.slice(0, 10)) {
    const info = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, userId);
    if (info.changes) removed += 1;
  }
  const adds = Array.isArray(data?.add) ? data.add.slice(0, MAX_ADD) : [];
  for (const item of adds) {
    const content = String(item?.content || '').trim().slice(0, 200);
    if (!content) continue;
    if (isSensitive(content).blocked) continue;          // 敏感信息直接丢弃
    const dupe = db.prepare('SELECT id FROM memories WHERE user_id = ? AND content = ?').get(userId, content);
    if (dupe) continue;
    // 超上限时先删最旧的，保证“每人上限60条”
    if (memoryCount(userId) >= MEMORY_LIMIT) {
      const oldest = db.prepare('SELECT id FROM memories WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(userId);
      if (oldest) db.prepare('DELETE FROM memories WHERE id = ?').run(oldest.id);
    }
    const category = ['目标', '承诺', '困难', '偏好', '进展', '状态', '其他'].includes(item?.category) ? item.category : '其他';
    db.prepare('INSERT INTO memories(user_id, content, category, created_at) VALUES(?, ?, ?, ?)')
      .run(userId, content, category, nowLocal());
    added += 1;
  }
  return { added, removed };
}

/** 教师端只看得到条数，看不到内容 */
export function memoryStats(userId) {
  const row = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM memories WHERE user_id = ?').get(userId);
  return { count: row?.n || 0, last_at: row?.last || null };
}
