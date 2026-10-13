// M20 导师工坊（教师端）：PRD 第9章接口
// GET /teacher/mentors  GET/PUT /teacher/mentors/:key（草稿角色卡）  POST /teacher/mentors/:key/docs  PUT /teacher/mentors/:key/docs/:id
// GET/POST /teacher/mentors/:key/evalset  POST /teacher/mentors/:key/eval  GET /teacher/mentors/:key/feedback
// POST /teacher/mentors/:key/distill  POST /teacher/mentors/:key/proposals/:id  POST /teacher/mentors/:key/publish  POST /teacher/mentors/:key/rollback
// GET/PUT /teacher/insights  POST /teacher/insights/generate  GET/POST/PUT /teacher/experience-cases
import { Router } from 'express';
import { db, getSettingJson, setSetting } from '../db.js';
import { nowLocal, addDays, todayLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireTeacher } from '../auth.js';
import { agents, getAgent, displayName } from '../registry.js';
import { renderPrompt, commonRules, verifiedMaterials } from '../prompts.js';
import { getLlmConfig } from '../llm/settings.js';
import { resolveKey, recordCall } from '../llm/keys.js';
import { streamChat } from '../llm/client.js';
import { generateJson } from '../llm/json.js';
import { splitReply } from '../llm/options.js';
import { parseUpload, redact as redactPII } from '../twin.js';
import { fetchUrl } from '../search/tools.js';
import {
  publishedVersion, draftPersona, saveDraft, publish, rollback, versionRows, docsOf, addDoc, setDocEnabled,
  mentorRuntime, containsPII,
} from '../workshop.js';

const r = Router();
r.use('/teacher/mentors', requireTeacher);
r.use('/teacher/insights', requireTeacher);
r.use('/teacher/experience-cases', requireTeacher);

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const WORKSHOP_AGENTS = agents.filter((a) => !a.worker && a.key !== 'twin').map((a) => a.key);
const LEVELS = ['官方', '院校', '经验帖', '学习方法', '教师自编'];
const REASON_TAGS = ['太严厉', '太啰嗦', '不准确', '没听懂我', '太空泛', '其他'];

function mustMentor(key) {
  if (!WORKSHOP_AGENTS.includes(key)) throw new AppError(404, 'NO_MENTOR', '没有这位导师（后台工作者不在工坊里）。');
  return getAgent(key);
}

function feedbackRows(key, days = 30) {
  return db.prepare('SELECT * FROM mentor_feedback WHERE mentor_key = ? AND created_at >= ? ORDER BY id DESC').all(key, addDays(todayLocal(), -days));
}

/** 被评价的那条回复（只取这一条，不取上下文） */
function replyOf(ref) {
  const m = String(ref || '').match(/^(msg|gmsg):(\d+)$/);
  if (!m) return '';
  const row = m[1] === 'msg'
    ? db.prepare("SELECT content FROM messages WHERE id = ? AND role = 'assistant'").get(Number(m[2]))
    : db.prepare("SELECT content FROM group_messages WHERE id = ? AND speaker_type = 'mentor'").get(Number(m[2]));
  return row ? row.content.slice(0, 400) : '';
}

function proposalsOf(key) { return getSettingJson(`mentor_proposals.${key}`, { items: [], patterns: [], eval_questions: [], at: null, feedback_count: 0 }); }

function usageCount(key) {
  const since = addDays(todayLocal(), -6);
  return db.prepare("SELECT COUNT(*) AS n FROM messages WHERE agent_key = ? AND role = 'assistant' AND created_at >= ?").get(key, since).n
    + db.prepare("SELECT COUNT(*) AS n FROM group_messages WHERE speaker_key = ? AND speaker_type = 'mentor' AND created_at >= ?").get(key, since).n;
}

