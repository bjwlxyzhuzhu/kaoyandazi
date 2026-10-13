// M9 “它记得什么”与 M8 干预（PRD 第9章）
import { Router } from 'express';
import { db } from '../db.js';
import { AppError } from '../errors.js';
import { requireStudent, requireTeacher } from '../auth.js';
import { listMemories, addMemory, deleteMemory, memoryCount, MEMORY_LIMIT, isSensitive, memoryStats } from '../memory.js';
import { pendingInterventions, chooseIntervention, interventionStats, runChecksForAll, countPortfolioMissing } from '../interventions.js';
import { nowLocal } from '../time.js';
import { mailHistory, mailConfigured, testMail } from '../mail.js';

const r = Router();

// ---------- 它记得什么（M9） ----------
r.get('/memories', requireStudent, (req, res) => {
  const rows = listMemories(req.user.id);
  res.json({
    memories: rows,
    count: rows.length,
    limit: MEMORY_LIMIT,
    note: '这里的内容由“拾光”在聊天中整理，你也可以自己增删。身份证号、住址、电话、家庭经济与健康信息不会被记录。',
  });
});

r.post('/memories', requireStudent, (req, res) => {
  const memory = addMemory(req.user.id, req.body?.content, req.body?.category);
  res.json({ memory, count: memoryCount(req.user.id), limit: MEMORY_LIMIT });
});

r.delete('/memories/:id', requireStudent, (req, res) => {
  deleteMemory(req.user.id, req.params.id);
  res.json({ ok: true, count: memoryCount(req.user.id) });
});

/** 逐条检查一段文本是否会记入敏感信息（前端做输入提示用） */
r.post('/memories/check', requireStudent, (req, res) => {
  const text = String(req.body?.content || '');
  const { blocked, reason } = isSensitive(text);
  res.json({ blocked, reason, message: blocked ? (reason === 'crisis' ? '这类内容平台不会记录，但你可以直接和搭子说，它会陪你。' : '这类信息（隐私或健康）平台不记录，请换一条。') : '' });
});

// ---------- 干预（M8） ----------
r.get('/interventions', requireStudent, (req, res) => {
  const pending = pendingInterventions(req.user.id);
  const done = db.prepare(`SELECT * FROM interventions WHERE user_id = ? AND (chosen IS NOT NULL OR resolved_at IS NOT NULL)
    ORDER BY id DESC LIMIT 20`).all(req.user.id).map((x) => ({
    id: x.id, rule: x.rule, title: x.title, message: x.message,
    options: x.options_json ? JSON.parse(x.options_json) : [],
    chosen: x.chosen, note: x.note && !String(x.note).startsWith('ref:') ? x.note : '',
    created_at: x.created_at, resolved_at: x.resolved_at,
  }));
  res.json({ pending, done, pending_count: pending.length });
});

r.post('/interventions/:id/choose', requireStudent, (req, res) => {
  const key = String(req.body?.choice || '');
  try {
    const out = chooseIntervention(req.user, req.params.id, key, req.body?.note);
    res.json(out);
  } catch (e) {
    if (e.message === 'NOT_FOUND') throw new AppError(404, 'NOT_FOUND', '没有这条提醒。');
    if (e.message === 'BAD_OPTION') throw new AppError(400, 'BAD_OPTION', '请选择一个处理方式。');
    if (e.message === 'NEED_NOTE') throw new AppError(400, 'NEED_NOTE', '这个选项需要写一句原因（至少5个字）。');
    throw e;
  }
});

// ---------- 教师端 ----------
r.post('/teacher/run-checks', requireTeacher, async (req, res) => {
  const force = req.body?.force === true;
  const out = await runChecksForAll({ force });
  res.json({ ...out, at: nowLocal() });
});

r.get('/teacher/interventions', requireTeacher, (req, res) => {
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  const stats = interventionStats({ from: from || undefined, to: to || undefined });
  const rows = db.prepare(`
    SELECT i.*, u.name, u.student_no FROM interventions i
    JOIN users u ON u.id = i.user_id
    ${from || to ? 'WHERE 1=1' : ''}
    ${from ? 'AND substr(i.created_at, 1, 10) >= ?' : ''}
    ${to ? 'AND substr(i.created_at, 1, 10) <= ?' : ''}
    ORDER BY i.id DESC LIMIT 200`).all(...[from, to].filter(Boolean));
  res.json({
    stats,
    rows: rows.map((x) => ({
      id: x.id, student: x.name, student_no: x.student_no, rule: x.rule, title: x.title,
      chosen: x.chosen, note: x.note && !String(x.note).startsWith('ref:') ? x.note : '',
      emailed: !!x.emailed, created_at: x.created_at, resolved_at: x.resolved_at,
    })),
  });
});

/** 每个学生的邮件记录 */
r.get('/teacher/mail-log', requireTeacher, (req, res) => {
  const userId = req.query.user_id ? Number(req.query.user_id) : undefined;
  res.json({ configured: mailConfigured(), rows: mailHistory({ userId, limit: 100 }) });
});

r.post('/teacher/test-mail', requireTeacher, async (req, res) => {
  const to = String(req.body?.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new AppError(400, 'BAD_EMAIL', '请填写正确的收件邮箱。');
  const out = await testMail(to);
  res.json(out);
});

/** 学生列表补充：记忆条数与最近对话时间（教师看不到内容） */
r.get('/teacher/students/memory-stats', requireTeacher, (_req, res) => {
  const students = db.prepare("SELECT id, name, student_no FROM users WHERE role = 'student' AND is_demo = 0 ORDER BY student_no").all();
  res.json({
    students: students.map((s) => {
      const stats = memoryStats(s.id);
      const last = db.prepare('SELECT MAX(m.created_at) AS t FROM messages m JOIN conversations c ON c.id = m.conv_id WHERE c.user_id = ?').get(s.id);
      const pending = db.prepare('SELECT COUNT(*) AS n FROM interventions WHERE user_id = ? AND chosen IS NULL AND resolved_at IS NULL').get(s.id).n;
      return {
        ...s, memory_count: stats.count, memory_last_at: stats.last_at,
        last_message_at: last?.t || null, pending_interventions: pending,
        portfolio_missing: countPortfolioMissing(s.id),
      };
    }),
    note: '教师只能看到记忆条数和最近对话时间，看不到记忆内容与对话原文。',
  });
});

export default r;
