// M20 导师工坊（PRD M20、7.7）：角色卡版本、知识库（FTS5）、经验库、运行时装配
// “训练”= 角色卡 + 知识库 + 记忆 + 反馈蒸馏，有版本、可回滚；不做模型微调。
// 学生端只读“已发布版本”：草稿怎么改都不影响学生，发布后才生效，回滚立即恢复。
import { db } from './db.js';
import { nowLocal, addDays, todayLocal } from './time.js';
import { AppError } from './errors.js';
import { getAgent, displayName } from './registry.js';

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
export const CHUNK_CHARS = 500;
export const TOP_K = 3;

/** 角色卡的可编辑字段 */
export function emptyPersona(key) {
  const a = getAgent(key);
  return {
    tone: a?.tone || '',
    style_notes: [],      // 角色卡措辞补充
    boundaries: [],       // 职责边界
    negatives: [],        // 负面清单（不要这样做）
    examples: [],         // 示例对话（few-shot）：{ q, a }
    doc_ids: [],          // 这个版本启用的资料
    changes_count: 0,
  };
}

function normalizePersona(key, p) {
  const base = emptyPersona(key);
  const list = (v, n = 20, len = 200) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, n).map((x) => x.slice(0, len)) : []);
  return {
    tone: String(p?.tone ?? base.tone).slice(0, 300),
    style_notes: list(p?.style_notes),
    boundaries: list(p?.boundaries),
    negatives: list(p?.negatives),
    examples: (Array.isArray(p?.examples) ? p.examples : []).filter((e) => e && String(e.q || '').trim() && String(e.a || '').trim()).slice(0, 10)
      .map((e) => ({ q: String(e.q).slice(0, 300), a: String(e.a).slice(0, 600) })),
    doc_ids: (Array.isArray(p?.doc_ids) ? p.doc_ids : []).map(Number).filter(Number.isInteger),
    changes_count: Number(p?.changes_count) || 0,
  };
}

// ---------- 版本 ----------

export function mentorRow(key) {
  return db.prepare('SELECT * FROM mentors WHERE key = ?').get(key) || null;
}

export function versionRows(key) {
  return db.prepare('SELECT * FROM mentor_versions WHERE mentor_key = ? AND published_at IS NOT NULL ORDER BY id').all(key);
}

/** 当前发布版本（没发布过任何版本时 = 注册表里的初始角色卡 v1.0） */
export function publishedVersion(key) {
  const m = mentorRow(key);
  const v = m?.current_version ? db.prepare('SELECT * FROM mentor_versions WHERE mentor_key = ? AND version = ? AND published_at IS NOT NULL ORDER BY id DESC LIMIT 1').get(key, m.current_version) : null;
  return {
    version: m?.current_version || 'v1.0',
    persona: normalizePersona(key, v ? parse(v.persona_json, {}) : emptyPersona(key)),
    published_at: v?.published_at || null,
  };
}

export function draftRow(key) {
  return db.prepare('SELECT * FROM mentor_versions WHERE mentor_key = ? AND published_at IS NULL ORDER BY id DESC LIMIT 1').get(key) || null;
}

export function draftPersona(key) {
  const d = draftRow(key);
  return d ? { persona: normalizePersona(key, parse(d.persona_json, {})), change_note: d.change_note || '', eval: parse(d.eval_result_json, null) } : null;
}

/** 保存草稿：草稿只有一份，从当前发布版本复制而来 */
export function saveDraft(key, patch, { note } = {}) {
  const cur = draftPersona(key)?.persona || publishedVersion(key).persona;
  const next = normalizePersona(key, { ...cur, ...patch });
  const d = draftRow(key);
  if (d) db.prepare('UPDATE mentor_versions SET persona_json = ?, change_note = COALESCE(?, change_note), eval_result_json = NULL WHERE id = ?').run(JSON.stringify(next), note ?? null, d.id);
  else db.prepare("INSERT INTO mentor_versions(mentor_key, version, persona_json, change_note) VALUES(?, '草稿', ?, ?)").run(key, JSON.stringify(next), note || '');
  return next;
}