r.get('/teacher/mentors', (_req, res) => {
  res.json({
    note: '本平台的导师通过资料、记忆和反馈不断改进，不对大模型本身进行再训练；所有改进都由教师审核、有版本记录、可以回滚。',
    mentors: WORKSHOP_AGENTS.map((k) => {
      const a = getAgent(k);
      const fb = feedbackRows(k, 7);
      const helpful = fb.filter((f) => f.rating === 'helpful').length;
      return {
        key: k, name: a.name, duty: a.duty, icon: a.icon, group: a.group,
        version: publishedVersion(k).version,
        helpful_rate_7d: fb.length ? Math.round((helpful / fb.length) * 100) : null,
        feedback_7d: fb.length,
        calls_7d: usageCount(k),
        pending_proposals: proposalsOf(k).items.filter((p) => p.status === 'pending').length,
        doc_count: docsOf(k).filter((d) => d.enabled).length,
        has_draft: !!draftPersona(k),
      };
    }),
  });
});

r.get('/teacher/mentors/:key', (req, res) => {
  const a = mustMentor(req.params.key);
  const k = a.key;
  const pub = publishedVersion(k);
  res.json({
    mentor: { key: k, name: a.name, duty: a.duty, summary: a.summary, registry_tone: a.tone || '' },
    published: pub,
    draft: draftPersona(k),
    versions: [{ version: 'v1.0', change_note: '初始角色卡（来自导师注册表）', published_at: null, published_by: null, eval: null },
      ...versionRows(k).map((v) => ({ version: v.version, change_note: v.change_note, published_at: v.published_at, published_by: v.published_by, eval: parse(v.eval_result_json, null) }))],
    docs: docsOf(k).map((d) => ({ id: d.id, title: d.title, source: d.source, level: d.level, license_note: d.license_note, enabled: !!d.enabled, chunks: d.chunks, created_at: d.created_at, in_published: pub.persona.doc_ids.includes(d.id) })),
    evalset: db.prepare('SELECT * FROM mentor_evalsets WHERE mentor_key = ? ORDER BY id').all(k).map((e) => ({ id: e.id, question: e.question, points: parse(e.expected_points_json, []) })),
    proposals: proposalsOf(k),
    levels: LEVELS,
    reason_tags: REASON_TAGS,
  });
});

/** 保存草稿角色卡（不影响学生，发布后才生效） */
r.put('/teacher/mentors/:key', (req, res) => {
  const a = mustMentor(req.params.key);
  const b = req.body || {};
  const patch = {};
  for (const f of ['tone', 'style_notes', 'boundaries', 'negatives', 'examples']) if (b[f] !== undefined) patch[f] = b[f];
  const persona = saveDraft(a.key, patch, { note: b.change_note });
  res.json({ draft: { persona, change_note: draftPersona(a.key).change_note } });
});

/** 上传资料：文件（PDF/Word/TXT/Markdown）、粘贴文字或单页网页链接；必须写来源与授权说明 */
r.post('/teacher/mentors/:key/docs', async (req, res) => {
  const a = mustMentor(req.params.key);
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) throw new AppError(400, 'NO_TITLE', '请填写资料名称。');
  const licenseNote = String(b.license_note || '').trim().slice(0, 200);
  if (!licenseNote) throw new AppError(400, 'NO_LICENSE', '请写来源与授权说明（例如“研招网公开文件”“经本人书面同意，已匿名”）。');
  if (b.confirm_rules !== true) throw new AppError(400, 'NEED_CONFIRM', '请确认：不是未公开试题、不是受版权保护的完整书籍、不含学生个人信息。');
  let text = '';
  let source = String(b.source || '').trim().slice(0, 200);
  if (b.url) {
    const page = await fetchUrl(String(b.url));
    text = page.text;
    source = source || page.url;
  } else if (b.data) {
    text = await parseUpload(Buffer.from(String(b.data).replace(/^data:.*?;base64,/, ''), 'base64'), String(b.filename || 'doc.txt'));
  } else {
    text = String(b.text || '');
  }
  text = text.trim().slice(0, 200000);
  if (!text) throw new AppError(400, 'EMPTY', '没有读出资料内容。');
  // 含个人信息的材料不收（PRD M20 禁止上传含学生个人信息的材料）
  const pii = redactPII(text).log.filter((l) => ['身份证号', '手机号', '住址', '家庭经济', '健康信息'].includes(l.type));
  if (pii.length) throw new AppError(400, 'HAS_PII', `资料里有 ${pii.map((l) => `${l.type}${l.count}处`).join('、')}，含个人信息的材料不能上传。请删掉后再传。`);
  const level = LEVELS.includes(b.level) ? b.level : '官方';
  const out = addDoc(a.key, { title, source, level, licenseNote, text, teacherId: req.user.id });
  res.json({ ...out, note: '资料已加入草稿。发布新版本之前，学生端检索不到它。' });
});

