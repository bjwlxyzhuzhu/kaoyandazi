// M18 导师团编排（PRD 7.5、附录B.12—B.13）：司南选人 → 导师依次流式发言 → 司南总结
import fs from 'node:fs';
import path from 'node:path';
import { SHARED_DIR } from './config.js';
import { db } from './db.js';
import { nowLocal, todayLocal, addDays } from './time.js';
import { AppError } from './errors.js';
import { getAgent, displayName, companions, resolvePersona, agents } from './registry.js';

const agentsInGroup = (g) => agents.filter((a) => a.group === g && !a.worker);
import { renderPrompt, commonRules, verifiedMaterials, userBrief } from './prompts.js';
import { generateJson } from './llm/json.js';
import { memoryText, isSensitive } from './memory.js';
import { currentStation, getStation, stationMentors } from './stations.js';

const modesFile = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'group-modes.json'), 'utf8'));
export const GROUP_MODES = modesFile.modes;
export const MAX_ROUNDS = modesFile.max_rounds || 10;
export const MAX_SPEAKERS = modesFile.max_speakers_per_round || { basic: 2, advanced: 3 };
export const MENTOR_MEMORY_LIMIT = 30;

export function getMode(key) {
  return GROUP_MODES.find((m) => m.key === key) || null;
}

// ---------- 导师级记忆（7.7） ----------

export function mentorMemoryText(userId, mentorKey, limit = 20) {
  const rows = db.prepare('SELECT content FROM mentor_student_memory WHERE user_id = ? AND mentor_key = ? ORDER BY id DESC LIMIT ?')
    .all(userId, mentorKey, limit);
  if (!rows.length) return '（还没有）';
  return rows.slice().reverse().map((r) => `- ${r.content}`).join('\n');
}

export function mentorMemoryCount(userId, mentorKey) {
  return db.prepare('SELECT COUNT(*) AS n FROM mentor_student_memory WHERE user_id = ? AND mentor_key = ?').get(userId, mentorKey).n;
}

/** 写入导师级记忆：过滤敏感信息、去重、每人每导师上限30条 */
export function applyMentorMemory(userId, mentorKey, data) {
  let added = 0;
  let removed = 0;
  for (const id of (Array.isArray(data?.remove_ids) ? data.remove_ids : []).slice(0, 10)) {
    const info = db.prepare('DELETE FROM mentor_student_memory WHERE id = ? AND user_id = ? AND mentor_key = ?').run(Number(id), userId, mentorKey);
    if (info.changes) removed += 1;
  }
  for (const item of (Array.isArray(data?.add) ? data.add : []).slice(0, 2)) {
    const content = String(item?.content || '').trim().slice(0, 200);
    if (!content || isSensitive(content).blocked) continue;
    const dupe = db.prepare('SELECT id FROM mentor_student_memory WHERE user_id = ? AND mentor_key = ? AND content = ?').get(userId, mentorKey, content);
    if (dupe) continue;
    if (mentorMemoryCount(userId, mentorKey) >= MENTOR_MEMORY_LIMIT) {
      const oldest = db.prepare('SELECT id FROM mentor_student_memory WHERE user_id = ? AND mentor_key = ? ORDER BY id ASC LIMIT 1').get(userId, mentorKey);
      if (oldest) db.prepare('DELETE FROM mentor_student_memory WHERE id = ?').run(oldest.id);
    }
    db.prepare('INSERT INTO mentor_student_memory(user_id, mentor_key, content, created_at) VALUES(?, ?, ?, ?)')
      .run(userId, mentorKey, content, nowLocal());
    added += 1;
  }
  return { added, removed };
}

/** 会议或1:1对话后，整理该导师的导师级记忆（失败不影响主流程） */
export async function organizeMentorMemory({ user, mentorKey, content, key, source }) {
  const agent = getAgent(mentorKey);
  if (!agent || !content.trim()) return { added: 0, removed: 0 };
  try {
    const prompt = {
      system: renderPrompt('memory_mentor', {
        ...userBrief(user),
        导师显示名: displayName(agent),
        导师职责: agent.duty,
        tone: agent.tone || '',
        已有导师记忆: mentorMemoryText(user.id, mentorKey),
        已有条数: mentorMemoryCount(user.id, mentorKey),
        上限: MENTOR_MEMORY_LIMIT,
        本次内容: content.slice(0, 3000),
      }),
      user: '请按 JSON 输出需要新增和删除的导师级记忆。',
    };
    const { data } = await generateJson({
      user, moduleId: 'M9_memory', purpose: '导师级记忆整理', prompt,
      key, source, maxTokens: 600, temperature: 0.2,
    });
    return applyMentorMemory(user.id, mentorKey, data);
  } catch (e) {
    console.warn('[导师记忆] 整理失败：', e?.code || e?.message);
    return { added: 0, removed: 0 };
  }
}

