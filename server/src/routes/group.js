// M18 导师团（PRD 第9章接口清单 + 7.5 流式协议）
// SSE 事件：host_plan → (speaker_start → delta* → speaker_end)+ → host_summary → options → done
import { Router } from 'express';
import { db } from '../db.js';
import { nowLocal, todayLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent, rateLimit } from '../auth.js';
import { getAgent, displayName } from '../registry.js';
import { renderPrompt, commonRules, userBrief } from '../prompts.js';
import { getLlmConfig } from '../llm/settings.js';
import { resolveKey, recordCall } from '../llm/keys.js';
import { streamChat } from '../llm/client.js';
import { generateJson } from '../llm/json.js';
import { splitReply } from '../llm/options.js';
import { redact } from '../crypto.js';
import {
  GROUP_MODES, MAX_ROUNDS, MAX_SPEAKERS, getMode, mentorPrefs, setMentorPref,
  mentorPool, publicMentor, resolveDefaultMentors, createSession, ownSession, publicSession,
  addMessage, sessionMessages, planRound, speakerPrompt, summarizeRound,
  parseMentions, organizeMentorMemory, recentSpeakers, recentContext,
} from '../group.js';
import { setFlowStatus, flowStatusOf } from '../stations.js';
import { CURRENT_STAGE } from '../stage.js';
import { mentorRuntime, citedSources } from '../workshop.js';
import { rememberDraft, recordAdoption, logAction } from '../trace.js';

const r = Router();
const sendLimit = rateLimit({ windowMs: 60 * 1000, max: 12, key: (req) => `group:${req.user?.id}` });

// ---------- 会议类型与导师 ----------
r.get('/group/modes', requireStudent, (req, res) => {
  const prefs = mentorPrefs(req.user.id);
  res.json({
    modes: GROUP_MODES.map((m) => ({ ...m, available: m.stage ? m.stage <= CURRENT_STAGE : true })),
    max_rounds: MAX_ROUNDS,
    max_speakers: MAX_SPEAKERS,
    muted: [...prefs.muted],
    note: '基础版（周复盘会、卡住了求助）不需要绑定 Key；其他会议类型需要绑定你自己的 Key。',
  });
});

/** 可邀请的导师（含当前站主讲与协同） */
r.get('/group/mentors', requireStudent, (req, res) => {
  const mode = getMode(String(req.query.mode || 'weekly')) || GROUP_MODES[0];
  const prefs = mentorPrefs(req.user.id);
  res.json({
    mentors: mentorPool(req.user, mode).map((k) => ({ ...publicMentor(k), muted: prefs.muted.has(k), style_pref: prefs.styles[k] || '' })).filter(Boolean),
    defaults: resolveDefaultMentors(req.user, mode),
  });
});

/** 学生的偏好：静音、个人风格 */
r.put('/me/mentor-prefs/:key', requireStudent, (req, res) => {
  const key = String(req.params.key);
  if (!getAgent(key)) throw new AppError(404, 'NO_MENTOR', '没有这位导师。');
  const pref = setMentorPref(req.user.id, key, req.body || {});
  res.json({ pref });
});

