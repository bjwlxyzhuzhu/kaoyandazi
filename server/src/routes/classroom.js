// M2 课堂：课件、课堂任务与提交（互评在阶段7）
import { Router } from 'express';
import { db, getSetting, setSetting } from '../db.js';
import { nowLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent, requireTeacher } from '../auth.js';
import { chapterMeta, studentCourseware, getCourseware, studentTaskDef, getTaskDefs, gradeQuiz } from '../courseware.js';
import { setFlowStatus, flowStatusOf } from '../stations.js';

const r = Router();

export function unlockedChapters() {
  const raw = getSetting('unlocked_chapters', '[1]');
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr.map(Number) : [1];
  } catch {
    return [1];
  }
}

export function unlockChapter(no) {
  const set = new Set(unlockedChapters());
  set.add(Number(no));
  setSetting('unlocked_chapters', JSON.stringify([...set].sort((a, b) => a - b)));
}

function isUnlocked(no) {
  return unlockedChapters().includes(Number(no));
}

// ---------- 学生端 ----------
r.get('/chapters', requireStudent, (req, res) => {
  const unlocked = unlockedChapters();
  res.json({
    chapters: chapterMeta().map((c) => ({ ...c, unlocked: unlocked.includes(c.chapter) })),
  });
});

r.get('/chapters/:no', requireStudent, (req, res) => {
  const no = Number(req.params.no);
  const cw = studentCourseware(no);
  if (!cw) throw new AppError(404, 'NO_CHAPTER', '这一章的课件还没有准备好。');
  if (!isUnlocked(no)) throw new AppError(403, 'LOCKED', '这一章还没有解锁，等老师在课上解锁后再看。');
  const defs = getTaskDefs(no);
  const tasks = (defs?.tasks || []).map((t) => {
    const sub = db.prepare('SELECT * FROM submissions WHERE user_id = ? AND chapter = ? AND task_id = ?').get(req.user.id, no, t.id);
    const def = studentTaskDef(no, t.id);
    return {
      id: t.id, type: t.type, title: t.title,
      submitted: !!sub,
      score: sub?.score ?? null,
      content: sub?.content_json ? JSON.parse(sub.content_json) : null,
      def,
    };
  });
  res.json({ courseware: cw, tasks, unlocked: true });
});

