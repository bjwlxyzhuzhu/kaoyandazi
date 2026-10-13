// M19 数字分身接口（PRD 第9章）：
// GET/PUT /twin  POST /twin/consent  PUT /twin/sources  POST /twin/uploads  POST /twin/uploads/:id/confirm
// POST /twin/build  POST /twin/corrections  POST /twin/talk（SSE）  DELETE /twin
// 另：POST /group/sessions/:id/twin（分身参会，草稿）  POST /group/sessions/:id/draft/confirm（本人确认草稿纪要）
import { Router } from 'express';
import { db } from '../db.js';
import { nowLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent, rateLimit } from '../auth.js';
import { userBrief } from '../prompts.js';
import { renderPrompt } from '../prompts.js';
import { getLlmConfig } from '../llm/settings.js';
import { resolveKey, recordCall } from '../llm/keys.js';
import { streamChat } from '../llm/client.js';
import { generateJson } from '../llm/json.js';
import { splitReply } from '../llm/options.js';
import { redact as redactLog } from '../crypto.js';
import { isSensitive } from '../memory.js';
import {
  DEFAULT_NAME, ICONS, SOURCES, SECTIONS, PURPOSES, UPLOAD_KINDS, CONFIDENCES,
  getTwinRow, publicTwin, requireConsent, sourcesOf, saveProfile, emptyProfile,
  sourceMaterials, normalizeGenerated, mergeWithLocked, twinSpeakPrompt, updateSuggestion,
  redact, parseUpload, deleteTwin, profileText, isProfileSensitive,
} from '../twin.js';
import { ownSession, addMessage, getMode, recentContext } from '../group.js';
import { rememberDraft, recordAdoption, logAction } from '../trace.js';

const r = Router();
const talkLimit = rateLimit({ windowMs: 60 * 1000, max: 12, key: (req) => `twin:${req.user?.id}` });
const SECTION_KEYS = SECTIONS.map((s) => s.key);

function twinResponse(userId) {
  const row = getTwinRow(userId);
  const uploads = db.prepare('SELECT id, filename, kind, redaction_log_json, confirmed, created_at, length(text_redacted) AS chars FROM twin_uploads WHERE user_id = ? ORDER BY id DESC').all(userId)
    .map((u) => ({ ...u, confirmed: !!u.confirmed, redaction_log: u.redaction_log_json ? JSON.parse(u.redaction_log_json) : [], redaction_log_json: undefined }));
  const corrections = db.prepare('SELECT id, field, before_text, after_text, created_at FROM twin_corrections WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(userId);
  return {
    twin: publicTwin(row),
    sources: SOURCES,
    sections: SECTIONS,
    icons: ICONS,
    purposes: PURPOSES,
    upload_kinds: UPLOAD_KINDS,
    uploads,
    corrections,
    suggestion: row ? updateSuggestion(userId) : null,
    note: '分身档案、上传资料和分身对话只有你本人可见；教师、同学、评委都看不到，也不用于任何评分。',
  };
}

r.get('/twin', requireStudent, (req, res) => res.json(twinResponse(req.user.id)));

/** 知情同意（PRD M19 第1步）：勾选才建立分身记录 */
r.post('/twin/consent', requireStudent, (req, res) => {
  if (req.body?.agreed !== true) throw new AppError(400, 'NEED_AGREE', '请先勾选“我已了解并同意”。');
  const row = getTwinRow(req.user.id);
  const now = nowLocal();
  if (row) db.prepare('UPDATE twins SET consent_at = ?, updated_at = COALESCE(updated_at, ?) WHERE user_id = ?').run(now, now, req.user.id);
  else db.prepare('INSERT INTO twins(user_id, name, icon, sources_json, locked_json, version, consent_at) VALUES(?, ?, ?, ?, ?, 0, ?)')
    .run(req.user.id, DEFAULT_NAME, 'mirror', JSON.stringify(Object.fromEntries(SOURCES.map((s) => [s.key, true]))), '[]', now);
  res.json(twinResponse(req.user.id));
});

/** 改名与图标（只允许原创抽象图标，不用真人照片） */
r.put('/twin', requireStudent, (req, res) => {
  requireConsent(req.user.id);
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 12) : null;
  if (name !== null && !name) throw new AppError(400, 'NO_NAME', '分身的名字不能为空。');
  if (name && /男友|女友|老公|老婆|恋人|宝贝/.test(name)) throw new AppError(400, 'BAD_NAME', '分身是你的学习者模型，不做恋爱或陪伴替代设定，换个名字吧。');
  const icon = req.body?.icon !== undefined ? (ICONS.includes(req.body.icon) ? req.body.icon : null) : undefined;
  if (icon === null) throw new AppError(400, 'BAD_ICON', '请从给定的图标里选一个。');
  if (name) db.prepare('UPDATE twins SET name = ? WHERE user_id = ?').run(name, req.user.id);
  if (icon) db.prepare('UPDATE twins SET icon = ? WHERE user_id = ?').run(icon, req.user.id);
  res.json(twinResponse(req.user.id));
});

