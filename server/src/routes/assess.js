// M14 结课考核中心接口 + M2 互评
// 学生：GET /assess/portfolio  GET /assess/plan  POST /assess/plan/compile  PUT /assess/plan/reflections
//      GET /assess/ai-statement  PUT /assess/ai-statement  POST /assess/submit  GET /assess/plan/export
//      GET /peer/assigned  POST /peer/:id  GET /peer/received
// 教师：GET /teacher/grades  GET /teacher/grades/:id  PUT /teacher/grades/:id  GET /teacher/grades/export
//      POST /teacher/peer/open  GET /teacher/peer
import { Router } from 'express';
import { db, getSettingJson, setSetting } from '../db.js';
import { nowLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent, requireTeacher } from '../auth.js';
import { getTaskDefs } from '../courseware.js';
import { titleSimilarity } from '../research/works.js';
import { setFlowStatus, flowStatusOf } from '../stations.js';
import { makeDocx } from '../docx.js';
import { anonText } from '../anon.js';
import {
  ASSESS, ITEMS, PLAN_SECTIONS, portfolioOf, aiStats, aiStatementDraft, compilePlanDraft, actionPlanRow,
} from '../assess.js';

const r = Router();
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const len = (s) => [...String(s || '').replace(/\s/g, '')].length;

// ---------- 档案袋 ----------

r.get('/assess/portfolio', requireStudent, (req, res) => {
  const pf = portfolioOf(req.user.id);
  const grades = db.prepare('SELECT item, score, comment, updated_at FROM grades WHERE user_id = ?').all(req.user.id);
  res.json({
    ...pf,
    bands: ASSESS.bands,
    // 学生只看得到自己的分数（教师评分后）
    grades: grades.map((g) => ({ item: g.item, score: g.score, comment: g.comment || '', updated_at: g.updated_at })),
    note: '平台指标只是参考，最终分数由老师决定。所有项目都不需要绑定自己的 Key 就能完成。',
  });
});

// ---------- 行动方案 ----------

function ensurePlanRow(userId) {
  const row = actionPlanRow(userId);
  if (row) return row;
  const info = db.prepare('INSERT INTO action_plans(user_id, reflections_json) VALUES(?, ?)').run(userId, '{}');
  return db.prepare('SELECT * FROM action_plans WHERE id = ?').get(info.lastInsertRowid);
}

function planView(user) {
  const row = actionPlanRow(user.id);
  const stats = aiStats(user.id);
  const stmt = parse(row?.ai_statement_json, {});
  return {
    draft: parse(row?.draft_json, null),
    reflections: parse(row?.reflections_json, {}),
    sections: PLAN_SECTIONS,
    reflection_min: ASSESS.reflection_min_chars,
    ai_statement: {
      draft: aiStatementDraft(user, row?.submitted_at && stmt.stats ? stmt.stats : stats),
      stats: row?.submitted_at && stmt.stats ? stmt.stats : stats,
      note: stmt.note || '',
      note_min: ASSESS.ai_note_min_chars,
    },
    submitted_at: row?.submitted_at || null,
  };
}

r.get('/assess/plan', requireStudent, (req, res) => res.json(planView(req.user)));

/** 一键汇编：只重写“汇编内容”，已写的“我的反思”原样保留 */
r.post('/assess/plan/compile', requireStudent, (req, res) => {
  const row = ensurePlanRow(req.user.id);
  if (row.submitted_at) throw new AppError(400, 'SUBMITTED', '已经提交了，不能再改。');
  db.prepare('UPDATE action_plans SET draft_json = ? WHERE id = ?').run(JSON.stringify(compilePlanDraft(req.user)), row.id);
  if (flowStatusOf(req.user.id, 11) === 'not_started') setFlowStatus(req.user.id, 11, 'in_progress');
  res.json(planView(req.user));
});

/**
 * “我的反思”只能由学生在这里写：平台没有任何调用模型的代码路径会写这个字段。
 * 另外拦下“把汇编内容原样抄进反思”的情况。
 */