function nextVersion(key) {
  const rows = versionRows(key).map((v) => v.version);
  const all = ['v1.0', ...rows];
  let max = [1, 0];
  for (const v of all) {
    const m = String(v).match(/^v(\d+)\.(\d+)$/);
    if (m) { const x = [Number(m[1]), Number(m[2])]; if (x[0] > max[0] || (x[0] === max[0] && x[1] > max[1])) max = x; }
  }
  return `v${max[0]}.${max[1] + 1}`;
}

export function publish(key, teacherId, note) {
  const d = draftRow(key);
  if (!d) throw new AppError(400, 'NO_DRAFT', '没有草稿可发布。先编辑角色卡或上传资料。');
  const version = nextVersion(key);
  const persona = normalizePersona(key, parse(d.persona_json, {}));
  const prev = publishedVersion(key).persona;
  persona.changes_count = diffCount(prev, persona);
  db.prepare('UPDATE mentor_versions SET version = ?, persona_json = ?, change_note = ?, published_by = ?, published_at = ? WHERE id = ?')
    .run(version, JSON.stringify(persona), String(note || d.change_note || '').slice(0, 300), teacherId, nowLocal(), d.id);
  db.prepare("UPDATE mentors SET current_version = ?, status = 'published', updated_at = ? WHERE key = ?").run(version, nowLocal(), key);
  return version;
}

/** 回滚：把“当前版本”指回之前发布过的某个版本（不删除任何版本） */
export function rollback(key, version) {
  if (version !== 'v1.0' && !versionRows(key).some((v) => v.version === version)) throw new AppError(404, 'NO_VERSION', '没有这个版本。');
  db.prepare('UPDATE mentors SET current_version = ?, updated_at = ? WHERE key = ?').run(version, nowLocal(), key);
  return version;
}

/** 两个角色卡之间改了几处（给学生端“本周更新了 N 处”用） */
export function diffCount(a, b) {
  let n = a.tone === b.tone ? 0 : 1;
  for (const k of ['style_notes', 'boundaries', 'negatives']) {
    const x = new Set(a[k]); const y = new Set(b[k]);
    n += [...y].filter((v) => !x.has(v)).length + [...x].filter((v) => !y.has(v)).length;
  }
  n += Math.abs((a.examples || []).length - (b.examples || []).length);
  const x = new Set(a.doc_ids); const y = new Set(b.doc_ids);
  n += [...y].filter((v) => !x.has(v)).length + [...x].filter((v) => !y.has(v)).length;
  return n;
}

// ---------- 知识库 ----------