/** 数据来源开关（逐项） */
r.put('/twin/sources', requireStudent, (req, res) => {
  const row = requireConsent(req.user.id);
  const cur = sourcesOf(row);
  for (const s of SOURCES) if (typeof req.body?.[s.key] === 'boolean') cur[s.key] = req.body[s.key];
  db.prepare('UPDATE twins SET sources_json = ? WHERE user_id = ?').run(JSON.stringify(cur), req.user.id);
  res.json(twinResponse(req.user.id));
});

// ---------- 上传：解析 → 遮盖 → 学生确认后才可用 ----------

r.post('/twin/uploads', requireStudent, rateLimit({ windowMs: 60 * 1000, max: 6, key: (req) => `twinup:${req.user?.id}` }), async (req, res) => {
  requireConsent(req.user.id);
  const filename = String(req.body?.filename || '资料.txt').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  const kind = UPLOAD_KINDS.includes(req.body?.kind) ? req.body.kind : '其他';
  let text;
  if (req.body?.data) {
    const buf = Buffer.from(String(req.body.data).replace(/^data:.*?;base64,/, ''), 'base64');
    text = await parseUpload(buf, filename);
  } else if (typeof req.body?.text === 'string' && req.body.text.trim()) {
    text = req.body.text.trim().slice(0, 20000);
  } else {
    throw new AppError(400, 'NO_FILE', '没有收到文件或文字。');
  }
  // 原文不入库：入库的只有遮盖后的文本和“遮了哪几类、各几处”
  const { text: masked, log } = redact(text);
  const info = db.prepare('INSERT INTO twin_uploads(user_id, filename, kind, text_redacted, redaction_log_json, confirmed, created_at) VALUES(?, ?, ?, ?, ?, 0, ?)')
    .run(req.user.id, filename, kind, masked, JSON.stringify(log), nowLocal());
  res.json({
    upload: { id: Number(info.lastInsertRowid), filename, kind, confirmed: false, chars: masked.length, redaction_log: log },
    preview: masked.slice(0, 1500),
    note: log.length
      ? `已自动遮盖 ${log.map((l) => `${l.type} ${l.count} 处`).join('、')}。请核对下面的预览，没有问题再点“确认使用”；还有漏掉的隐私，可以直接删掉这份重新上传。`
      : '没有发现需要遮盖的身份证号、手机号、住址、家庭经济或健康信息。请核对预览后点“确认使用”。',
  });
});