/** 启用 / 禁用一份资料：立即生效（禁用后不再被检索） */
r.put('/teacher/mentors/:key/docs/:id', (req, res) => {
  const a = mustMentor(req.params.key);
  setDocEnabled(a.key, Number(req.params.id), req.body?.enabled !== false);
  res.json({ ok: true });
});

// ---------- 测试集与回归 ----------

r.get('/teacher/mentors/:key/evalset', (req, res) => {
  const a = mustMentor(req.params.key);
  res.json({ items: db.prepare('SELECT * FROM mentor_evalsets WHERE mentor_key = ? ORDER BY id').all(a.key).map((e) => ({ id: e.id, question: e.question, points: parse(e.expected_points_json, []) })) });
});

r.post('/teacher/mentors/:key/evalset', (req, res) => {
  const a = mustMentor(req.params.key);
  if (req.body?.delete_id) {
    db.prepare('DELETE FROM mentor_evalsets WHERE id = ? AND mentor_key = ?').run(Number(req.body.delete_id), a.key);
    return res.json({ ok: true });
  }
  const q = String(req.body?.question || '').trim().slice(0, 300);
  if (!q) throw new AppError(400, 'EMPTY', '请填写测试问题。');
  const points = (Array.isArray(req.body?.points) ? req.body.points : String(req.body?.points || '').split(/[\n；;]/)).map((x) => String(x).trim()).filter(Boolean).slice(0, 8);
  if (!points.length) throw new AppError(400, 'NO_POINTS', '请写至少一条应答要点。');
  const n = db.prepare('SELECT COUNT(*) AS n FROM mentor_evalsets WHERE mentor_key = ?').get(a.key).n;
  if (n >= 30) throw new AppError(400, 'FULL', '每位导师最多30个测试问题。');
  db.prepare('INSERT INTO mentor_evalsets(mentor_key, question, expected_points_json) VALUES(?, ?, ?)').run(a.key, q, JSON.stringify(points));
  res.json({ ok: true });
});

/** 要点覆盖：回答里出现要点原文，或要点里六成以上的两字片段都出现 */
export function pointCovered(answer, point) {
  const a = String(answer || '').replace(/\s/g, '');
  const p = String(point || '').replace(/\s/g, '');
  if (!p) return false;
  if (a.includes(p)) return true;
  const grams = [];
  for (let i = 0; i + 2 <= p.length; i += 1) grams.push(p.slice(i, i + 2));
  if (!grams.length) return false;
  return grams.filter((g) => a.includes(g)).length / grams.length >= 0.6;
}

async function answerWith(teacher, key, question, draft, llm, keyInfo) {
  const a = getAgent(key);
  const rt = mentorRuntime(key, question, { draft });
  const system = renderPrompt('mentor_ask', { 姓名: '（测试）', 专业: '（测试）', 年级: '（测试）', 专业大类: '（测试）', 导师显示名: displayName(a), 导师职责说明: a.summary, 导师语气: a.tone || '', 共同规则: commonRules(), 已核实资料: verifiedMaterials() }) + (rt.block ? `\n\n${rt.block}` : '');
  const out = await streamChat({ baseUrl: llm.baseUrl, key: keyInfo.key, model: llm.chatModel, source: keyInfo.source, maxTokens: 800, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: question }] });
  recordCall({ userId: teacher.id, kind: 'M18_basic', purpose: `导师测试集（${a.name}）`, model: out.model, source: keyInfo.source, usage: out.usage });
  return splitReply(out.content).body || out.content;
}