/** 切片：按段落拼到约 500 字一片 */
export function chunkText(text) {
  const paras = String(text || '').replace(/\r\n/g, '\n').split(/\n\s*\n|\n/).map((x) => x.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  for (const p of paras) {
    if (p.length > CHUNK_CHARS) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < p.length; i += CHUNK_CHARS) out.push(p.slice(i, i + CHUNK_CHARS));
      continue;
    }
    if ((cur + p).length > CHUNK_CHARS && cur) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${p}` : p;
  }
  if (cur) out.push(cur);
  return out;
}

export function addDoc(key, { title, source, level, licenseNote, text, teacherId }) {
  const chunks = chunkText(text);
  if (!chunks.length) throw new AppError(400, 'EMPTY', '资料里没有读出文字。');
  db.exec('BEGIN');
  try {
    const info = db.prepare('INSERT INTO mentor_docs(mentor_key, title, source, license_note, enabled, uploaded_by, created_at, level) VALUES(?, ?, ?, ?, 1, ?, ?, ?)')
      .run(key, title, source, licenseNote, teacherId, nowLocal(), level);
    const docId = Number(info.lastInsertRowid);
    const ins = db.prepare('INSERT INTO mentor_chunks(doc_id, mentor_key, content) VALUES(?, ?, ?)');
    const fts = db.prepare('INSERT INTO mentor_chunks_fts(rowid, content, mentor_key, doc_id) VALUES(?, ?, ?, ?)');
    for (const c of chunks) {
      const ci = ins.run(docId, key, c);
      fts.run(Number(ci.lastInsertRowid), c, key, docId);
    }
    db.exec('COMMIT');
    // 新资料先进草稿，发布后学生才检索得到
    const draft = draftPersona(key)?.persona || publishedVersion(key).persona;
    saveDraft(key, { doc_ids: [...new Set([...draft.doc_ids, docId])] });
    return { doc_id: docId, chunks: chunks.length };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function setDocEnabled(key, docId, enabled) {
  const info = db.prepare('UPDATE mentor_docs SET enabled = ? WHERE id = ? AND mentor_key = ?').run(enabled ? 1 : 0, docId, key);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '没有这份资料。');
}

export function docsOf(key) {
  return db.prepare(`SELECT d.*, (SELECT COUNT(*) FROM mentor_chunks c WHERE c.doc_id = d.id) AS chunks FROM mentor_docs d WHERE d.mentor_key = ? ORDER BY d.id DESC`).all(key);
}

/** 问题里的三字片段（trigram 分词器按三字匹配） */
function trigrams(text) {
  const s = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
  const out = new Set();
  for (let i = 0; i + 3 <= s.length; i += 1) out.add(s.slice(i, i + 3));
  return [...out].slice(0, 60);
}

/**
 * 检索：只在“本版本启用 + 当前未禁用”的资料里找，按 FTS5 bm25 取前 3 片；
 * 至少命中 2 个三字片段才算相关，避免给不相干的问题硬塞引用。
 */
export function retrieve(key, query, docIds, k = TOP_K) {
  const ids = (docIds || []).filter(Number.isInteger);
  const grams = trigrams(query);
  if (!ids.length || grams.length < 1) return [];
  const enabled = new Set(db.prepare(`SELECT id FROM mentor_docs WHERE mentor_key = ? AND enabled = 1 AND id IN (${ids.map(() => '?').join(',')})`).all(key, ...ids).map((d) => d.id));
  if (!enabled.size) return [];
  const match = grams.map((g) => `"${g.replace(/"/g, '""')}"`).join(' OR ');
  let rows;
  try {
    rows = db.prepare(`SELECT c.id, c.doc_id, c.content, bm25(mentor_chunks_fts) AS score FROM mentor_chunks_fts
      JOIN mentor_chunks c ON c.id = mentor_chunks_fts.rowid
      WHERE mentor_chunks_fts MATCH ? AND c.mentor_key = ? ORDER BY score LIMIT 30`).all(match, key);
  } catch {
    return [];
  }
  const docs = new Map(db.prepare(`SELECT id, title, source, level FROM mentor_docs WHERE mentor_key = ?`).all(key).map((d) => [d.id, d]));
  return rows
    .filter((r) => enabled.has(r.doc_id))
    .map((r) => ({ ...r, hits: grams.filter((g) => r.content.includes(g)).length }))
    .filter((r) => r.hits >= 2)
    .slice(0, k)
    .map((r) => ({ chunk_id: r.id, doc_id: r.doc_id, title: docs.get(r.doc_id)?.title || '', source: docs.get(r.doc_id)?.source || '', level: docs.get(r.doc_id)?.level || '', content: r.content }));
}

// ---------- 经验库与经验案例 ----------

export function approvedInsights(key) {
  return db.prepare("SELECT insight FROM mentor_insights WHERE mentor_key = ? AND status = 'approved' ORDER BY id DESC LIMIT 5").all(key).map((x) => x.insight);
}

/** 渡舟的经验库：教师批准、已匿名、有同意说明的案例，按相关度取 2 条 */
export function relevantCases(query) {
  const grams = trigrams(query);
  const rows = db.prepare('SELECT * FROM experience_cases WHERE approved_by IS NOT NULL AND anonymized = 1').all();
  return rows.map((c) => ({ ...c, hits: grams.filter((g) => `${c.title}${c.content}`.includes(g)).length }))
    .sort((a, b) => b.hits - a.hits).slice(0, 2);
}

