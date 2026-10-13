// M13 复试模拟智能体群（PRD M13、附录B.11/B.16）
// 流程：中文自我介绍 → 英文自我介绍与问答 → 专业问题 → 综合与情境问题 → 你有什么想问我们的
// 每一轮由主考衡言决定下一位考官（JSON），考官一次只问一个问题；环节顺序、问数上限、计时由服务端强制。
// 基础版：只有衡言、10分钟、每周2次，用平台 Key；完整考官组与分身彩排用学生自己的 Key。
import { Router } from 'express';
import { db } from '../db.js';
import { nowLocal, todayLocal, mondayOf } from '../time.js';
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
import { setFlowStatus, flowStatusOf } from '../stations.js';
import { getTwinRow, twinSpeakPrompt } from '../twin.js';

const r = Router();
const askLimit = rateLimit({ windowMs: 60 * 1000, max: 40, key: (req) => `iv:${req.user?.id}` });

export const DISCLAIMER = 'AI模拟，不代表真实院校考官，题目非真题。分数只用于练习，不进入成绩。';
export const BASIC_WEEKLY_LIMIT = 2;
export const SELF_REVIEW_MIN = 50;
const EXAMINER_OPTIONS = {
  '格物｜专业考官': 'examiner_major',
  '远帆｜英语考官': 'examiner_english',
  '守正｜综合考官': 'examiner_general',
  '鉴微｜导师视角': 'advisor_view',
};
const DIFFICULTIES = ['温和', '标准', '压力'];
const SCORE_KEYS = ['观点', '依据', '例证', '回应'];
// 开场、英文开场、收尾按真实复试流程用固定问法，不交给模型自由发挥
export const FIXED_FIRST = {
  中文自我介绍: '请用一分钟左右做一个中文自我介绍。',
  英文自我介绍与问答: 'Please introduce yourself in English in about one minute.',
  你有什么想问我们的: '最后，你有什么想问我们的吗？',
};

const EN_KEYS = ['清晰度', '流畅度', '词汇'];

/** 环节与每个环节的问数上限 */
function stagesFor(examiners) {
  const list = [{ name: '中文自我介绍', max: 1, fixed: 'interview' }];
  if (examiners.includes('examiner_english')) list.push({ name: '英文自我介绍与问答', max: 3, min: 2, fixed: 'examiner_english' });
  list.push({ name: '专业问题', max: 4, min: 2 });
  list.push({ name: '综合与情境问题', max: 3, min: 2 });
  list.push({ name: '你有什么想问我们的', max: 1, fixed: 'interview' });
  return list;
}

function parse(json, fallback) { try { return json ? JSON.parse(json) : fallback; } catch { return fallback; } }

function ownInterview(userId, id) {
  return db.prepare('SELECT * FROM mock_interviews WHERE id = ? AND user_id = ?').get(Number(id), userId);
}

function publicInterview(row) {
  const config = parse(row.config_json, {});
  const transcript = parse(row.transcript_json, []);
  const stages = stagesFor(config.examiners || ['interview']);
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(config.started_at || row.created_at).getTime()) / 1000));
  return {
    id: row.id,
    config,
    stages: stages.map((s) => s.name),
    stage_index: config.stage_index || 0,
    transcript,
    review: parse(row.review_json, null),
    scores: parse(row.scores_json, null),
    self_review: row.self_review || '',
    twin_rehearsal: parse(row.twin_rehearsal_json, null),
    status: row.self_review ? 'closed' : row.review_json ? 'reviewed' : config.ended ? 'ended' : 'running',
    remaining_sec: Math.max(0, config.duration * 60 - elapsed),
    created_at: row.created_at,
    disclaimer: DISCLAIMER,
  };
}

function basicUsedThisWeek(userId) {
  const monday = mondayOf(todayLocal());
  return db.prepare("SELECT COUNT(*) AS n FROM mock_interviews WHERE user_id = ? AND created_at >= ? AND json_extract(config_json, '$.tier') = 'basic'")
    .get(userId, monday).n;
}

function moduleOf(config) { return config.tier === 'basic' ? 'M13_basic' : 'M13_full'; }