/** 一键回归：同一组问题分别用“当前发布版”和“草稿”回答，算要点覆盖率，给教师对照 */
r.post('/teacher/mentors/:key/eval', async (req, res) => {
  const a = mustMentor(req.params.key);
  const items = db.prepare('SELECT * FROM mentor_evalsets WHERE mentor_key = ? ORDER BY id').all(a.key);
  if (!items.length) throw new AppError(400, 'NO_EVALSET', '还没有测试问题。先加几个问题和应答要点。');
  if (!draftPersona(a.key)) throw new AppError(400, 'NO_DRAFT', '没有草稿，无需对照。');
  const llm = getLlmConfig();
  const keyInfo = resolveKey(req.user, 'M18_basic', '');
  const rows = [];
  let oldHit = 0; let newHit = 0; let total = 0;
  for (const it of items.slice(0, 30)) {
    const points = parse(it.expected_points_json, []);
    const before = await answerWith(req.user, a.key, it.question, false, llm, keyInfo);
    const after = await answerWith(req.user, a.key, it.question, true, llm, keyInfo);
    const cb = points.map((p) => pointCovered(before, p));
    const ca = points.map((p) => pointCovered(after, p));
    oldHit += cb.filter(Boolean).length; newHit += ca.filter(Boolean).length; total += points.length;
    rows.push({ question: it.question, points, before, after, covered_before: cb, covered_after: ca });
  }
  const result = { ran_at: nowLocal(), published_version: publishedVersion(a.key).version, coverage_before: total ? Math.round((oldHit / total) * 100) : 0, coverage_after: total ? Math.round((newHit / total) * 100) : 0, rows };
  db.prepare('UPDATE mentor_versions SET eval_result_json = ? WHERE mentor_key = ? AND published_at IS NULL').run(JSON.stringify(result), a.key);
  res.json(result);
});

r.post('/teacher/mentors/:key/publish', (req, res) => {
  const a = mustMentor(req.params.key);
  const version = publish(a.key, req.user.id, req.body?.change_note);
  res.json({ version, note: `已发布 ${version}，学生从下一条消息起使用新版本。` });
});

r.post('/teacher/mentors/:key/rollback', (req, res) => {
  const a = mustMentor(req.params.key);
  const version = rollback(a.key, String(req.body?.version || ''));
  res.json({ version, note: `已回滚到 ${version}。学生的记忆不受影响。` });
});

// ---------- 反馈与蒸馏 ----------

/** 只返回评分、原因标签、补充说明和被评价的那条回复；没有整段对话、没有学生身份 */
r.get('/teacher/mentors/:key/feedback', (req, res) => {
  const a = mustMentor(req.params.key);
  const rows = feedbackRows(a.key);
  const tags = {};
  for (const f of rows) for (const t of parse(f.reason_tags_json, [])) tags[t] = (tags[t] || 0) + 1;
  res.json({
    summary: { total: rows.length, helpful: rows.filter((f) => f.rating === 'helpful').length, unhelpful: rows.filter((f) => f.rating !== 'helpful').length, tags },
    items: rows.slice(0, 100).map((f) => ({ id: f.id, rating: f.rating, tags: parse(f.reason_tags_json, []), comment: f.comment || '', reply: replyOf(f.message_ref), created_at: f.created_at })),
    note: '这里只显示评分、原因和被评价的那一条导师回复，看不到整段对话，也看不到是哪位同学评的。',
  });
});