function validateSubmission(def, content) {
  const c = content && typeof content === 'object' ? content : {};
  if (def.type === 'quiz') {
    const answers = c.answers || {};
    if (!Object.keys(answers).length) throw new AppError(400, 'EMPTY', '还没有作答。');
    return { answers };
  }
  if (def.type === 'poll') {
    if (!def.options.some((o) => o.key === c.choice)) throw new AppError(400, 'INCOMPLETE', '请先选一个选项。');
    const out = { choice: c.choice };
    if (def.extra && c.extra) out.extra = String(c.extra).trim().slice(0, def.extra.max || 100);
    return out;
  }
  const out = {};
  for (const f of def.fields || []) {
    const v = c[f.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (empty) {
      if (f.required) throw new AppError(400, 'INCOMPLETE', `还没有填写：${f.label}`);
      continue;
    }
    if (f.type === 'multi') {
      if (!Array.isArray(v)) throw new AppError(400, 'BAD_CONTENT', `${f.label} 需要是多选。`);
      const min = Number(f.min) || 0;
      if (v.length < min) throw new AppError(400, 'INCOMPLETE', `${f.label} 至少选${min}项。`);
      out[f.key] = v.slice(0, 20);
    } else if (f.type === 'select') {
      if (!f.options.includes(v)) throw new AppError(400, 'BAD_CONTENT', `${f.label} 里有不认识的选项。`);
      out[f.key] = v;
    } else if (f.type === 'text') {
      out[f.key] = String(v).trim().slice(0, f.max || 100);
    } else {
      out[f.key] = String(v).trim().slice(0, f.max || 500);
    }
  }
  return out;
}

r.post('/chapters/:no/tasks/:tid', requireStudent, (req, res) => {
  const no = Number(req.params.no);
  const tid = String(req.params.tid);
  if (!isUnlocked(no)) throw new AppError(403, 'LOCKED', '这一章还没有解锁。');
  const def = getTaskDefs(no)?.tasks?.find((t) => t.id === tid);
  if (!def) throw new AppError(404, 'NO_TASK', '没有这个课堂任务。');
  const existing = db.prepare('SELECT id FROM submissions WHERE user_id = ? AND chapter = ? AND task_id = ?').get(req.user.id, no, tid);
  if (existing && def.type === 'quiz') throw new AppError(409, 'ALREADY_DONE', '测验只能提交一次。');

  let content;
  let score = null;
  if (def.type === 'quiz') {
    const v = validateSubmission(def, req.body?.content);
    const graded = gradeQuiz(no, tid, v.answers);
    // 学生看到的只是分数与解析；正确选项在下发时就已剥离，这里返回解析供复盘
    content = { answers: v.answers };
    score = graded ? Math.round((graded.correct / graded.total) * 100) : null;
    db.prepare(`INSERT INTO submissions(user_id, chapter, task_id, content_json, score, created_at) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, chapter, task_id) DO UPDATE SET content_json = excluded.content_json, score = excluded.score, created_at = excluded.created_at`)
      .run(req.user.id, no, tid, JSON.stringify(content), score, nowLocal());
    if (no === 1 && flowStatusOf(req.user.id, 1) === 'not_started') setFlowStatus(req.user.id, 1, 'in_progress');
    return res.json({ score, correct: graded.correct, total: graded.total, detail: graded.detail });
  }

  content = validateSubmission(def, req.body?.content);
  db.prepare(`INSERT INTO submissions(user_id, chapter, task_id, content_json, score, created_at) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, chapter, task_id) DO UPDATE SET content_json = excluded.content_json, created_at = excluded.created_at`)
    .run(req.user.id, no, tid, JSON.stringify(content), score, nowLocal());
  if (no === 1 && flowStatusOf(req.user.id, 1) === 'not_started') setFlowStatus(req.user.id, 1, 'in_progress');
  res.json({ ok: true });
});

/** 投票实时分布（投屏用） */
r.get('/chapters/:no/tasks/:tid/distribution', requireStudent, (req, res) => {
  const no = Number(req.params.no);
  const tid = String(req.params.tid);
  const def = getTaskDefs(no)?.tasks?.find((t) => t.id === tid);
  if (!def || def.type !== 'poll') throw new AppError(404, 'NO_TASK', '这个任务不是投票。');
  const rows = db.prepare(`SELECT content_json FROM submissions WHERE chapter = ? AND task_id = ?`).all(no, tid);
  const counts = {};
  for (const o of def.options) counts[o.key] = 0;
  for (const row of rows) {
    const c = JSON.parse(row.content_json || '{}');
    if (c.choice && counts[c.choice] !== undefined) counts[c.choice] += 1;
  }
  const total = rows.length;
  res.json({ counts, total, options: def.options.map((o) => ({ ...o, count: counts[o.key], percent: total ? Math.round((counts[o.key] / total) * 100) : 0 })) });
});

/** 我的提交记录（成长档案用） */
r.get('/submissions', requireStudent, (req, res) => {
  const rows = db.prepare('SELECT chapter, task_id, score, created_at FROM submissions WHERE user_id = ? ORDER BY chapter, task_id').all(req.user.id);
  res.json({ submissions: rows });
});

// ---------- 教师端 ----------
r.get('/teacher/chapters', requireTeacher, (_req, res) => {
  const unlocked = unlockedChapters();
  res.json({ chapters: chapterMeta().map((c) => ({ ...c, unlocked: unlocked.includes(c.chapter) })) });
});

r.post('/teacher/chapters/:no/unlock', requireTeacher, (req, res) => {
  const no = Number(req.params.no);
  if (!chapterMeta().some((c) => c.chapter === no)) throw new AppError(404, 'NO_CHAPTER', '没有这一章。');
  unlockChapter(no);
  res.json({ chapters: chapterMeta().map((c) => ({ ...c, unlocked: unlockedChapters().includes(c.chapter) })) });
});

/** 课件（教师版，含备注） */
r.get('/teacher/chapters/:no', requireTeacher, (req, res) => {
  const cw = getCourseware(Number(req.params.no));
  if (!cw) throw new AppError(404, 'NO_CHAPTER', '没有这一章的课件。');
  res.json({ courseware: cw, unlocked: isUnlocked(Number(req.params.no)) });
});

/** 按“章—任务”查看提交与未提交名单 */
r.get('/teacher/submissions', requireTeacher, (req, res) => {
  const chapter = Number(req.query.chapter) || 1;
  const defs = getTaskDefs(chapter);
  const students = db.prepare(`SELECT id, student_no, name FROM users WHERE role = 'student' AND is_demo = 0 AND class_id IN (SELECT id FROM classes WHERE is_sandbox = 0) ORDER BY student_no`).all();
  const tasks = (defs?.tasks || []).map((t) => {
    const rows = db.prepare('SELECT user_id, score, created_at FROM submissions WHERE chapter = ? AND task_id = ?').all(chapter, t.id);
    const map = new Map(rows.map((r) => [r.user_id, r]));
    return {
      id: t.id, type: t.type, title: t.title,
      submitted: students.filter((s) => map.has(s.id)).length,
      total: students.length,
      students: students.map((s) => ({
        student_no: s.student_no, name: s.name,
        submitted: map.has(s.id),
        score: map.get(s.id)?.score ?? null,
        at: map.get(s.id)?.created_at || null,
      })),
    };
  });
  res.json({ chapter, tasks });
});

/** 导出提交情况 CSV（UTF-8 BOM） */
r.get('/teacher/submissions/export', requireTeacher, (req, res) => {
  const chapter = Number(req.query.chapter) || 1;
  const defs = getTaskDefs(chapter);
  const students = db.prepare(`SELECT id, student_no, name FROM users WHERE role = 'student' AND is_demo = 0 AND class_id IN (SELECT id FROM classes WHERE is_sandbox = 0) ORDER BY student_no`).all();
  const tasks = defs?.tasks || [];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['学号', '姓名', ...tasks.map((t) => `${t.id} ${t.title}`)];
  const lines = [head.map(esc).join(',')];
  for (const s of students) {
    const row = [s.student_no, s.name];
    for (const t of tasks) {
      const sub = db.prepare('SELECT score, created_at FROM submissions WHERE user_id = ? AND chapter = ? AND task_id = ?').get(s.id, chapter, t.id);
      row.push(sub ? (sub.score === null ? `已提交 ${sub.created_at.slice(5, 16)}` : `已提交 ${sub.score}分`) : '未提交');
    }
    lines.push(row.map(esc).join(','));
  }
  const csv = `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`第${chapter}章课堂任务-${nowLocal().slice(0, 10)}`)}.csv` });
  res.send(csv);
});

export default r;