r.get('/twin/uploads/:id', requireStudent, (req, res) => {
  const u = db.prepare('SELECT * FROM twin_uploads WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!u) throw new AppError(404, 'NOT_FOUND', '没有这份资料。');
  res.json({ upload: { id: u.id, filename: u.filename, kind: u.kind, confirmed: !!u.confirmed, redaction_log: JSON.parse(u.redaction_log_json || '[]') }, preview: u.text_redacted.slice(0, 3000) });
});

/** 学生核对遮盖结果后确认；可以顺手再改一次文字（比如自己再删掉一段） */
r.post('/twin/uploads/:id/confirm', requireStudent, (req, res) => {
  const u = db.prepare('SELECT * FROM twin_uploads WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!u) throw new AppError(404, 'NOT_FOUND', '没有这份资料。');
  if (typeof req.body?.text === 'string') {
    const { text, log } = redact(req.body.text.slice(0, 20000));
    const prev = JSON.parse(u.redaction_log_json || '[]');
    db.prepare('UPDATE twin_uploads SET text_redacted = ?, redaction_log_json = ? WHERE id = ?').run(text, JSON.stringify([...prev, ...log]), u.id);
  }
  db.prepare('UPDATE twin_uploads SET confirmed = 1 WHERE id = ?').run(u.id);
  res.json(twinResponse(req.user.id));
});

r.delete('/twin/uploads/:id', requireStudent, (req, res) => {
  const info = db.prepare('DELETE FROM twin_uploads WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '没有这份资料。');
  res.json(twinResponse(req.user.id));
});

// ---------- 生成档案（基础模块：平台 Key） ----------

r.post('/twin/build', requireStudent, async (req, res) => {
  const u = req.user;
  const row = requireConsent(u.id);
  const sources = sourcesOf(row);
  const mats = sourceMaterials(u.id, sources);
  const { key, source } = resolveKey(u, 'M19_basic', req.get('X-User-Key'));
  const labels = SOURCES.filter((s) => mats.used.includes(s.key)).map((s) => s.label);
  if (mats.uploads.length) labels.push(...mats.uploads.map((f) => `上传:${f}`));
  const prompt = {
    system: renderPrompt('twin_profile', {
      ...userBrief(u),
      可用来源: labels.join('、') || '（无）',
      资料: mats.text,
    }),
    user: '请整理分身档案，只输出 JSON。',
  };
  const { data } = await generateJson({ user: u, moduleId: 'M19_basic', purpose: '整理分身档案', prompt, key, source, maxTokens: 2500, temperature: 0.3 });
  const fresh = normalizeGenerated(data, { used: mats.used, uploads: mats.uploads, sources });
  const old = row.profile_json ? JSON.parse(row.profile_json) : emptyProfile();
  const merged = mergeWithLocked(old, fresh);
  saveProfile(u.id, merged);
  res.json({ ...twinResponse(u.id), used_sources: mats.used });
});

/**
 * 校正（PRD M19 第5步）：确认 / 修改 / 删除 / 锁定 / 解锁 / 新增一条。
 * 每次都写校正记录；分身随之更新。
 */
r.post('/twin/corrections', requireStudent, (req, res) => {
  const u = req.user;
  const row = requireConsent(u.id);
  const t = publicTwin(row);
  const p = t.profile;
  const action = String(req.body?.action || '');
  const field = String(req.body?.section || '');
  if (!SECTION_KEYS.includes(field)) throw new AppError(400, 'BAD_SECTION', '没有这一类档案。');
  const id = String(req.body?.id || '');
  const idx = p[field].findIndex((it) => it.id === id);
  const label = SECTIONS.find((s) => s.key === field).label;
  let before = null;
  let after = null;

  if (action === 'add') {
    const text = String(req.body?.text || '').trim().slice(0, 200);
    if (!text) throw new AppError(400, 'EMPTY', '请填写内容。');
    if (isSensitive(text).blocked || isProfileSensitive(text)) throw new AppError(400, 'SENSITIVE', '这类隐私或健康信息不进分身档案，请换一条。');
    p[field].push({ id: `${field}-u${Date.now().toString(36)}`, text, source: '本人补充', confidence: '原话', confirmed: true, locked: !!req.body?.lock });
    after = text;
  } else {
    if (idx < 0) throw new AppError(404, 'NOT_FOUND', '没有这条档案，可能已经更新过，请刷新。');
    const it = p[field][idx];
    before = it.text;
    if (action === 'confirm') { it.confirmed = true; after = `${it.text}（已确认）`; }
    else if (action === 'lock') { it.locked = true; it.confirmed = true; after = `${it.text}（已锁定）`; }
    else if (action === 'unlock') { it.locked = false; after = `${it.text}（已解锁）`; }
    else if (action === 'edit') {
      const text = String(req.body?.text || '').trim().slice(0, 200);
      if (!text) throw new AppError(400, 'EMPTY', '内容不能为空；想去掉这条请点“删除”。');
      if (isSensitive(text).blocked || isProfileSensitive(text)) throw new AppError(400, 'SENSITIVE', '这类隐私或健康信息不进分身档案。');
      it.text = text; it.source = '本人修改'; it.confidence = '原话'; it.confirmed = true;
      if (req.body?.lock) it.locked = true;
      after = text;
    } else if (action === 'delete') {
      p[field].splice(idx, 1);
      after = '（已删除）';
    } else {
      throw new AppError(400, 'BAD_ACTION', '不认识的操作。');
    }
  }
  saveProfile(u.id, p);
  db.prepare('INSERT INTO twin_corrections(user_id, field, before_text, after_text, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(u.id, label, before, after, nowLocal());
  if (action !== 'add') logAction(u.id, 'twin_item', null, ['confirm', 'lock', 'unlock'].includes(action) ? 'confirm' : action === 'delete' ? 'reject' : 'modify');
  res.json(twinResponse(u.id));
});

// ---------- 分身对话（高阶：学生自己的 Key） ----------

const CRISIS = /(自杀|自残|伤害自己|不想活|活着没意思|撑不下去|想死)/;

/** purpose: meeting（预演复盘会发言）/ rehearsal（复试彩排）/ future（对话未来的自己） */
r.post('/twin/talk', requireStudent, talkLimit, async (req, res) => {
  const u = req.user;
  const row = requireConsent(u.id);
  if (!row.profile_json) throw new AppError(400, 'NOT_BUILT', '分身档案还没有生成，请先点“生成分身档案”。');
  const purpose = Object.keys(PURPOSES).includes(req.body?.purpose) ? req.body.purpose : 'future';
  const text = String(req.body?.text || '').trim();
  if (!text) throw new AppError(400, 'EMPTY', '请输入内容。');
  if (text.length > 1000) throw new AppError(400, 'TOO_LONG', '一次最多1000字。');
  const { key, source } = resolveKey(u, 'M19_full', req.get('X-User-Key'));
  const llm = getLlmConfig();

  // 同一用途沿用最近一段对话
  let conv = req.body?.conv_id ? db.prepare('SELECT * FROM twin_conversations WHERE id = ? AND user_id = ?').get(Number(req.body.conv_id), u.id) : null;
  const transcript = conv ? JSON.parse(conv.transcript_json || '[]') : [];

  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let open = true;
  res.on('close', () => { open = false; });
  const emit = (ev, data) => { if (open) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
  emit('meta', { purpose, mock: llm.mock, draft: true });

  try {
    let reply;
    if (CRISIS.test(text)) {
      // 危机兜底（同 M9）：不进入分身对话，固定回复
      reply = '我先停下来。你刚才说的话让我很担心你——这件事比任何学习任务都重要。我只是你的分身，真正能帮你的是身边的人：请现在联系你的辅导员、学校心理咨询中心，或者拨打 12356 心理援助热线。如果你愿意，也可以先去和搭子说说话。';
      emit('delta', { text: reply });
    } else {
      const extra = purpose === 'rehearsal' ? '对方是复试考官，你按档案里的表达习惯作答一次，供本人对照。' : purpose === 'meeting' ? '你在预演“本人参加周复盘会时会怎么说”，只陈述档案里的事实。' : '';
      const messages = [
        { role: 'system', content: twinSpeakPrompt(u, row, purpose, extra) },
        ...transcript.slice(-8).map((m) => ({ role: m.role === 'twin' ? 'assistant' : 'user', content: m.content })),
        { role: 'user', content: text },
      ];
      const out = await streamChat({ baseUrl: llm.baseUrl, key, model: llm.chatModel, messages, source, maxTokens: 800, onDelta: (t) => emit('delta', { text: t }) });
      recordCall({ userId: u.id, kind: 'M19_full', purpose: `分身对话（${PURPOSES[purpose]}）`, model: out.model, source, usage: out.usage });
      reply = splitReply(out.content).body || out.content;
      // 分身发言一律带“分身推测”标记（模型漏了就补上）
      if (!reply.includes('分身推测')) reply = `【分身推测】${reply}`;
    }
    transcript.push({ role: 'user', content: text, at: nowLocal() }, { role: 'twin', content: reply, at: nowLocal(), draft: true });
    if (conv) db.prepare('UPDATE twin_conversations SET transcript_json = ? WHERE id = ?').run(JSON.stringify(transcript), conv.id);
    else {
      const info = db.prepare('INSERT INTO twin_conversations(user_id, purpose, transcript_json, created_at) VALUES(?, ?, ?, ?)').run(u.id, purpose, JSON.stringify(transcript), nowLocal());
      conv = { id: Number(info.lastInsertRowid) };
    }
    emit('done', { conv_id: conv.id, reply, draft: true, crisis: CRISIS.test(text) });
  } catch (e) {
    const code = e instanceof AppError ? e.code : 'INTERNAL';
    if (!(e instanceof AppError)) console.error('[分身] 未预期的错误：', redactLog(e?.stack || e));
    emit('error', { code, message: e instanceof AppError ? e.message : '出了点问题，请稍后重试。', restore_text: text });
  } finally {
    if (open) res.end();
  }
});

r.get('/twin/talks', requireStudent, (req, res) => {
  const purpose = Object.keys(PURPOSES).includes(req.query.purpose) ? req.query.purpose : null;
  const rows = db.prepare(`SELECT * FROM twin_conversations WHERE user_id = ? ${purpose ? 'AND purpose = ?' : ''} ORDER BY id DESC LIMIT 20`)
    .all(...(purpose ? [req.user.id, purpose] : [req.user.id]));
  res.json({ conversations: rows.map((c) => ({ id: c.id, purpose: c.purpose, transcript: JSON.parse(c.transcript_json || '[]'), created_at: c.created_at })) });
});

/** 一键删除（二次确认由前端完成，这里要求 body.confirm === '删除分身'） */
r.delete('/twin', requireStudent, (req, res) => {
  if (req.body?.confirm !== '删除分身') throw new AppError(400, 'NEED_CONFIRM', '删除不可恢复。请在确认框里输入“删除分身”。');
  const counts = deleteTwin(req.user.id);
  res.json({ ok: true, deleted: counts, note: '分身档案、上传资料、校正记录和分身对话都已删除，无法恢复。长期记忆和其他学习数据不受影响。' });
});

// ---------- 分身参加周复盘会（M18 × M19，高阶） ----------

/**
 * 学生不在线时让分身代表自己在会上陈述：分身只说档案里的事实与“分身推测”，发言标记为草稿。
 * 之后结束会议生成的纪要整体是草稿，行动项要本人先确认纪要才能写入方案。
 */
r.post('/group/sessions/:id/twin', requireStudent, talkLimit, async (req, res) => {
  const u = req.user;
  const s = ownSession(u.id, req.params.id);
  if (!s) throw new AppError(404, 'NOT_FOUND', '没有这场会议。');
  if (s.status !== 'open') throw new AppError(400, 'CLOSED', '这场会议已经结束了。');
  const mode = getMode(s.mode);
  if (mode.key !== 'weekly') throw new AppError(400, 'ONLY_WEEKLY', '分身目前只能代表你参加周复盘会。');
  const row = requireConsent(u.id);
  if (!row.profile_json) throw new AppError(400, 'NOT_BUILT', '分身档案还没有生成，请先到“我 → 数字分身”生成。');
  const { key, source } = resolveKey(u, 'M19_full', req.get('X-User-Key'));
  const llm = getLlmConfig();

  const out = await streamChat({
    baseUrl: llm.baseUrl, key, model: llm.chatModel, source, maxTokens: 800,
    messages: [
      { role: 'system', content: twinSpeakPrompt(u, row, 'meeting', '本人不在线，你代表本人在周复盘会上陈述这一周的情况：只说档案里有的事实，档案里没有的说“不确定，需要本人回答”。不替本人做任何决定。') },
      { role: 'user', content: `【会议最近的发言】\n${recentContext(s.id, 6)}\n\n请代表本人陈述本周情况（不超过200字）。` },
    ],
  });
  recordCall({ userId: u.id, kind: 'M19_full', purpose: '分身参会', model: out.model, source, usage: out.usage });
  let text = splitReply(out.content).body || out.content;
  if (!text.includes('分身推测')) text = `【分身推测】${text}`;
  addMessage(s.id, { speakerType: 'twin', speakerKey: 'twin', content: text, isDraft: true });
  db.prepare('UPDATE group_sessions SET twin_joined = 1 WHERE id = ?').run(s.id);
  addMessage(s.id, { speakerType: 'host', speakerKey: 'host', content: '以上是分身代表你的发言（草稿）。这场会议的纪要会标为草稿，你本人确认之前，任何行动项都不会写入方案。' });
  const { publicSession } = await import('../group.js');
  res.json({ session: publicSession(db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(s.id), { withMessages: true }) });
});

/** 本人确认分身参会产生的草稿纪要（可修改“学生的决定”或否决整份纪要） */
r.post('/group/sessions/:id/draft/confirm', requireStudent, async (req, res) => {
  const u = req.user;
  const s = ownSession(u.id, req.params.id);
  if (!s) throw new AppError(404, 'NOT_FOUND', '没有这场会议。');
  if (!s.twin_joined) throw new AppError(400, 'NOT_DRAFT', '这场会议没有分身参加，纪要不是草稿。');
  if (s.status !== 'closed') throw new AppError(400, 'NOT_CLOSED', '先结束会议生成纪要，再确认。');
  const summary = JSON.parse(s.summary_json || '{}');
  if (req.body?.reject === true) {
    summary.draft = false; summary.rejected = true;
    db.prepare('UPDATE group_sessions SET summary_json = ?, action_items_json = ? WHERE id = ?').run(JSON.stringify(summary), '[]', s.id);
  } else {
    if (typeof req.body?.decision === 'string' && req.body.decision.trim()) summary.decision = req.body.decision.trim().slice(0, 300);
    summary.draft = false;
    summary.confirmed_at = nowLocal();
    db.prepare('UPDATE group_sessions SET summary_json = ? WHERE id = ?').run(JSON.stringify(summary), s.id);
  }
  const { publicSession } = await import('../group.js');
  res.json({ session: publicSession(db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(s.id), { withMessages: true }) });
});

export { profileText, CONFIDENCES };
export default r;