r.post('/teacher/mentors/:key/distill', async (req, res) => {
  const a = mustMentor(req.params.key);
  const rows = feedbackRows(a.key);
  const bad = rows.filter((f) => f.rating !== 'helpful');
  if (!bad.length) throw new AppError(400, 'NO_FEEDBACK', '最近30天没有“没帮助”的反馈，暂时不需要改进建议。');
  const tags = {};
  for (const f of rows) for (const t of parse(f.reason_tags_json, [])) tags[t] = (tags[t] || 0) + 1;
  const pub = publishedVersion(a.key);
  const p = pub.persona;
  const card = [`语气：${p.tone}`, p.style_notes.length ? `表达要求：${p.style_notes.join('；')}` : '', p.negatives.length ? `负面清单：${p.negatives.join('；')}` : '', `示例对话 ${p.examples.length} 组`].filter(Boolean).join('\n');
  const detail = bad.slice(0, 40).map((f, i) => `${i + 1}. 原因：${parse(f.reason_tags_json, []).join('、') || '未选'}｜补充：${(f.comment || '').slice(0, 60) || '无'}｜被评价的回复：${replyOf(f.message_ref).replace(/\n+/g, ' ').slice(0, 200) || '（无）'}`).join('\n');
  const keyInfo = resolveKey(req.user, 'M18_basic', '');
  const { data } = await generateJson({
    user: req.user, moduleId: 'M18_basic', purpose: `反馈蒸馏（${a.name}）`, key: keyInfo.key, source: keyInfo.source, maxTokens: 2000, temperature: 0.3,
    prompt: {
      system: renderPrompt('mentor_distill', { 导师显示名: displayName(a), 共同规则: commonRules(), 版本: pub.version, 角色卡: card, 有帮助数: rows.length - bad.length, 没帮助数: bad.length, 原因统计: Object.entries(tags).map(([k, v]) => `${k}${v}次`).join('、') || '无', 反馈明细: detail }),
      user: '请给出改进建议，只输出 JSON。',
    },
  });
  const TYPES = ['角色卡措辞', '新增示例对话', '新增负面清单', '补充知识库资料'];
  const prev = proposalsOf(a.key);
  const items = [
    ...prev.items.filter((x) => x.status !== 'pending'),
    ...(Array.isArray(data?.proposals) ? data.proposals : []).filter((x) => x && String(x.change || '').trim()).slice(0, 8).map((x, i) => ({
      id: `${Date.now().toString(36)}${i}`, type: TYPES.includes(x.type) ? x.type : '角色卡措辞',
      change: String(x.change).slice(0, 400), reason: String(x.reason || '').slice(0, 200), risk: String(x.risk || '').slice(0, 200), status: 'pending', created_at: nowLocal(),
    })),
  ];
  const out = {
    items,
    patterns: (Array.isArray(data?.patterns) ? data.patterns : []).slice(0, 6).map((x) => ({ issue: String(x.issue || '').slice(0, 200), evidence_count: Math.min(Number(x.evidence_count) || 0, bad.length), examples: (x.examples || []).slice(0, 3).map((e) => String(e).slice(0, 200)) })),
    eval_questions: (Array.isArray(data?.eval_questions) ? data.eval_questions : []).map(String).slice(0, 5),
    at: nowLocal(),
    feedback_count: rows.length,
  };
  setSetting(`mentor_proposals.${a.key}`, JSON.stringify(out));
  res.json(out);
});

/** 逐条采纳或拒绝：采纳的写进草稿（发布后才生效） */
r.post('/teacher/mentors/:key/proposals/:id', (req, res) => {
  const a = mustMentor(req.params.key);
  const all = proposalsOf(a.key);
  const p = all.items.find((x) => x.id === req.params.id);
  if (!p) throw new AppError(404, 'NOT_FOUND', '没有这条建议。');
  if (p.status !== 'pending') throw new AppError(400, 'DONE', '这条建议已经处理过了。');
  const adopt = req.body?.action === 'adopt';
  p.status = adopt ? 'adopted' : 'rejected';
  p.decided_at = nowLocal();
  if (adopt) {
    const cur = draftPersona(a.key)?.persona || publishedVersion(a.key).persona;
    const text = String(req.body?.change || p.change).slice(0, 400);
    if (p.type === '新增负面清单') saveDraft(a.key, { negatives: [...cur.negatives, text] }, { note: `采纳反馈建议：${text.slice(0, 40)}` });
    else if (p.type === '新增示例对话') {
      const m = text.match(/学生[:：](.+?)\s*(?:导师|你)[:：](.+)/s);
      saveDraft(a.key, { examples: [...cur.examples, m ? { q: m[1].trim(), a: m[2].trim() } : { q: '（示例）', a: text }] }, { note: `采纳反馈建议：新增示例对话` });
    } else if (p.type === '角色卡措辞') saveDraft(a.key, { style_notes: [...cur.style_notes, text] }, { note: `采纳反馈建议：${text.slice(0, 40)}` });
    // “补充知识库资料”只记为已采纳，由教师去上传资料
  }
  setSetting(`mentor_proposals.${a.key}`, JSON.stringify(all));
  res.json({ proposals: all, draft: draftPersona(a.key) });
});