// ---------- 学生偏好（静音、风格） ----------

export function mentorPrefs(userId) {
  const rows = db.prepare('SELECT mentor_key, muted, style_pref FROM mentor_prefs WHERE user_id = ?').all(userId);
  const muted = new Set(rows.filter((r) => r.muted).map((r) => r.mentor_key));
  const styles = Object.fromEntries(rows.filter((r) => r.style_pref).map((r) => [r.mentor_key, r.style_pref]));
  return { muted, styles, rows };
}

export function setMentorPref(userId, mentorKey, patch) {
  const cur = db.prepare('SELECT * FROM mentor_prefs WHERE user_id = ? AND mentor_key = ?').get(userId, mentorKey);
  const muted = patch.muted !== undefined ? (patch.muted ? 1 : 0) : (cur?.muted ?? 0);
  const style = patch.style_pref !== undefined ? String(patch.style_pref || '').slice(0, 200) : (cur?.style_pref ?? '');
  db.prepare(`INSERT INTO mentor_prefs(user_id, mentor_key, muted, style_pref) VALUES(?, ?, ?, ?)
    ON CONFLICT(user_id, mentor_key) DO UPDATE SET muted = excluded.muted, style_pref = excluded.style_pref`)
    .run(userId, mentorKey, muted, style);
  return { mentor_key: mentorKey, muted: !!muted, style_pref: style };
}

// ---------- 在场导师名单 ----------