/** 考生材料：画像、路径、阅读卡与选题卡标题（考官提问时可以引用） */
function candidateMaterials(userId) {
  const p = db.prepare('SELECT profile_json, chosen_path, choice_reason FROM profiles WHERE user_id = ?').get(userId);
  const prof = parse(p?.profile_json, null);
  const cards = db.prepare('SELECT question FROM reading_cards WHERE user_id = ? ORDER BY id DESC LIMIT 5').all(userId);
  const ideas = db.prepare("SELECT question FROM topic_ideas WHERE user_id = ? AND status != 'dropped' ORDER BY id DESC LIMIT 3").all(userId);
  return [
    `画像摘要：${prof?.summary || '（无）'}`,
    `所选路径：${p?.chosen_path || '（未选）'}${p?.choice_reason ? `；理由：${String(p.choice_reason).slice(0, 120)}` : ''}`,
    `阅读卡：${cards.map((c) => String(c.question).slice(0, 50)).join('；') || '（无）'}`,
    `选题卡：${ideas.map((i) => String(i.question).slice(0, 60)).join('；') || '（无）'}`,
  ].join('\n');
}

function pendingRetry(userId, exclude = []) {
  return db.prepare("SELECT * FROM interview_qbank WHERE user_id = ? AND status = '待重练' ORDER BY id").all(userId)
    .filter((q) => !exclude.includes(q.id));
}

/** 只保留一个问题：取第一行，截到第一个问号 */
export function oneQuestion(text) {
  let t = splitReply(String(text || '')).body || String(text || '');
  t = t.split('\n').map((x) => x.trim()).find((x) => x) || '';
  t = t.replace(/^(问题|考官|Q)\s*[:：]\s*/i, '').replace(/^["“「]|["”」]$/g, '').trim();
  const m = t.match(/^[\s\S]*?[？?]/);
  if (m) t = m[0];
  return t.slice(0, 160);
}

function recentDialogue(transcript, n = 6) {
  return transcript.slice(-n).map((x) => (x.type === 'q' ? `${displayName(getAgent(x.examiner))}：${x.text}` : `考生：${String(x.text).slice(0, 300)}`)).join('\n') || '（刚开始）';
}

// ---------- 接口 ----------

r.get('/interview/status', requireStudent, (req, res) => {
  const used = basicUsedThisWeek(req.user.id);
  const school = db.prepare("SELECT school, major FROM schools WHERE user_id = ? ORDER BY CASE tier WHEN '冲刺' THEN 2 WHEN '稳妥' THEN 1 ELSE 3 END, id LIMIT 1").get(req.user.id);
  const twin = getTwinRow(req.user.id);
  res.json({
    disclaimer: DISCLAIMER,
    basic: { used, limit: BASIC_WEEKLY_LIMIT, left: Math.max(0, BASIC_WEEKLY_LIMIT - used) },
    suggested_target: school ? `${school.school} ${school.major || ''}`.trim() : '',
    twin_ready: !!twin?.profile_json,
    qbank_pending: pendingRetry(req.user.id).length,
  });
});