// ---------- 经验库（跨学生的匿名规律，须教师批准） ----------

const MIN_STUDENTS = 3; // 至少3名同学共有的情况才提炼，避免指向个人

function realStudentIds() {
  return db.prepare(`SELECT id FROM users WHERE role = 'student' AND is_demo = 0 AND class_id IN (SELECT id FROM classes WHERE is_sandbox = 0)`).all().map((u) => u.id);
}

/** 规则汇总，不调用模型：只输出“有几名同学、什么情况”，不含任何可识别个人的信息 */
export function generateInsights() {
  const ids = realStudentIds();
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const out = [];
  // 周复盘里最常见的卡点 → 知序（计划）
  const blockers = {};
  for (const r0 of db.prepare(`SELECT user_id, blockers_json FROM weekly_reviews WHERE user_id IN (${ph})`).all(...ids)) {
    for (const b of parse(r0.blockers_json, [])) (blockers[b] ||= new Set()).add(r0.user_id);
  }
  const topB = Object.entries(blockers).sort((a, b) => b[1].size - a[1].size)[0];
  if (topB && topB[1].size >= MIN_STUDENTS) out.push({ mentor_key: 'planner', insight: `周复盘里最常见的卡点是“${topB[0]}”（${topB[1].size} 名同学提到）。遇到这类情况，先帮学生把任务量减下来，再谈坚持。`, evidence_count: topB[1].size });
  // 院校数据核验比例低 → 择川
  let low = 0;
  for (const u of ids) {
    const facts = db.prepare('SELECT facts_json FROM schools WHERE user_id = ?').all(u).flatMap((x) => parse(x.facts_json, []));
    if (facts.length >= 2 && facts.filter((f) => f.verified).length / facts.length < 0.5) low += 1;
  }
  if (low >= MIN_STUDENTS) out.push({ mentor_key: 'school', insight: `第4站最常见的问题是院校数据核验比例不到一半（${low} 名同学）。建议先带学生核验“复试线”和“招生人数”两项，再看其他。`, evidence_count: low });
  // 最常触发的干预 → 栖云（陪伴）
  const iv = db.prepare(`SELECT rule, COUNT(DISTINCT user_id) AS n FROM interventions WHERE user_id IN (${ph}) GROUP BY rule ORDER BY n DESC LIMIT 1`).get(...ids);
  if (iv && iv.n >= MIN_STUDENTS) out.push({ mentor_key: 'gentle', insight: `最近最常触发的提醒是 ${iv.rule}（${iv.n} 名同学）。聊到这类情况时，先问清楚原因，再给选项。`, evidence_count: iv.n });
  // 阅读卡“我的判断”空着 → 照卷
  const empty = db.prepare(`SELECT COUNT(DISTINCT user_id) AS n FROM reading_cards WHERE user_id IN (${ph}) AND TRIM(COALESCE(my_judgment, '')) = ''`).get(...ids).n;
  if (empty >= MIN_STUDENTS) out.push({ mentor_key: 'research_read', insight: `${empty} 名同学有阅读卡还没写“我的判断”。精读结束时提醒学生用一句话写下自己的判断。`, evidence_count: empty });
  const have = new Set(db.prepare('SELECT insight FROM mentor_insights').all().map((x) => x.insight));
  const ins = db.prepare("INSERT INTO mentor_insights(mentor_key, insight, evidence_count, status, created_at) VALUES(?, ?, ?, 'pending', ?)");
  const created = [];
  for (const it of out) {
    if (have.has(it.insight)) continue;
    ins.run(it.mentor_key, it.insight, it.evidence_count, nowLocal());
    created.push(it);
  }
  return created;
}

r.get('/teacher/insights', (_req, res) => {
  res.json({
    items: db.prepare('SELECT * FROM mentor_insights ORDER BY id DESC').all().map((x) => ({ ...x, mentor: displayName(getAgent(x.mentor_key)) })),
    note: `经验库条目由平台从至少 ${MIN_STUDENTS} 名同学的匿名数据里汇总，必须教师批准才会进入导师的上下文。`,
  });
});