/** 把会议默认名单展开：companion 替换成学生自己选的陪伴导师 */
export function resolveDefaultMentors(user, mode) {
  const persona = resolvePersona(user.persona);
  const out = [];
  for (const k of mode.defaults) {
    const key = k === 'companion' ? persona : k;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** 本次会议可用的导师池：会议默认 + 当前站主讲与协同 + 四位陪伴导师 */
export function mentorPool(user, mode) {
  const station = currentStation(user.id);
  const { primary, co } = stationMentors(user, station);
  const keys = new Set([...resolveDefaultMentors(user, mode)]);
  if (primary) keys.add(primary.key);
  if (co) keys.add(co.key);
  for (const c of companions) keys.add(c.key);
  // 导师团（政策、经验、学法、导师视角、心理）随时可以被 @ 请进来
  for (const a of agentsInGroup('council')) keys.add(a.key);
  return [...keys].filter((k) => getAgent(k));
}

export function publicMentor(key) {
  const a = getAgent(key);
  if (!a) return null;
  return { key: a.key, name: a.name, duty: a.duty, summary: a.summary, tone: a.tone || '', icon: a.icon };
}

// ---------- 会议读写 ----------

export function publicSession(row, { withMessages = false } = {}) {
  const messages = withMessages
    ? db.prepare('SELECT * FROM group_messages WHERE session_id = ? ORDER BY id').all(row.id).map(publicGroupMessage)
    : [];
  return {
    id: row.id,
    mode: row.mode,
    mode_name: getMode(row.mode)?.name || row.mode,
    mentors: row.mentors_json ? JSON.parse(row.mentors_json) : [],
    twin_joined: !!row.twin_joined,
    summary: row.summary_json ? JSON.parse(row.summary_json) : null,
    action_items: row.action_items_json ? JSON.parse(row.action_items_json) : null,
    status: row.status,
    created_at: row.created_at,
    closed_at: row.closed_at,
    messages,
  };
}

function publicGroupMessage(m) {
  return {
    id: m.id, speaker_type: m.speaker_type, speaker_key: m.speaker_key, content: m.content,
    sources: m.sources_json ? JSON.parse(m.sources_json) : [],
    options: m.options_json ? JSON.parse(m.options_json) : null,
    is_draft: !!m.is_draft, created_at: m.created_at,
  };
}

export function ownSession(userId, id) {
  return db.prepare('SELECT * FROM group_sessions WHERE id = ? AND user_id = ?').get(Number(id), userId);
}

export function createSession(user, mode, mentors) {
  const info = db.prepare(`INSERT INTO group_sessions(user_id, mode, mentors_json, status, created_at)
    VALUES(?, ?, ?, 'open', ?)`).run(user.id, mode.key, JSON.stringify(mentors), nowLocal());
  return db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(info.lastInsertRowid);
}

export function addMessage(sessionId, { speakerType, speakerKey, content, sources = [], options = null, isDraft = false }) {
  const info = db.prepare(`INSERT INTO group_messages(session_id, speaker_type, speaker_key, content, sources_json, options_json, is_draft, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
    sessionId, speakerType, speakerKey || null, content,
    sources.length ? JSON.stringify(sources) : null,
    options ? JSON.stringify(options) : null, isDraft ? 1 : 0, nowLocal());
  return db.prepare('SELECT * FROM group_messages WHERE id = ?').get(info.lastInsertRowid);
}

export function sessionMessages(sessionId) {
  return db.prepare('SELECT * FROM group_messages WHERE session_id = ? ORDER BY id').all(sessionId);
}

/** 会议内只保留最近6条原文，更早的用会议摘要代替（7.5 成本控制） */
export function recentContext(sessionId, limit = 6) {
  const rows = db.prepare(`SELECT speaker_type, speaker_key, content FROM group_messages
    WHERE session_id = ? AND options_json IS NULL ORDER BY id DESC LIMIT ?`).all(sessionId, limit).reverse();
  if (!rows.length) return '（这是本轮会议的第一轮）';
  return rows.map((r) => {
    if (r.speaker_type === 'user') return `学生：${r.content.replace(/\n+/g, ' ').slice(0, 200)}`;
    if (r.speaker_type === 'host') return `司南：${r.content.replace(/\n+/g, ' ').slice(0, 150)}`;
    const a = getAgent(r.speaker_key);
    return `${a ? a.name : '导师'}：${r.content.replace(/\n+/g, ' ').slice(0, 200)}`;
  }).join('\n');
}

/** 最近3轮的发言者（避免同一位导师连续独占） */
export function recentSpeakers(sessionId, limit = 9) {
  const rows = db.prepare(`SELECT speaker_key FROM group_messages
    WHERE session_id = ? AND speaker_type = 'mentor' ORDER BY id DESC LIMIT ?`).all(sessionId, limit);
  return rows.map((r) => r.speaker_key).filter(Boolean);
}

// ---------- 学生发言里的 @ 解析 ----------

/** 从学生发言里找出 @ 的导师（支持显示名与别名） */
export function parseMentions(userId, text, pool) {
  const found = [];
  for (const key of pool) {
    const a = getAgent(key);
    if (!a) continue;
    const names = [a.name, ...(a.aliases || [])];
    for (const n of names) {
      if (text.includes(`@${n}`)) { if (!found.includes(key)) found.push(key); break; }
    }
  }
  // 兜底：直接写 @key（英文键）
  for (const key of pool) {
    if (text.includes(`@${key}`) && !found.includes(key)) found.push(key);
  }
  return found;
}

// ---------- 司南：选人 ----------

function mentorListText(keys) {
  return keys.map((k) => {
    const a = getAgent(k);
    return `- ${a.name}（key=${k}）｜${a.duty}：${a.summary}`;
  }).join('\n');
}

/**
 * 司南决定本轮谁发言、顺序与焦点。
 * 失败时降级为“按会议默认导师依次发言”，不让学生卡住（7.5 失败处理）。
 */
export async function planRound({ user, session, mode, text, mentions, key, source }) {
  const pool = JSON.parse(session.mentors_json || '[]').filter((k) => getAgent(k));
  const prefs = mentorPrefs(user.id);
  const allowed = pool.filter((k) => !prefs.muted.has(k));
  const station = currentStation(user.id);
  const st = getStation(station);
  const { primary, co } = stationMentors(user, station);
  const maxSpeakers = MAX_SPEAKERS[mode.tier] || 2;

  const fallback = () => {
    // 降级：@ 的导师优先，其次在场导师，最多 maxSpeakers 位
    const order = [...mentions.filter((k) => allowed.includes(k)), ...allowed.filter((k) => !mentions.includes(k))];
    const speakers = order.slice(0, maxSpeakers).map((k) => ({
      key: k,
      focus: mentions.includes(k) ? '先回应学生点名提出的问题' : `从你的职责出发，回应学生本轮的问题`,
    }));
    return { speakers, note_for_ui: `接下来由 ${speakers.map((s) => getAgent(s.key)?.name).join('、')} 发言`, degraded: true };
  };

  // 基础版最多2位、只允许会议默认导师（按 5.2 分级表）
  if (!allowed.length) return fallback();

  try {
    const prompt = {
      system: renderPrompt('host', {
        ...userBrief(user),
        共同规则: commonRules(),
        会议类型: mode.name,
        会议说明: mode.desc,
        主题: mode.question,
        当前站: station,
        站点名称: st?.name || '',
        本站主讲: primary ? displayName(primary) : '（无）',
        本站协同: co ? displayName(co) : '（无）',
        在场导师: mentorListText(allowed),
        静音导师: prefs.muted.size ? [...prefs.muted].map((k) => getAgent(k)?.name || k).join('、') : '（无）',
        最近发言者: recentSpeakers(session.id).map((k) => getAgent(k)?.name || k).join(' → ') || '（无）',
        学生发言: text.slice(0, 500),
      }),
      user: '请给出本轮发言安排，只输出 JSON。',
    };
    const { data } = await generateJson({
      user, moduleId: mode.tier === 'basic' ? 'M18_basic' : 'M18_full',
      purpose: '导师团编排', prompt, key, source, maxTokens: 800, temperature: 0.3,
    });
    let speakers = Array.isArray(data?.speakers) ? data.speakers : [];
    // 校验：只能在允许名单内、去重、@ 优先、数量受限
    speakers = speakers
      .filter((s) => s && allowed.includes(s.key))
      .filter((s, i, arr) => arr.findIndex((x) => x.key === s.key) === i)
      .slice(0, maxSpeakers);
    const missingMentions = mentions.filter((k) => allowed.includes(k) && !speakers.some((s) => s.key === k));
    if (missingMentions.length) {
      speakers = [...missingMentions.map((k) => ({ key: k, focus: '先回应学生点名提出的问题' })), ...speakers].slice(0, maxSpeakers);
    }
    if (!speakers.length) return fallback();
    return {
      speakers: speakers.map((s) => ({ key: s.key, focus: String(s.focus || '').slice(0, 120) || '回应学生本轮的问题' })),
      note_for_ui: String(data?.note_for_ui || `接下来由 ${speakers.map((s) => getAgent(s.key)?.name).join('、')} 发言`).slice(0, 120),
      degraded: false,
    };
  } catch (e) {
    console.warn('[导师团] 司南选人失败，使用默认顺序：', e?.code || e?.message);
    return fallback();
  }
}

/** 组装某位导师的发言提示词（附录B.13） */
export function speakerPrompt({ user, session, mode, mentorKey, focus, latestUserText }) {
  const a = getAgent(mentorKey);
  const station = currentStation(user.id);
  const st = getStation(station);
  const prefs = mentorPrefs(user.id);
  const style = prefs.styles[mentorKey];
  return renderPrompt('group_speaker', {
    导师显示名: displayName(a),
    导师职责: a.duty,
    tone: style ? `${a.tone || ''}\n【学生对你提的个人偏好】${style}` : (a.tone || ''),
    焦点: focus,
    会议类型: mode.name,
    主题: mode.question,
    姓名: user.name,
    专业: user.major || '未填写',
    年级: user.grade || '未填写',
    当前站: station,
    站点名称: st?.name || '',
    长期记忆: memoryText(user.id),
    导师级记忆: mentorMemoryText(user.id, mentorKey),
    会议摘要: session.summary_json ? summarizeText(session.summary_json) : '（本场会议刚开始）',
    最近发言: recentContext(session.id, 6) || `学生刚说：${latestUserText.slice(0, 300)}`,
    共同规则: '',
  });
}

function summarizeText(json) {
  try {
    const s = JSON.parse(json);
    const parts = [];
    if (s.summary) parts.push(s.summary);
    if (s.points?.length) parts.push(`讨论要点：${s.points.join('；')}`);
    if (s.decision) parts.push(`学生的决定：${s.decision}`);
    return parts.join('\n') || '（无）';
  } catch {
    return '（无）';
  }
}
/** 司南收束本轮 */
export async function summarizeRound({ user, mode, spoken, key, source, moduleId }) {
  const lines = spoken.map((s) => {
    const a = getAgent(s.key);
    return `${a ? a.name : s.key}：${s.text.replace(/\n+/g, ' ')}`;
  }).join('\n\n');
  const fallback = {
    consensus: '（本轮没有生成总结）',
    divergence: '无',
    decide: '你怎么看这一轮的意见？',
    options: [
      { key: 'A', label: '我采纳其中一条建议' },
      { key: 'B', label: '还想再听一位导师展开说说' },
      { key: 'C', label: '我先去核实一下资料' },
      { key: 'D', label: '我有别的想法，我自己说' },
    ],
    degraded: true,
  };
  try {
    const prompt = {
      system: renderPrompt('host_summary', {
        共同规则: commonRules(),
        会议类型: mode.name,
        主题: mode.question,
        本轮发言: lines,
      }),
      user: '请按 JSON 输出本轮的共识、分歧、需要学生决定的事和选项。',
    };
    const { data } = await generateJson({
      user, moduleId, purpose: '导师团本轮总结', prompt, key, source, maxTokens: 900, temperature: 0.3,
    });
    const options = (Array.isArray(data?.options) ? data.options : []).slice(0, 5)
      .map((o, i) => ({ key: String(o.key || String.fromCharCode(65 + i)), label: String(o.label || '').slice(0, 60) }))
      .filter((o) => o.label);
    if (options.length < 2) return fallback;
    return {
      consensus: String(data.consensus || '无').slice(0, 300),
      divergence: String(data.divergence || '无').slice(0, 300),
      decide: String(data.decide || '').slice(0, 300),
      options,
      degraded: false,
    };
  } catch (e) {
    console.warn('[导师团] 司南总结失败，使用通用选项：', e?.code || e?.message);
    return fallback;
  }
}