r.get('/interview/sessions', requireStudent, (req, res) => {
  const rows = db.prepare('SELECT * FROM mock_interviews WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.user.id);
  res.json({ sessions: rows.map(publicInterview).map((x) => ({ ...x, transcript: undefined, question_count: x.transcript.filter((t) => t.type === 'q').length })) });
});

r.get('/interview/sessions/:id', requireStudent, (req, res) => {
  const row = ownInterview(req.user.id, req.params.id);
  if (!row) throw new AppError(404, 'NOT_FOUND', '没有这场模拟。');
  res.json({ session: publicInterview(row) });
});

/**
 * 开始一场模拟。body.tier: basic | full。
 * basic：只有衡言、10分钟、每周2次、平台 Key；full：自选考官、时长、难度、可选分身彩排，学生自己的 Key。
 */
r.post('/interview/sessions', requireStudent, (req, res) => {
  const u = req.user;
  const b = req.body || {};
  const tier = b.tier === 'full' ? 'full' : 'basic';
  const config = {
    tier,
    target: String(b.target || '').trim().slice(0, 60) || '（未填写目标院校）',
    form: b.form === '线上' ? '线上' : '线下',
    difficulty: DIFFICULTIES.includes(b.difficulty) ? b.difficulty : '标准',
    duration: 10,
    examiners: ['interview'],
    rehearsal: false,
  };
  if (tier === 'basic') {
    if (basicUsedThisWeek(u.id) >= BASIC_WEEKLY_LIMIT) throw new AppError(429, 'WEEKLY_LIMIT', `基础版每周可以练 ${BASIC_WEEKLY_LIMIT} 次，这周已经用完了。绑定自己的 Key 可以用完整考官组继续练。`);
    resolveKey(u, 'M13_basic', req.get('X-User-Key'));
  } else {
    resolveKey(u, 'M13_full', req.get('X-User-Key'));
    const picked = (Array.isArray(b.examiners) ? b.examiners : []).map((x) => EXAMINER_OPTIONS[x] || x).filter((k) => Object.values(EXAMINER_OPTIONS).includes(k));
    config.examiners = ['interview', ...new Set(picked)];
    config.duration = [10, 20, 30].includes(Number(b.duration)) ? Number(b.duration) : 20;
    config.rehearsal = b.rehearsal === true;
    if (config.rehearsal && !getTwinRow(u.id)?.profile_json) throw new AppError(400, 'NO_TWIN', '分身彩排需要先在“我 → 数字分身”生成分身档案。');
  }
  config.started_at = new Date().toISOString();
  config.stage_index = 0;
  config.stage_counts = {};
  config.asked_qbank = [];
  const info = db.prepare('INSERT INTO mock_interviews(user_id, config_json, transcript_json, created_at) VALUES(?, ?, ?, ?)')
    .run(u.id, JSON.stringify(config), '[]', nowLocal());
  if (flowStatusOf(u.id, 10) === 'not_started') setFlowStatus(u.id, 10, 'in_progress');
  res.json({ session: publicInterview(db.prepare('SELECT * FROM mock_interviews WHERE id = ?').get(info.lastInsertRowid)) });
});

/**
 * 回答上一题并拿到下一题（SSE）。第一次调用不带 text，直接出第一题。
 * 事件：meta → examiner → delta* → question →（twin_answer）→ done；时间到或环节走完时发 ended。
 */
r.post('/interview/sessions/:id/next', requireStudent, askLimit, async (req, res) => {
  const u = req.user;
  const row = ownInterview(u.id, req.params.id);
  if (!row) throw new AppError(404, 'NOT_FOUND', '没有这场模拟。');
  const config = parse(row.config_json, {});
  if (config.ended || row.review_json) throw new AppError(400, 'ENDED', '这场模拟已经结束了，可以查看复盘。');
  const transcript = parse(row.transcript_json, []);
  const text = String(req.body?.text || '').trim();
  const waiting = transcript.length && transcript[transcript.length - 1].type === 'q';
  if (waiting && !text) throw new AppError(400, 'NEED_ANSWER', '先回答当前的问题（也可以说“这题我不会”）。');
  if (text.length > 3000) throw new AppError(400, 'TOO_LONG', '一次最多3000字。');
  const { key, source } = resolveKey(u, moduleOf(config), req.get('X-User-Key'));
  const llm = getLlmConfig();

  if (waiting) transcript.push({ type: 'a', text, at: nowLocal() });

  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let open = true;
  res.on('close', () => { open = false; });
  const emit = (ev, data) => { if (open) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
  const save = () => db.prepare('UPDATE mock_interviews SET config_json = ?, transcript_json = ? WHERE id = ?').run(JSON.stringify(config), JSON.stringify(transcript), row.id);

  try {
    const stages = stagesFor(config.examiners);
    const elapsed = Math.floor((Date.now() - new Date(config.started_at).getTime()) / 1000);
    const remaining = config.duration * 60 - elapsed;
    const end = (reason) => {
      config.ended = true;
      save();
      emit('ended', { reason, message: reason === 'time' ? '时间到了，模拟结束。点“生成复盘”看看每位考官的评价。' : '五个环节都走完了，模拟结束。点“生成复盘”看看每位考官的评价。' });
    };
    if (remaining <= 0) return end('time');

    // 1) 环节推进：当前环节问满了就进入下一环节
    let idx = config.stage_index || 0;
    const countOf = (i) => config.stage_counts[i] || 0;
    if (countOf(idx) >= stages[idx].max) idx += 1;
    if (idx >= stages.length) return end('done');

    // 2) 决定考官与方向：题库优先 → 固定考官的环节 → 主考衡言编排
    const askedTexts = transcript.filter((x) => x.type === 'q').map((x) => x.text);
    let examiner = stages[idx].fixed || null;
    let hint = '';
    let verbatim = null;
    let fromQbank = false;
    const retry = pendingRetry(u.id, config.asked_qbank);
    if (countOf(idx) === 0 && FIXED_FIRST[stages[idx].name]) {
      verbatim = FIXED_FIRST[stages[idx].name];
      examiner = stages[idx].fixed || examiner;
    } else if (!stages[idx].fixed && stages[idx].name === '专业问题' && countOf(idx) === 0 && retry.length) {
      const q = retry[0];
      verbatim = q.question;
      fromQbank = true;
      examiner = config.examiners.includes(q.examiner_key) ? q.examiner_key : (config.examiners.includes('examiner_major') ? 'examiner_major' : 'interview');
      config.asked_qbank.push(q.id);
    } else if (!examiner) {
      try {
        const listText = config.examiners.filter((k) => k !== 'examiner_english').map((k) => `- ${displayName(getAgent(k))}（key=${k}）：${getAgent(k).summary}`).join('\n');
        const { data } = await generateJson({
          user: u, moduleId: moduleOf(config), purpose: '复试编排', key, source, maxTokens: 600, temperature: 0.3,
          prompt: {
            system: renderPrompt('interview_host', {
              ...userBrief(u), 共同规则: commonRules(), 目标院校: config.target, 难度: config.difficulty,
              环节: stages[idx].name, 本环节已问: countOf(idx), 剩余分钟: Math.ceil(remaining / 60),
              考官列表: listText, 已问问题: askedTexts.map((q) => `- ${q}`).join('\n') || '（无）',
              上一回答: text ? text.slice(0, 600) : '（还没有）',
              待重练: retry.map((q) => `- ${q.question}`).join('\n') || '（无）',
            }),
            user: '请决定下一位提问的考官，只输出 JSON。',
          },
        });
        if (data?.intent === '进入下一环节' && countOf(idx) >= (stages[idx].min || 1)) {
          idx += 1;
          if (idx >= stages.length) return end('done');
        }
        if (data?.intent === '结束' && idx >= stages.length - 1 && countOf(idx) >= 1) return end('done');
        examiner = stages[idx].fixed || (config.examiners.includes(data?.next_examiner) && data.next_examiner !== 'examiner_english' ? data.next_examiner : null);
        hint = String(data?.hint || '').slice(0, 120);
      } catch (e) {
        console.warn('[复试] 衡言编排失败，按默认顺序：', e?.code || e?.message);
      }
      if (!examiner) {
        // 降级：专业环节优先格物，综合环节优先守正 / 鉴微，否则衡言
        const prefer = stages[idx].name === '专业问题' ? ['examiner_major', 'advisor_view'] : ['examiner_general', 'advisor_view'];
        examiner = prefer.find((k) => config.examiners.includes(k)) || 'interview';
      }
    }
    if (!hint) hint = `围绕“${stages[idx].name}”提一个问题`;
    config.stage_index = idx;

    const a = getAgent(examiner);
    emit('meta', { stage: stages[idx].name, stage_index: idx, stages: stages.map((s) => s.name), remaining_sec: remaining, question_no: askedTexts.length + 1 });
    emit('examiner', { key: examiner, name: a.name, duty: a.duty });

    // 3) 考官提问（一次只问一个问题）
    let question;
    if (verbatim) {
      question = verbatim;
      emit('delta', { text: question });
    } else {
      const out = await streamChat({
        baseUrl: llm.baseUrl, key, model: llm.chatModel, source, maxTokens: 300, temperature: 0.6,
        messages: [
          { role: 'system', content: renderPrompt('interview_ask', {
            ...userBrief(u), 考官名: a.name, 考官职责: a.duty, 考官语气: a.tone || '',
            问题方向: hint, 环节: stages[idx].name, 难度: config.difficulty,
            考生材料: candidateMaterials(u.id), 最近对话: recentDialogue(transcript),
          }) },
          { role: 'user', content: '请提问。' },
        ],
        onDelta: (t) => emit('delta', { text: t }),
      });
      recordCall({ userId: u.id, kind: moduleOf(config), purpose: `复试提问（${a.name}）`, model: out.model, source, usage: out.usage });
      question = oneQuestion(out.content) || '请再详细说说你刚才的回答。';
    }
    config.stage_counts[idx] = countOf(idx) + 1;
    const item = { type: 'q', examiner, stage: stages[idx].name, text: question, at: nowLocal(), ...(fromQbank ? { from_qbank: true } : {}) };
    emit('question', { text: question, examiner, from_qbank: fromQbank });

    // 4) 分身彩排：分身先按档案作答一遍（草稿），本人再答
    if (config.rehearsal) {
      try {
        const twin = getTwinRow(u.id);
        const tw = await streamChat({
          baseUrl: llm.baseUrl, key, model: llm.chatModel, source, maxTokens: 600,
          messages: [
            { role: 'system', content: twinSpeakPrompt(u, twin, 'rehearsal', '考官刚问了一个问题，你按档案里本人的表达习惯作答一次（不超过150字），供本人对照。档案里没有的经历不要编。') },
            { role: 'user', content: `考官问：${question}` },
          ],
        });
        recordCall({ userId: u.id, kind: 'M19_full', purpose: '分身复试彩排', model: tw.model, source, usage: tw.usage });
        let t = splitReply(tw.content).body || tw.content;
        if (!t.includes('分身推测')) t = `【分身推测】${t}`;
        item.twin_answer = t;
        emit('twin_answer', { text: t });
      } catch (e) {
        emit('twin_answer', { text: '', error: '分身这次没能彩排，你直接作答就好。' });
      }
    }
    transcript.push(item);
    save();
    emit('done', { remaining_sec: remaining, stage: stages[idx].name });
  } catch (e) {
    // 失败：撤回本轮回答，前端放回输入框
    if (waiting) transcript.pop();
    const code = e instanceof AppError ? e.code : 'INTERNAL';
    if (!(e instanceof AppError)) console.error('[复试] 未预期的错误：', redact(e?.stack || e));
    emit('error', { code, message: e instanceof AppError ? e.message : '出了点问题，请稍后重试。', restore_text: text });
  } finally {
    if (open) res.end();
  }
});

/** 结束并生成复盘：每位考官四项打分并写理由；答得不好的问题进入复试问题库 */
r.post('/interview/sessions/:id/finish', requireStudent, async (req, res) => {
  const u = req.user;
  const row = ownInterview(u.id, req.params.id);
  if (!row) throw new AppError(404, 'NOT_FOUND', '没有这场模拟。');
  if (row.review_json) return res.json({ session: publicInterview(row) });
  const config = parse(row.config_json, {});
  const transcript = parse(row.transcript_json, []);
  const answered = transcript.filter((x) => x.type === 'a').length;
  if (!answered) throw new AppError(400, 'NO_ANSWER', '还没有回答过任何问题，先答一题再结束。');
  const { key, source } = resolveKey(u, moduleOf(config), req.get('X-User-Key'));

  const record = transcript.map((x) => (x.type === 'q'
    ? `考官（${displayName(getAgent(x.examiner))}）问：${x.text}`
    : `考生答：${String(x.text).slice(0, 800)}`)).join('\n');
  const hasEnglish = config.examiners.includes('examiner_english') && transcript.some((x) => x.type === 'q' && x.stage?.includes('英文'));
  const { data } = await generateJson({
    user: u, moduleId: moduleOf(config), purpose: '复试复盘', key, source, maxTokens: 2500, temperature: 0.3,
    prompt: {
      system: renderPrompt('interview_review', {
        ...userBrief(u), 共同规则: commonRules(),
        考官列表: config.examiners.map((k) => `${displayName(getAgent(k))}（key=${k}）`).join('、'),
        有英文: hasEnglish ? '有' : '没有',
        记录: record,
      }),
      user: '请生成复盘，只输出 JSON。',
    },
  });
  const review = normalizeReview(data, config.examiners, transcript, hasEnglish);
  config.ended = true;

  // 进入题库：复盘点名的问题 + 每位考官“最差的问题”，只收真正问过的
  const asked = transcript.filter((x) => x.type === 'q');
  const toBank = new Map();
  for (const q of [...review.retry_questions, ...review.examiners.map((e) => e.worst_question)]) {
    const hit = asked.find((x) => x.text === q) || asked.find((x) => q && (x.text.includes(q) || q.includes(x.text)));
    // 固定的开场 / 收尾问题不进题库（下次会被当成专业题重练）
    if (hit && !Object.values(FIXED_FIRST).includes(hit.text)) toBank.set(hit.text, hit.examiner);
  }
  const have = new Set(db.prepare('SELECT question FROM interview_qbank WHERE user_id = ?').all(u.id).map((x) => x.question));
  let added = 0;
  for (const [q, ex] of toBank) {
    if (have.has(q)) {
      // 重练后又答得不好：退回“待重练”
      db.prepare("UPDATE interview_qbank SET status = '待重练' WHERE user_id = ? AND question = ?").run(u.id, q);
      continue;
    }
    db.prepare("INSERT INTO interview_qbank(user_id, question, source, examiner_key, status, created_at) VALUES(?, ?, ?, ?, '待重练', ?)")
      .run(u.id, q, `模拟#${row.id}`, ex, nowLocal());
    added += 1;
  }
  review.qbank_added = added;

  const twinPairs = config.rehearsal
    ? asked.map((q) => ({ question: q.text, twin: q.twin_answer || '', me: transcript[transcript.indexOf(q) + 1]?.type === 'a' ? transcript[transcript.indexOf(q) + 1].text : '' }))
    : null;
  db.prepare('UPDATE mock_interviews SET config_json = ?, review_json = ?, scores_json = ?, twin_rehearsal_json = ? WHERE id = ?')
    .run(JSON.stringify(config), JSON.stringify(review), JSON.stringify(review.examiners.map((e) => ({ key: e.key, scores: e.scores }))), twinPairs ? JSON.stringify(twinPairs) : null, row.id);
  res.json({ session: publicInterview(db.prepare('SELECT * FROM mock_interviews WHERE id = ?').get(row.id)) });
});

/** 复盘规范化：只保留在场考官；每个分数必须有理由，没有理由的分数不算（置空并说明） */
export function normalizeReview(data, examiners, transcript, hasEnglish) {
  const clampScore = (v) => { const n = Math.round(Number(v)); return n >= 1 && n <= 5 ? n : null; };
  const list = (Array.isArray(data?.examiners) ? data.examiners : []).filter((e) => examiners.includes(e?.key));
  const byKey = new Map(list.map((e) => [e.key, e]));
  const out = examiners.filter((k) => byKey.has(k) || k === 'interview').map((k) => {
    const e = byKey.get(k) || {};
    const scores = {};
    const reasons = {};
    for (const s of SCORE_KEYS) {
      const reason = String(e.reasons?.[s] || '').trim().slice(0, 300);
      const score = clampScore(e.scores?.[s]);
      if (reason && score) { scores[s] = score; reasons[s] = reason; } else { scores[s] = null; reasons[s] = '复盘没有给出理由，这一项不评分。'; }
    }
    return { key: k, name: displayName(getAgent(k)), scores, reasons, best_moment: String(e.best_moment || '').slice(0, 200), worst_question: String(e.worst_question || '').slice(0, 200) };
  });
  const en = data?.english || {};
  const english = hasEnglish
    ? { ...Object.fromEntries(EN_KEYS.map((k) => [k, clampScore(en[k])])), comment: String(en.comment || '').slice(0, 300) }
    : null;
  const asked = transcript.filter((x) => x.type === 'q').map((x) => x.text);
  return {
    examiners: out,
    english,
    top3: (Array.isArray(data?.top3) ? data.top3 : []).map((x) => String(x).slice(0, 160)).filter(Boolean).slice(0, 3),
    retry_questions: (Array.isArray(data?.retry_questions) ? data.retry_questions : []).map(String).filter((q) => asked.some((a) => a === q || a.includes(q) || q.includes(a))).slice(0, 6),
    note: DISCLAIMER,
  };
}

/** 自评（≥50字）后才能关闭复盘 */
r.post('/interview/sessions/:id/self-review', requireStudent, (req, res) => {
  const row = ownInterview(req.user.id, req.params.id);
  if (!row) throw new AppError(404, 'NOT_FOUND', '没有这场模拟。');
  if (!row.review_json) throw new AppError(400, 'NO_REVIEW', '先生成复盘，再写自评。');
  const text = String(req.body?.text || '').trim();
  const len = [...text.replace(/\s/g, '')].length;
  if (len < SELF_REVIEW_MIN) throw new AppError(400, 'SELF_REVIEW_SHORT', `自评至少写 ${SELF_REVIEW_MIN} 字才能关闭复盘（现在 ${len} 字）。说说哪题答得不好、下次怎么改。`);
  db.prepare('UPDATE mock_interviews SET self_review = ? WHERE id = ?').run(text.slice(0, 3000), row.id);
  setFlowStatus(req.user.id, 10, 'done');
  res.json({ session: publicInterview(db.prepare('SELECT * FROM mock_interviews WHERE id = ?').get(row.id)) });
});

/** 导出复盘记录（Markdown） */
r.get('/interview/sessions/:id/export', requireStudent, (req, res) => {
  const row = ownInterview(req.user.id, req.params.id);
  if (!row) throw new AppError(404, 'NOT_FOUND', '没有这场模拟。');
  const s = publicInterview(row);
  const lines = [`# 复试模拟复盘（${s.created_at}）`, '', `> ${DISCLAIMER}`, '', `- 目标：${s.config.target}`, `- 难度：${s.config.difficulty}｜时长：${s.config.duration}分钟｜考官：${s.config.examiners.map((k) => displayName(getAgent(k))).join('、')}`, '', '## 问答记录', ''];
  for (const x of s.transcript) {
    if (x.type === 'q') lines.push(`**${displayName(getAgent(x.examiner))}（${x.stage}）**：${x.text}`, '', ...(x.twin_answer ? [`> 分身版：${x.twin_answer}`, ''] : []));
    else lines.push(`我：${x.text}`, '');
  }
  if (s.review) {
    lines.push('## 考官复盘', '');
    for (const e of s.review.examiners) {
      lines.push(`### ${e.name}`, '');
      for (const k of SCORE_KEYS) lines.push(`- ${k}：${e.scores[k] ?? '—'} 分。${e.reasons[k]}`);
      lines.push('');
    }
    if (s.review.english) lines.push(`英语：清晰度 ${s.review.english['清晰度'] ?? '—'}，流畅度 ${s.review.english['流畅度'] ?? '—'}，词汇 ${s.review.english['词汇'] ?? '—'}。${s.review.english.comment}`, '');
    lines.push('## 最优先的三条改进', '', ...s.review.top3.map((t, i) => `${i + 1}. ${t}`), '');
  }
  if (s.self_review) lines.push('## 我的自评', '', s.self_review, '');
  res.set({ 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`复试模拟复盘-${s.created_at.slice(0, 10)}`)}.md` });
  res.send(lines.join('\n'));
});

// ---------- 我的复试问题库（知识库备考空间） ----------

r.get('/interview/qbank', requireStudent, (req, res) => {
  const rows = db.prepare('SELECT * FROM interview_qbank WHERE user_id = ? ORDER BY CASE status WHEN \'待重练\' THEN 0 ELSE 1 END, id DESC').all(req.user.id);
  res.json({ items: rows.map((q) => ({ id: q.id, question: q.question, source: q.source, examiner: q.examiner_key ? displayName(getAgent(q.examiner_key)) : '', my_notes: q.my_notes || '', status: q.status, created_at: q.created_at })) });
});

r.post('/interview/qbank', requireStudent, (req, res) => {
  const q = String(req.body?.question || '').trim().slice(0, 300);
  if (!q) throw new AppError(400, 'EMPTY', '请填写问题。');
  db.prepare("INSERT INTO interview_qbank(user_id, question, source, status, created_at) VALUES(?, ?, '自己添加', '待重练', ?)").run(req.user.id, q, nowLocal());
  res.json({ ok: true });
});

r.put('/interview/qbank/:id', requireStudent, (req, res) => {
  const q = db.prepare('SELECT * FROM interview_qbank WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!q) throw new AppError(404, 'NOT_FOUND', '没有这道题。');
  if (req.body?.status !== undefined) db.prepare('UPDATE interview_qbank SET status = ? WHERE id = ?').run(req.body.status === '已重练' ? '已重练' : '待重练', q.id);
  if (req.body?.my_notes !== undefined) db.prepare('UPDATE interview_qbank SET my_notes = ? WHERE id = ?').run(String(req.body.my_notes).slice(0, 1000), q.id);
  res.json({ ok: true });
});

r.delete('/interview/qbank/:id', requireStudent, (req, res) => {
  const info = db.prepare('DELETE FROM interview_qbank WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '没有这道题。');
  res.json({ ok: true });
});

export default r;