r.post('/teacher/insights/generate', (_req, res) => res.json({ created: generateInsights() }));

r.put('/teacher/insights', (req, res) => {
  const id = Number(req.body?.id);
  const row = db.prepare('SELECT * FROM mentor_insights WHERE id = ?').get(id);
  if (!row) throw new AppError(404, 'NOT_FOUND', '没有这条经验。');
  const status = req.body?.status === 'approved' ? 'approved' : req.body?.status === 'rejected' ? 'rejected' : 'pending';
  const text = req.body?.insight !== undefined ? String(req.body.insight).trim().slice(0, 300) : row.insight;
  if (status === 'approved') {
    const pii = containsPII(text);
    if (pii) throw new AppError(400, 'HAS_PII', `这条经验里有可识别个人的信息（${pii}），不能批准。请先改写。`);
  }
  db.prepare('UPDATE mentor_insights SET insight = ?, status = ?, approved_by = ? WHERE id = ?').run(text, status, status === 'approved' ? req.user.id : null, id);
  res.json({ ok: true });
});

// ---------- 渡舟的经验案例（上岸经验访谈，经本人同意并匿名） ----------

r.get('/teacher/experience-cases', (_req, res) => {
  res.json({ items: db.prepare('SELECT * FROM experience_cases ORDER BY id DESC').all().map((c) => ({ ...c, tags: parse(c.tags_json, []), approved: !!c.approved_by, anonymized: !!c.anonymized })) });
});

function caseFields(b) {
  const title = String(b.title || '').trim().slice(0, 80);
  const content = String(b.content || '').trim().slice(0, 3000);
  if (!title || !content) throw new AppError(400, 'EMPTY', '请填写标题和内容。');
  return { title, content, tags: (Array.isArray(b.tags) ? b.tags : String(b.tags || '').split(/[,，\s]+/)).filter(Boolean).slice(0, 8), consent: String(b.consent_note || '').trim().slice(0, 200), anonymized: b.anonymized === true };
}

r.post('/teacher/experience-cases', (req, res) => {
  const f = caseFields(req.body || {});
  db.prepare('INSERT INTO experience_cases(title, content, tags_json, consent_note, anonymized, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(f.title, f.content, JSON.stringify(f.tags), f.consent, f.anonymized ? 1 : 0, nowLocal());
  res.json({ ok: true, note: '已保存为待审。勾选“已匿名”、写明同意说明并批准后，渡舟才会引用。' });
});

/** 修改或批准：批准要求已匿名、有同意说明、不含可识别个人的信息 */
r.put('/teacher/experience-cases', (req, res) => {
  const row = db.prepare('SELECT * FROM experience_cases WHERE id = ?').get(Number(req.body?.id));
  if (!row) throw new AppError(404, 'NOT_FOUND', '没有这条案例。');
  const f = caseFields({ title: row.title, content: row.content, consent_note: row.consent_note, anonymized: !!row.anonymized, tags: parse(row.tags_json, []), ...req.body });
  let approvedBy = row.approved_by;
  if (req.body?.approve === true) {
    if (!f.anonymized) throw new AppError(400, 'NOT_ANON', '请先确认内容已匿名。');
    if (!f.consent) throw new AppError(400, 'NO_CONSENT', '请写明本人同意说明（例如“经本人书面同意，2026-09”）。');
    const pii = containsPII(`${f.title}${f.content}`);
    if (pii) throw new AppError(400, 'HAS_PII', `内容里有可识别个人的信息（${pii}），不能批准。`);
    approvedBy = req.user.id;
  }
  if (req.body?.approve === false) approvedBy = null;
  db.prepare('UPDATE experience_cases SET title = ?, content = ?, tags_json = ?, consent_note = ?, anonymized = ?, approved_by = ? WHERE id = ?')
    .run(f.title, f.content, JSON.stringify(f.tags), f.consent, f.anonymized ? 1 : 0, approvedBy, row.id);
  res.json({ ok: true });
});

export { REASON_TAGS };
export default r;