r.put('/assess/plan/reflections', requireStudent, (req, res) => {
  const row = ensurePlanRow(req.user.id);
  if (row.submitted_at) throw new AppError(400, 'SUBMITTED', '已经提交了，不能再改。');
  if (!row.draft_json) throw new AppError(400, 'NO_DRAFT', '先点“一键汇编”，再写每一部分的反思。');
  const key = String(req.body?.section || '');
  const sec = PLAN_SECTIONS.find((s) => s.key === key);
  if (!sec) throw new AppError(400, 'BAD_SECTION', '没有这一部分。');
  const text = String(req.body?.text || '').trim().slice(0, 3000);
  if (text && len(text) < ASSESS.reflection_min_chars) throw new AppError(400, 'TOO_SHORT', `“我的反思”至少 ${ASSESS.reflection_min_chars} 字（现在 ${len(text)} 字）。`);
  const draft = parse(row.draft_json, {});
  const content = draft.sections?.find((s) => s.key === key)?.content || '';
  if (text && content && titleSimilarity(text, content) > 0.8) throw new AppError(400, 'COPIED', '这段和汇编内容几乎一样。反思要写你自己的想法：做得怎样、哪里没想到、接下来怎么改。');
  const refl = parse(row.reflections_json, {});
  if (text) refl[key] = text; else delete refl[key];
  db.prepare('UPDATE action_plans SET reflections_json = ? WHERE id = ?').run(JSON.stringify(refl), row.id);
  res.json(planView(req.user));
});

r.get('/assess/ai-statement', requireStudent, (req, res) => res.json(planView(req.user).ai_statement));

r.put('/assess/ai-statement', requireStudent, (req, res) => {
  const row = ensurePlanRow(req.user.id);
  if (row.submitted_at) throw new AppError(400, 'SUBMITTED', '已经提交了，不能再改。');
  const note = String(req.body?.note || '').trim().slice(0, 3000);
  if (note && len(note) < ASSESS.ai_note_min_chars) throw new AppError(400, 'TOO_SHORT', `补充说明至少 ${ASSESS.ai_note_min_chars} 字（现在 ${len(note)} 字）：写写你是怎么用 AI 的、哪里改过、怎么核验的。`);
  const stmt = parse(row.ai_statement_json, {});
  stmt.note = note;
  db.prepare('UPDATE action_plans SET ai_statement_json = ? WHERE id = ?').run(JSON.stringify(stmt), row.id);
  res.json(planView(req.user).ai_statement);
});

/** 提交：汇编过、每部分都写了反思、AI说明写了补充；提交时把统计数字定格 */
r.post('/assess/submit', requireStudent, (req, res) => {
  const row = ensurePlanRow(req.user.id);
  if (row.submitted_at) throw new AppError(400, 'SUBMITTED', '已经提交过了。');
  if (!row.draft_json) throw new AppError(400, 'NO_DRAFT', '还没有汇编行动方案。');
  const refl = parse(row.reflections_json, {});
  const lack = PLAN_SECTIONS.filter((s) => !String(refl[s.key] || '').trim());
  if (lack.length) throw new AppError(400, 'NEED_REFLECTION', `还有 ${lack.length} 个部分没写“我的反思”：${lack.map((s) => s.title).join('、')}`, { sections: lack.map((s) => s.key) });
  const stmt = parse(row.ai_statement_json, {});
  if (len(stmt.note) < ASSESS.ai_note_min_chars) throw new AppError(400, 'NEED_AI_NOTE', 'AI使用与核验说明还没写补充说明。');
  stmt.stats = aiStats(req.user.id);
  stmt.stats_at = nowLocal();
  // 提交前用最新数据再汇编一次，保证交上去的是当下的记录
  const draft = compilePlanDraft(req.user);
  db.prepare('UPDATE action_plans SET draft_json = ?, ai_statement_json = ?, submitted_at = ? WHERE id = ?')
    .run(JSON.stringify(draft), JSON.stringify(stmt), nowLocal(), row.id);
  setFlowStatus(req.user.id, 11, 'done');
  res.json(planView(req.user));
});