/** 每条发言的“有帮助 / 没帮助 + 原因”（本阶段只记录，蒸馏在阶段8） */
r.post('/mentors/:key/feedback', requireStudent, (req, res) => {
  const key = String(req.params.key);
  if (!getAgent(key)) throw new AppError(404, 'NO_MENTOR', '没有这位导师。');
  const helpful = req.body?.helpful === true;
  const reasons = (Array.isArray(req.body?.reasons) ? req.body.reasons : [req.body?.reason]).map((x) => String(x || '').trim().slice(0, 20)).filter(Boolean).slice(0, 5);
  const note = String(req.body?.note || '').slice(0, 300);
  const sessionId = req.body?.session_id ? Number(req.body.session_id) : null;
  if (sessionId) {
    const s = ownSession(req.user.id, sessionId);
    if (!s) throw new AppError(404, 'NOT_FOUND', '没有这场会议。');
  }
  // 复用表已有字段：rating 记方向，reason_tags_json 记原因标签，comment 记补充说明，
  // message_ref 记来源（会议或1:1对话的消息）
  // 引用被评价的那一条回复（msg:1:1 对话消息；gmsg:会议发言），只接受本人对话里该导师的回复
  let ref = sessionId ? `session:${sessionId}` : null;
  const m = String(req.body?.message_ref || '').match(/^(msg|gmsg):(\d+)$/);
  if (m) {
    const own = m[1] === 'msg'
      ? db.prepare("SELECT 1 FROM messages x JOIN conversations c ON c.id = x.conv_id WHERE x.id = ? AND c.user_id = ? AND x.role = 'assistant' AND x.agent_key = ?").get(Number(m[2]), req.user.id, key)
      : db.prepare("SELECT 1 FROM group_messages x JOIN group_sessions g ON g.id = x.session_id WHERE x.id = ? AND g.user_id = ? AND x.speaker_key = ?").get(Number(m[2]), req.user.id, key);
    if (!own) throw new AppError(404, 'NOT_FOUND', '没有这条回复。');
    ref = `${m[1]}:${m[2]}`;
  }
  db.prepare(`INSERT INTO mentor_feedback(user_id, mentor_key, message_ref, rating, reason_tags_json, comment, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run(req.user.id, key, ref, helpful ? 'helpful' : 'unhelpful', JSON.stringify(reasons), note, nowLocal());
  res.json({ ok: true });
});

// ---------- 会议 ----------
r.get('/group/sessions', requireStudent, (req, res) => {
  const list = db.prepare('SELECT * FROM group_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.user.id)
    .map((s) => {
      const row = { ...publicSession(s) };
      const count = db.prepare("SELECT COUNT(*) AS n FROM group_messages WHERE session_id = ? AND speaker_type = 'mentor'").get(s.id).n;
      return { ...row, mentor_speech_count: count };
    });
  res.json({ sessions: list });
});

r.post('/group/sessions', requireStudent, (req, res) => {
  const mode = getMode(String(req.body?.mode || ''));
  if (!mode) throw new AppError(400, 'BAD_MODE', '没有这种会议类型。');
  if (mode.stage && mode.stage > CURRENT_STAGE) throw new AppError(403, 'NOT_OPEN', '这种会议在后续阶段开放。');

  // 会议类型决定用哪把 Key（5.2 分级表）：缺 Key 或额度不足时立刻给出中文提示
  const moduleId = mode.tier === 'basic' ? 'M18_basic' : 'M18_full';
  resolveKey(req.user, moduleId, req.get('X-User-Key'));

  const prefs = mentorPrefs(req.user.id);
  const pool = mentorPool(req.user, mode);
  // 学生指定的参会导师（不能超过4位），默认用会议默认名单
  let mentors = Array.isArray(req.body?.mentors) && req.body.mentors.length
    ? req.body.mentors.filter((k) => pool.includes(k)).slice(0, 4)
    : resolveDefaultMentors(req.user, mode);
  mentors = mentors.filter((k) => !prefs.muted.has(k));
  if (!mentors.length) throw new AppError(400, 'NO_MENTOR', '至少需要一位导师才能开会。');

  const session = createSession(req.user, mode, mentors);
  addMessage(session.id, { speakerType: 'host', speakerKey: 'host', content: `本次「${mode.name}」参会导师：${mentors.map((k) => getAgent(k).name).join('、')}。${mode.question}` });
  res.json({ session: publicSession(session, { withMessages: true }) });
});

r.get('/group/sessions/:id', requireStudent, (req, res) => {
  const s = ownSession(req.user.id, req.params.id);
  if (!s) throw new AppError(404, 'NOT_FOUND', '没有这场会议。');
  res.json({ session: publicSession(s, { withMessages: true }), mock: getLlmConfig().mock });
});

/** 邀请一位导师进场 */
r.post('/group/sessions/:id/invite', requireStudent, (req, res) => {
  const s = ownSession(req.user.id, req.params.id);
  if (!s) throw new AppError(404, 'NOT_FOUND', '没有这场会议。');
  if (s.status !== 'open') throw new AppError(400, 'CLOSED', '这场会议已经结束了。');
  const key = String(req.body?.mentor || '');
  if (!getAgent(key)) throw new AppError(404, 'NO_MENTOR', '没有这位导师。');
  const mode = getMode(s.mode);
  const pool = mentorPool(req.user, mode);
  if (!pool.includes(key)) throw new AppError(400, 'NOT_IN_POOL', '这位导师不在本次会议的候选里。');
  const list = JSON.parse(s.mentors_json || '[]');
  // 已在场但被静音的：邀请 = 解除静音（这符合学生点“邀请”的意图）
  if (list.includes(key)) {
    if (mentorPrefs(req.user.id).muted.has(key)) {
      setMentorPref(req.user.id, key, { muted: false });
      addMessage(s.id, { speakerType: 'host', speakerKey: 'host', content: `${displayName(getAgent(key))} 已解除静音。` });
      return res.json({ session: publicSession(db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(s.id), { withMessages: true }) });
    }
    throw new AppError(400, 'ALREADY_IN', '这位导师已经在场了。');
  }
  if (list.length >= 4) throw new AppError(400, 'TOO_MANY', '一场会议最多4位导师。');
  // 静音状态下邀请 = 解除静音
  if (mentorPrefs(req.user.id).muted.has(key)) setMentorPref(req.user.id, key, { muted: false });
  list.push(key);
  db.prepare('UPDATE group_sessions SET mentors_json = ? WHERE id = ?').run(JSON.stringify(list), s.id);
  addMessage(s.id, { speakerType: 'host', speakerKey: 'host', content: `${displayName(getAgent(key))} 加入了会议。` });
  res.json({ session: publicSession(db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(s.id), { withMessages: true }) });
});

/** 静音 / 请出 / 解除静音 */
r.post('/group/sessions/:id/mute', requireStudent, (req, res) => {
  const s = ownSession(req.user.id, req.params.id);
  if (!s) throw new AppError(404, 'NOT_FOUND', '没有这场会议。');
  const key = String(req.body?.mentor || '');
  if (!getAgent(key)) throw new AppError(404, 'NO_MENTOR', '没有这位导师。');
  const muted = req.body?.muted !== false;
  const remove = req.body?.remove === true;
  setMentorPref(req.user.id, key, { muted });
  const list = JSON.parse(s.mentors_json || '[]').filter((k) => !(remove && k === key));
  db.prepare('UPDATE group_sessions SET mentors_json = ? WHERE id = ?').run(JSON.stringify(list), s.id);
  addMessage(s.id, {
    speakerType: 'host', speakerKey: 'host',
    content: remove ? `${displayName(getAgent(key))} 已请出会议。` : muted ? `${displayName(getAgent(key))} 已静音，本轮起不再发言。` : `${displayName(getAgent(key))} 已解除静音。`,
  });
  res.json({ session: publicSession(db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(s.id), { withMessages: true }) });
});

/** 结束会议：生成纪要（行动项需要学生确认才写入方案） */
r.post('/group/sessions/:id/close', requireStudent, async (req, res) => {
  const u = req.user;
  const s = ownSession(u.id, req.params.id);
  if (!s) throw new AppError(404, 'NOT_FOUND', '没有这场会议。');
  if (s.status !== 'open') throw new AppError(400, 'CLOSED', '这场会议已经结束了。');
  const mode = getMode(s.mode);
  const moduleId = mode.tier === 'basic' ? 'M18_basic' : 'M18_full';
  const { key, source } = resolveKey(u, moduleId, req.get('X-User-Key'));

  const msgs = sessionMessages(s.id).filter((m) => m.options_json === null);
  const talk = msgs.slice(-16).map((m) => {
    if (m.speaker_type === 'user') return `学生：${m.content.replace(/\n+/g, ' ').slice(0, 300)}`;
    if (m.speaker_type === 'host') return `司南：${m.content.replace(/\n+/g, ' ').slice(0, 200)}`;
    const a = getAgent(m.speaker_key);
    return `${a ? a.name : '导师'}：${m.content.replace(/\n+/g, ' ').slice(0, 300)}`;
  }).join('\n');

  let summary = null;
  try {
    const prompt = {
      system: renderPrompt('group_summary', {
        ...userBrief(u),
        共同规则: commonRules(),
        会议类型: mode.name,
        主题: mode.question,
        姓名: u.name,
        本场对话: talk,
        会议摘要: s.summary_json ? '（见上）' : '（无）',
      }),
      user: '请生成会议纪要，只输出 JSON。',
    };
    const out = await generateJson({ user: u, moduleId, purpose: '会议纪要', prompt, key, source, maxTokens: 1200, temperature: 0.3 });
    summary = out.data;
  } catch (e) {
    console.warn('[导师团] 纪要生成失败：', e?.code || e?.message);
  }
  if (!summary) summary = { points: [], decision: '尚未决定', actions: [] };

  const actions = (Array.isArray(summary.actions) ? summary.actions : []).slice(0, 3).map((a, i) => ({
    id: i + 1,
    title: String(a.title || '').slice(0, 120),
    kind: ['英语', '数学', '政治', '专业课', '成果', '阅读', 'AI技能', '复盘'].includes(a.kind) ? a.kind : '专业课',
    minutes: Math.max(5, Math.min(240, Number(a.minutes) || 30)),
    confirmed: false,
  }));

  db.prepare(`UPDATE group_sessions SET summary_json = ?, action_items_json = ?, status = 'closed', closed_at = ? WHERE id = ?`)
    .run(JSON.stringify({ points: summary.points || [], decision: summary.decision || '尚未决定', ...(s.twin_joined ? { draft: true } : {}) }), JSON.stringify(actions), nowLocal(), s.id);
  addMessage(s.id, { speakerType: 'host', speakerKey: 'host', content: s.twin_joined
    ? `会议纪要（草稿）已生成：${(summary.points || []).join('；') || '（无要点）'}。分身参加了这场会议，请你本人先确认或否决纪要，之后才能确认行动项。`
    : `会议纪要已生成：${(summary.points || []).join('；') || '（无要点）'}。行动项需要你确认后才会写入学习方案。`, isDraft: !!s.twin_joined });

  // 会议后整理导师级记忆（失败不影响纪要）
  const spoken = msgs.filter((m) => m.speaker_type === 'mentor');
  for (const k of [...new Set(spoken.map((m) => m.speaker_key))]) {
    const mine = spoken.filter((m) => m.speaker_key === k).map((m) => m.content).join('\n');
    await organizeMentorMemory({ user: u, mentorKey: k, content: `会议类型：${mode.name}\n${talk.slice(0, 1500)}\n\n${displayName(getAgent(k))} 的发言：\n${mine.slice(0, 1000)}`, key, source });
  }

  res.json({ session: publicSession(db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(s.id), { withMessages: true }) });
});

/** 确认行动项 → 才写入学习方案（M7） */
r.post('/group/sessions/:id/actions/confirm', requireStudent, (req, res) => {
  const u = req.user;
  const s = ownSession(u.id, req.params.id);
  if (!s) throw new AppError(404, 'NOT_FOUND', '没有这场会议。');
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  const actions = JSON.parse(s.action_items_json || '[]');
  if (!actions.length) throw new AppError(400, 'NO_ACTIONS', '这场会议没有行动项。');
  const sum = JSON.parse(s.summary_json || '{}');
  if (sum.draft) throw new AppError(400, 'DRAFT', '分身参加了这场会议，纪要还是草稿。请先确认或否决纪要，再确认行动项。');

  const chosen = actions.filter((a) => ids.includes(a.id));
  if (req.body?.confirm !== false && !chosen.length) throw new AppError(400, 'NONE_SELECTED', '请至少勾选一条行动项。');

  const plan = db.prepare('SELECT id FROM plans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(u.id);
  const date = req.body?.date && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date) ? req.body.date : todayLocal();
  const ins = db.prepare('INSERT INTO tasks(user_id, plan_id, date, title, kind, minutes, done) VALUES(?, ?, ?, ?, ?, ?, 0)');
  for (const a of chosen) { ins.run(u.id, plan?.id || null, date, a.title, a.kind, a.minutes); logAction(u.id, 'group_action', s.id, 'confirm'); }

  const updated = actions.map((a) => ({ ...a, confirmed: ids.includes(a.id) ? true : a.confirmed }));
  db.prepare('UPDATE group_sessions SET action_items_json = ? WHERE id = ?').run(JSON.stringify(updated), s.id);
  if (chosen.length && flowStatusOf(u.id, 6) === 'not_started') setFlowStatus(u.id, 6, 'in_progress');

  res.json({
    session: publicSession(db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(s.id), { withMessages: true }),
    added: chosen.map((a) => ({ title: a.title, date, minutes: a.minutes })),
  });
});

// ---------- 一轮对话（SSE） ----------
r.post('/group/sessions/:id/send', requireStudent, sendLimit, async (req, res) => {
  const u = req.user;
  const s = ownSession(u.id, req.params.id);
  if (!s) throw new AppError(404, 'NOT_FOUND', '没有这场会议。');
  if (s.status !== 'open') throw new AppError(400, 'CLOSED', '这场会议已经结束了，可以重新开一场。');
  const mode = getMode(s.mode);
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) throw new AppError(400, 'EMPTY', '请输入内容或点选一个选项。');
  if (text.length > 2000) throw new AppError(400, 'TOO_LONG', '一次最多输入2000字。');

  // 轮数上限：每轮学生发言算一轮
  const rounds = db.prepare("SELECT COUNT(*) AS n FROM group_messages WHERE session_id = ? AND speaker_type = 'user'").get(s.id).n;
  if (rounds >= MAX_ROUNDS) throw new AppError(400, 'MAX_ROUNDS', '这场会议已经聊得够多了，先把决定落到行动上吧。可以结束会议生成纪要。');

  const moduleId = mode.tier === 'basic' ? 'M18_basic' : 'M18_full';
  // Key 与额度在打开 SSE 之前确认，出错时前端能保留输入
  const { key, source } = resolveKey(u, moduleId, req.get('X-User-Key'));
  const llm = getLlmConfig();

  const userMsg = addMessage(s.id, { speakerType: 'user', speakerKey: null, content: text });

  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let open = true;
  res.on('close', () => { open = false; });
  const emit = (event, data) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  emit('meta', { session_id: s.id, user_message_id: userMsg.id, mock: llm.mock, round: rounds + 1, max_rounds: MAX_ROUNDS });

  const spoken = [];
  try {
    const prefs = mentorPrefs(u.id);
    let inSession = JSON.parse(s.mentors_json || '[]');
    // @ 的导师如果还没在场，按 PRD“@导师名时由被点名的导师先回答”自动请进来
    // （静音的导师除外：被静音的导师不会发言）
    const pool = mentorPool(u, mode);
    const mentionedAll = parseMentions(u.id, text, pool);
    const invited = [];
    for (const k of mentionedAll) {
      if (prefs.muted.has(k)) continue;
      if (!inSession.includes(k) && inSession.length < 4) {
        inSession.push(k);
        invited.push(k);
      }
    }
    if (invited.length) {
      db.prepare('UPDATE group_sessions SET mentors_json = ? WHERE id = ?').run(JSON.stringify(inSession), s.id);
      emit('mentor_joined', { keys: invited, names: invited.map((k) => displayName(getAgent(k))) });
    }

    const allowed = inSession.filter((k) => !prefs.muted.has(k));
    const mentions = mentionedAll.filter((k) => allowed.includes(k));

    // 1) 司南选人
    const plan = await planRound({ user: u, session: { ...s, mentors_json: JSON.stringify(inSession) }, mode, text, mentions, key, source });
    const speakers = plan.speakers.filter((sp) => allowed.includes(sp.key));
    if (!speakers.length) throw new AppError(400, 'NO_SPEAKER', '在场导师都被静音了，请先解除静音或邀请一位导师。');
    emit('host_plan', {
      note: plan.note_for_ui,
      degraded: plan.degraded,
      speakers: speakers.map((sp) => ({ key: sp.key, name: displayName(getAgent(sp.key)), focus: sp.focus })),
    });

    // 2) 导师依次流式发言
    for (const sp of speakers) {
      emit('speaker_start', { key: sp.key, name: displayName(getAgent(sp.key)), focus: sp.focus });
      let full = '';
      try {
        const rt = mentorRuntime(sp.key, `${text}
${sp.focus}`);
        const system = speakerPrompt({ user: u, session: s, mode, mentorKey: sp.key, focus: sp.focus, latestUserText: text }) + (rt.block ? `

${rt.block}` : '');
        const history = recentContext(s.id, 6);
        const out = await streamChat({
          baseUrl: llm.baseUrl, key, model: llm.chatModel, source,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `【本场最近的发言】\n${history}\n\n学生刚说：${text}\n\n请按你的焦点发言（不超过150字，不要给选项、不要写 JSON 代码块）。` },
          ],
          maxTokens: 800,
          onDelta: (t) => { full += t; emit('delta', { text: t, key: sp.key }); },
        });
        recordCall({ userId: u.id, kind: moduleId, purpose: `导师团发言（${displayName(getAgent(sp.key))}）`, model: out.model, source, usage: out.usage, error: out.usage?.estimated ? 'usage_estimated' : null });
        // 导师发言里若混进了选项代码块，剥掉
        const clean = splitReply(out.content).body || out.content;
        const cited = citedSources(clean, rt.sources);
        addMessage(s.id, { speakerType: 'mentor', speakerKey: sp.key, content: clean, sources: cited });
        spoken.push({ key: sp.key, text: clean });
        emit('speaker_end', { key: sp.key, sources: cited });
      } catch (e) {
        // 某位导师失败时不影响其他人（7.5 失败处理）
        const code = e instanceof AppError ? e.code : 'LLM_FAILED';
        const msg = e instanceof AppError ? e.message : '这位导师暂时没能发言。';
        console.warn('[导师团] 导师发言失败：', code, '|', e?.message, '|', e?.stack?.split('\n')[1]?.trim());
        recordCall({ userId: u.id, kind: moduleId, purpose: `导师团发言（${displayName(getAgent(sp.key))}）`, model: llm.chatModel, source, usage: null, ok: false, error: code });
        addMessage(s.id, { speakerType: 'host', speakerKey: 'host', content: `${displayName(getAgent(sp.key))}暂时没能发言：${msg}` });
        emit('speaker_end', { key: sp.key, error: msg, sources: [] });
      }
    }

    if (!spoken.length) throw new AppError(502, 'NO_SPEECH', '这几位导师都没能发言，请稍后再试。');

    // 3) 司南收束本轮
    const sum = await summarizeRound({ user: u, mode, spoken, key, source, moduleId });
    emit('host_summary', { consensus: sum.consensus, divergence: sum.divergence, decide: sum.decide, degraded: sum.degraded });

    const optionsMsg = addMessage(s.id, {
      speakerType: 'host', speakerKey: 'host',
      content: `共识：${sum.consensus}\n分歧：${sum.divergence}\n需要你决定：${sum.decide}`,
      options: { options: sum.options, multi: false, free_text: true },
    });
    emit('options', { message_id: optionsMsg.id, options: sum.options, multi: false, free_text: true });
    emit('done', { session_id: s.id, round: rounds + 1, max_rounds: MAX_ROUNDS });
  } catch (e) {
    const code = e instanceof AppError ? e.code : 'INTERNAL';
    const message = e instanceof AppError ? e.message : '出了点问题，请稍后重试。';
    if (!(e instanceof AppError)) console.error('[导师团] 未预期的错误：', redact(e?.stack || e));
    // 撤回本轮学生发言，前端把原文放回输入框
    db.prepare('DELETE FROM group_messages WHERE id = ?').run(userMsg.id);
    emit('error', { code, message, restore_text: text });
  } finally {
    if (open) res.end();
  }
});

export default r;