/** 可识别个人的信息：真实学生 / 教师的姓名或学号、手机号、身份证号、邮箱 */
export function containsPII(text) {
  const t = String(text || '');
  if (/(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{17}[\dXx](?!\d)|[\w.+-]+@[\w-]+\.[\w.]+/.test(t)) return '手机号、身份证号或邮箱';
  for (const u of db.prepare("SELECT name, student_no FROM users WHERE role = 'student'").all()) {
    if (u.name && u.name.length >= 2 && t.includes(u.name)) return `学生姓名“${u.name}”`;
    if (u.student_no && u.student_no.length >= 5 && t.includes(u.student_no)) return '学号';
  }
  return null;
}

// ---------- 运行时：拼进学生对话的提示词 ----------

/**
 * 某位导师此刻对学生生效的“工坊附加内容”（只读已发布版本）。
 * 返回 { version, block, sources }；block 为空串表示没有任何附加。
 */
export function mentorRuntime(key, query, { draft = false } = {}) {
  if (!getAgent(key)) return { version: null, block: '', sources: [] };
  const pub = publishedVersion(key);
  const d = draft ? draftPersona(key) : null;
  const version = d ? '草稿' : pub.version;
  const persona = d ? d.persona : pub.persona;
  const parts = [];
  const card = [];
  if (persona.tone && persona.tone !== getAgent(key).tone) card.push(`语气：${persona.tone}`);
  if (persona.style_notes.length) card.push(`表达要求：\n${persona.style_notes.map((x) => `- ${x}`).join('\n')}`);
  if (persona.boundaries.length) card.push(`职责边界：\n${persona.boundaries.map((x) => `- ${x}`).join('\n')}`);
  if (persona.negatives.length) card.push(`不要这样做：\n${persona.negatives.map((x) => `- ${x}`).join('\n')}`);
  if (persona.examples.length) card.push(`示例对话：\n${persona.examples.map((e) => `学生：${e.q}\n你：${e.a}`).join('\n\n')}`);
  if (card.length) parts.push(`【导师工坊 · 角色卡补充（${version}，教师发布）】\n${card.join('\n')}`);
  const insights = approvedInsights(key);
  if (insights.length) parts.push(`【常见情况（教师审核过的经验库，跨学生的匿名规律，只作参考）】\n${insights.map((x) => `- ${x}`).join('\n')}`);
  if (key === 'senior') {
    const cases = relevantCases(query).filter((c) => c.hits > 0);
    if (cases.length) parts.push(`【经验案例（经本人同意并匿名，教师审核）】\n${cases.map((c) => `- ${c.title}：${c.content.slice(0, 300)}`).join('\n')}\n引用时说明“这是一位学长/学姐的经历，不一定适用于你”。`);
  }
  const hits = retrieve(key, query, persona.doc_ids);
  if (hits.length) {
    parts.push(`【资料片段（来自教师上传的资料）】\n${hits.map((h, i) => `[资料${i + 1}]《${h.title}》（来源：${h.source || '未注明'}${h.level ? `；证据等级：${h.level}` : ''}）\n${h.content}`).join('\n\n')}\n回答涉及这些内容时，在句末用“[资料1]”这样的标记注明依据；资料里没有的不要编。`);
  }
  return {
    version,
    block: parts.join('\n\n'),
    sources: hits.map((h, i) => ({ ref: `资料${i + 1}`, doc_id: h.doc_id, title: h.title, source: h.source, level: h.level, snippet: h.content.slice(0, 200) })),
  };
}

/** 只保留回复里真正引用了的来源 */
export function citedSources(reply, sources) {
  return sources.filter((s) => String(reply || '').includes(`[${s.ref}]`));
}

// ---------- 学生端看得到的“学习” ----------

export function mentorPublicInfo(key) {
  const { version, persona } = publishedVersion(key);
  const docs = persona.doc_ids.length
    ? db.prepare(`SELECT COUNT(*) AS n FROM mentor_docs WHERE mentor_key = ? AND enabled = 1 AND id IN (${persona.doc_ids.map(() => '?').join(',')})`).get(key, ...persona.doc_ids).n
    : 0;
  const week = addDays(todayLocal(), -6);
  const recent = db.prepare('SELECT persona_json FROM mentor_versions WHERE mentor_key = ? AND published_at >= ?').all(key, week)
    .reduce((n, v) => n + (parse(v.persona_json, {}).changes_count || 0), 0);
  return { version, doc_count: docs, updated_this_week: recent, note: `AI导师 · 版本 ${version} · 依据 ${docs} 份资料${recent ? ` · 本周根据同学们的反馈更新了 ${recent} 处` : ''}` };
}

export { displayName };