function planBlocks(user, view) {
  const blocks = [{ type: 'title', text: view.draft?.title || `个人考研（升学）行动方案 —— ${user.name}` }];
  blocks.push({ type: 'note', text: `${user.name} · 学号 ${user.student_no} · ${user.major || ''} ${user.grade || ''}${view.submitted_at ? ` · 提交于 ${view.submitted_at}` : ' · 草稿'}` });
  blocks.push({ type: 'note', text: '“汇编内容”由平台从你的记录中整理；“我的反思”由本人撰写，AI 不参与。' });
  for (const s of view.draft?.sections || []) {
    blocks.push({ type: 'h1', text: s.title });
    blocks.push({ type: 'h2', text: '汇编内容' });
    blocks.push({ type: 'p', text: s.content });
    blocks.push({ type: 'h2', text: '我的反思' });
    blocks.push({ type: 'p', text: view.reflections[s.key] || '（还没有写）' });
  }
  blocks.push({ type: 'h1', text: '附：AI使用与核验说明' });
  blocks.push({ type: 'p', text: view.ai_statement.draft });
  blocks.push({ type: 'p', text: view.ai_statement.note || '（还没有写）' });
  return blocks;
}

function sendPlan(res, user, view, format) {
  const name = `${user.name}-行动方案${view.submitted_at ? '' : '（草稿）'}`;
  if (format === 'docx') {
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.docx` });
    return res.send(makeDocx(planBlocks(user, view).map((b) => ({ ...b, text: anonText(b.text) }))));
  }
  const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(name)}</title><style>body{font-family:"Songti SC",SimSun,serif;max-width:820px;margin:32px auto;padding:0 20px;line-height:1.75;color:#1C2430}h1{text-align:center}h2{border-left:4px solid #2F6F62;padding-left:8px;margin-top:28px}h3{color:#59665f;font-size:15px}.muted{color:#59665f;font-size:13px}.refl{background:#f5f6f3;padding:8px 12px;border-radius:8px}@media print{h2{page-break-after:avoid}}</style></head><body>
${planBlocks(user, view).map((b) => (b.type === 'title' ? `<h1>${esc(b.text)}</h1>` : b.type === 'h1' ? `<h2>${esc(b.text)}</h2>` : b.type === 'h2' ? `<h3>${esc(b.text)}</h3>` : b.type === 'note' ? `<p class="muted">${esc(b.text)}</p>` : `<p${b.text && /^（还没有写）$/.test(b.text) ? ' class="muted"' : ''}>${esc(b.text)}</p>`)).join('\n')}
</body></html>`;
  res.set({ 'Content-Type': 'text/html; charset=utf-8' });
  return res.send(html);
}

r.get('/assess/plan/export', requireStudent, (req, res) => {
  const view = planView(req.user);
  if (!view.draft) throw new AppError(400, 'NO_DRAFT', '还没有汇编行动方案。');
  sendPlan(res, req.user, view, req.query.format === 'docx' ? 'docx' : 'html');
});

// ---------- M2 互评 ----------

const PEER = ASSESS.peer;

function openPeerList() { return getSettingJson('peer_open', []); }

function realStudentIds() {
  return new Set(db.prepare(`SELECT id FROM users WHERE role = 'student' AND is_demo = 0 AND class_id IN (SELECT id FROM classes WHERE is_sandbox = 0)`).all().map((u) => u.id));
}

/**
 * 开启互评：每份作业分给2位同学（不会分给作者本人），按当前负担最轻的人优先，尽量每人评2份。
 * 重复开启只给“还没分满”的作业补分配，已有的不动。
 */
export function assignPeer(chapter, taskId) {
  const real = realStudentIds();
  const subs = db.prepare('SELECT id, user_id FROM submissions WHERE chapter = ? AND task_id = ?').all(chapter, taskId).filter((s) => real.has(s.user_id));
  if (subs.length < 2) throw new AppError(400, 'TOO_FEW', `这个任务只有 ${subs.length} 份提交，至少要2份才能互评。`);
  const authors = subs.map((s) => s.user_id);
  const load = new Map(authors.map((a) => [a, 0]));
  const existing = db.prepare(`SELECT p.submission_id, p.reviewer_id FROM peer_reviews p JOIN submissions s ON s.id = p.submission_id WHERE s.chapter = ? AND s.task_id = ?`).all(chapter, taskId);
  for (const e of existing) load.set(e.reviewer_id, (load.get(e.reviewer_id) || 0) + 1);
  const ins = db.prepare('INSERT INTO peer_reviews(submission_id, reviewer_id, created_at) VALUES(?, ?, ?)');
  let created = 0;
  const shuffled = subs.slice().sort(() => Math.random() - 0.5);
  const per = Math.min(PEER.per_submission, authors.length - 1);
  if (!existing.length) {
    // 首次开启：打乱后排成一圈，每人评后面两位——保证每份作业恰好2位评价者、每人恰好评2份
    shuffled.forEach((s, i) => {
      for (let k = 1; k <= per; k += 1) { ins.run(s.id, shuffled[(i + k) % shuffled.length].user_id, nowLocal()); created += 1; }
    });
    return { submissions: subs.length, created };
  }
  // 之后补交的作业：按当前负担最轻的人补分配
  for (const s of shuffled) {
    const have = existing.filter((e) => e.submission_id === s.id).map((e) => e.reviewer_id);
    const need = per - have.length;
    for (let i = 0; i < need; i += 1) {
      const pick = authors
        .filter((a) => a !== s.user_id && !have.includes(a))
        .sort((x, y) => (load.get(x) - load.get(y)) || (Math.random() - 0.5))[0];
      if (!pick) break;
      ins.run(s.id, pick, nowLocal());
      have.push(pick);
      load.set(pick, load.get(pick) + 1);
      created += 1;
    }
  }
  return { submissions: subs.length, created };
}

r.post('/teacher/peer/open', requireTeacher, (req, res) => {
  const chapter = Number(req.body?.chapter);
  const taskId = String(req.body?.task_id || '');
  const def = getTaskDefs(chapter)?.tasks?.find((t) => t.id === taskId);
  if (!def) throw new AppError(404, 'NO_TASK', '没有这个课堂任务。');
  if (def.type !== 'form') throw new AppError(400, 'NOT_FORM', '只有填写类任务（form）可以互评。');
  const out = assignPeer(chapter, taskId);
  const list = openPeerList().filter((x) => !(x.chapter === chapter && x.task_id === taskId));
  list.push({ chapter, task_id: taskId, title: def.title, opened_at: nowLocal() });
  setSetting('peer_open', JSON.stringify(list));
  res.json({ ...out, open: list });
});

r.get('/teacher/peer', requireTeacher, (_req, res) => {
  const list = openPeerList().map((x) => {
    const rows = db.prepare(`SELECT p.rubric_json FROM peer_reviews p JOIN submissions s ON s.id = p.submission_id WHERE s.chapter = ? AND s.task_id = ?`).all(x.chapter, x.task_id);
    return { ...x, assigned: rows.length, done: rows.filter((r0) => r0.rubric_json).length };
  });
  res.json({ open: list });
});

/** 学生：分给我的互评（看不到作者是谁） */
r.get('/peer/assigned', requireStudent, (req, res) => {
  const rows = db.prepare(`SELECT p.id, p.rubric_json, p.comment, s.chapter, s.task_id, s.content_json FROM peer_reviews p
    JOIN submissions s ON s.id = p.submission_id WHERE p.reviewer_id = ? ORDER BY p.id`).all(req.user.id);
  res.json({
    criteria: PEER.criteria, min: PEER.min, max: PEER.max,
    items: rows.map((x, i) => {
      const def = getTaskDefs(x.chapter)?.tasks?.find((t) => t.id === x.task_id);
      const content = parse(x.content_json, {});
      const fields = (def?.fields || []).map((f) => ({ label: f.label, value: Array.isArray(content[f.key]) ? content[f.key].join('、') : String(content[f.key] ?? '') }));
      if (def?.extra && content[def.extra.key]) fields.push({ label: def.extra.label, value: String(content[def.extra.key]) });
      return {
        id: x.id, anonymous_label: `同学作业 ${String.fromCharCode(65 + (i % 26))}`, chapter: x.chapter, task_title: def?.title || x.task_id,
        fields, done: !!x.rubric_json, rubric: parse(x.rubric_json, null), comment: x.comment || '',
      };
    }),
  });
});

r.post('/peer/:id', requireStudent, (req, res) => {
  const p = db.prepare('SELECT * FROM peer_reviews WHERE id = ? AND reviewer_id = ?').get(Number(req.params.id), req.user.id);
  if (!p) throw new AppError(404, 'NOT_FOUND', '没有这份互评任务。');
  const rubric = {};
  for (const c of PEER.criteria) {
    const v = Math.round(Number(req.body?.rubric?.[c.key]));
    if (!(v >= PEER.min && v <= PEER.max)) throw new AppError(400, 'BAD_RUBRIC', `请给“${c.label}”选 ${PEER.min}—${PEER.max} 分。`);
    rubric[c.key] = v;
  }
  const comment = String(req.body?.comment || '').trim().slice(0, 300);
  if (len(comment) < 5) throw new AppError(400, 'NEED_COMMENT', '写一句具体的建议（至少5个字）。');
  db.prepare('UPDATE peer_reviews SET rubric_json = ?, comment = ? WHERE id = ?').run(JSON.stringify(rubric), comment, p.id);
  res.json({ ok: true });
});

/** 学生：我收到的互评汇总（看不到是谁评的） */
r.get('/peer/received', requireStudent, (req, res) => {
  const subs = db.prepare('SELECT id, chapter, task_id FROM submissions WHERE user_id = ?').all(req.user.id);
  const out = [];
  for (const s of subs) {
    const rows = db.prepare('SELECT rubric_json, comment FROM peer_reviews WHERE submission_id = ? AND rubric_json IS NOT NULL').all(s.id);
    const total = db.prepare('SELECT COUNT(*) AS n FROM peer_reviews WHERE submission_id = ?').get(s.id).n;
    if (!total) continue;
    const avg = {};
    for (const c of PEER.criteria) {
      const vals = rows.map((r0) => parse(r0.rubric_json, {})[c.key]).filter((v) => Number.isFinite(v));
      avg[c.label] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    }
    const def = getTaskDefs(s.chapter)?.tasks?.find((t) => t.id === s.task_id);
    out.push({ chapter: s.chapter, task_title: def?.title || s.task_id, received: rows.length, assigned: total, averages: avg, comments: rows.map((r0) => r0.comment).filter(Boolean) });
  }
  res.json({ items: out });
});

// ---------- 教师评分 ----------

function studentList() {
  return db.prepare(`SELECT * FROM users WHERE role = 'student' AND is_demo = 0 AND class_id IN (SELECT id FROM classes WHERE is_sandbox = 0) ORDER BY student_no`).all();
}

function gradesOf(userId) {
  const rows = db.prepare('SELECT item, score, comment, updated_at FROM grades WHERE user_id = ?').all(userId);
  return Object.fromEntries(rows.map((g) => [g.item, { score: g.score, comment: g.comment || '', updated_at: g.updated_at }]));
}

/** 加权总评：五项都评完才算，按申报表权重 */
export function weightedTotal(grades) {
  if (!ITEMS.every((it) => Number.isFinite(grades[it.key]?.score))) return null;
  return Math.round(ITEMS.reduce((s, it) => s + (grades[it.key].score * it.weight) / 100, 0) * 10) / 10;
}

r.get('/teacher/grades', requireTeacher, (_req, res) => {
  res.json({
    items: ITEMS.map((it) => ({ key: it.key, name: it.name, weight: it.weight, levels: it.levels, indicators: it.indicators })),
    students: studentList().map((u) => {
      const pf = portfolioOf(u.id);
      const g = gradesOf(u.id);
      return {
        id: u.id, student_no: u.student_no, name: u.name,
        status: Object.fromEntries(pf.items.map((i) => [i.key, i.status])),
        missing_count: pf.missing_count,
        submitted_at: actionPlanRow(u.id)?.submitted_at || null,
        grades: g, total: weightedTotal(g),
      };
    }),
  });
});

/** 成绩表：列与申报表考核结构一致，最后是加权总评 */
r.get('/teacher/grades/export', requireTeacher, (_req, res) => {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['学号', '姓名', ...ITEMS.map((it) => `${it.name}（${it.weight}%）`), '总评（加权）', '备注'];
  const lines = [head.map(esc).join(',')];
  for (const u of studentList()) {
    const g = gradesOf(u.id);
    const total = weightedTotal(g);
    const missing = ITEMS.filter((it) => !Number.isFinite(g[it.key]?.score)).map((it) => it.name);
    lines.push([u.student_no, u.name, ...ITEMS.map((it) => (Number.isFinite(g[it.key]?.score) ? g[it.key].score : '')), total ?? '', missing.length ? `未评：${missing.join('、')}` : ''].map(esc).join(','));
  }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`成绩表-${nowLocal().slice(0, 10)}`)}.csv` });
  res.send(`${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`);
});

/** 某个学生的档案袋（只有指标与提交的材料；看不到私聊、会议原文、分身） */
r.get('/teacher/grades/:id', requireTeacher, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(Number(req.params.id));
  if (!u) throw new AppError(404, 'NOT_FOUND', '没有这名学生。');
  const view = planView(u);
  res.json({
    student: { id: u.id, student_no: u.student_no, name: u.name, major: u.major, grade: u.grade },
    portfolio: portfolioOf(u.id),
    action_plan: view.submitted_at ? { draft: view.draft, reflections: view.reflections, ai_statement: view.ai_statement, submitted_at: view.submitted_at } : null,
    grades: gradesOf(u.id),
    total: weightedTotal(gradesOf(u.id)),
    note: '平台指标仅供参考，最终分数由老师决定。这里看不到学生的私聊、会议原文和数字分身。',
  });
});

r.put('/teacher/grades/:id', requireTeacher, (req, res) => {
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'student'").get(Number(req.params.id));
  if (!u) throw new AppError(404, 'NOT_FOUND', '没有这名学生。');
  const item = String(req.body?.item || '');
  if (!ITEMS.some((it) => it.key === item)) throw new AppError(400, 'BAD_ITEM', '没有这一项。');
  const raw = req.body?.score;
  const score = raw === null || raw === '' ? null : Number(raw);
  if (score !== null && !(score >= 0 && score <= 100)) throw new AppError(400, 'BAD_SCORE', '分数应在0—100之间。');
  const comment = String(req.body?.comment || '').slice(0, 500);
  const exist = db.prepare('SELECT id FROM grades WHERE user_id = ? AND item = ?').get(u.id, item);
  if (exist) db.prepare('UPDATE grades SET score = ?, comment = ?, grader_id = ?, updated_at = ? WHERE id = ?').run(score, comment, req.user.id, nowLocal(), exist.id);
  else db.prepare('INSERT INTO grades(user_id, item, score, comment, grader_id, updated_at) VALUES(?, ?, ?, ?, ?, ?)').run(u.id, item, score, comment, req.user.id, nowLocal());
  const g = gradesOf(u.id);
  res.json({ grades: g, total: weightedTotal(g) });
});

/** 教师查看并下载已提交的行动方案 */
r.get('/teacher/grades/:id/plan', requireTeacher, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(Number(req.params.id));
  if (!u) throw new AppError(404, 'NOT_FOUND', '没有这名学生。');
  const view = planView(u);
  if (!view.submitted_at) throw new AppError(400, 'NOT_SUBMITTED', '这名学生还没有提交。');
  sendPlan(res, u, view, req.query.format === 'docx' ? 'docx' : 'html');
});

export default r;
