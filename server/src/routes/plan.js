// M7 学习方案与打卡（第3章考核：阶段学习计划与复盘，15%）
import { Router } from 'express';
import { rememberDraft, recordAdoption, logAction } from '../trace.js';
import { db } from '../db.js';
import { nowLocal, todayLocal, addDays, weekdayOf, mondayOf, daysFrom } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent } from '../auth.js';
import { setFlowStatus, flowStatusOf } from '../stations.js';
import { generateJson } from '../llm/json.js';
import { resolveKey } from '../llm/keys.js';
import { renderPrompt, commonRules, verifiedMaterials, userBrief } from '../prompts.js';
import { displayName, getAgent } from '../registry.js';

const r = Router();

// 打卡复盘与前一天完全相同时提示换一句
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function lastMenu(userId, flow) {
  const row = db.prepare('SELECT answers_json FROM menu_answers WHERE user_id = ? AND flow = ? ORDER BY id DESC LIMIT 1').get(userId, flow);
  return row ? JSON.parse(row.answers_json) : null;
}

function profileOf(userId) {
  const row = db.prepare('SELECT profile_json, chosen_path, choice_reason FROM profiles WHERE user_id = ?').get(userId);
  if (!row) return { p: null, chosen: null, reason: null };
  const p = row.profile_json ? JSON.parse(row.profile_json) : null;
  const paths = p?.paths || [];
  return { p, chosen: paths.find((x) => x.id === row.chosen_path) || null, reason: row.choice_reason };
}

/** 是否有待生效的减量标记（干预 R2/R3 选择“减量”时置位，阶段3接入规则引擎） */
function reduceFlag(userId) {
  const row = db.prepare('SELECT reduce_flag FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId);
  return !!row?.reduce_flag;
}

function activePlan(userId) {
  return db.prepare('SELECT * FROM plans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(userId);
}

function tasksOf(userId, planId) {
  return db.prepare('SELECT * FROM tasks WHERE user_id = ? AND plan_id = ? ORDER BY date, id').all(userId, planId);
}

/** 每日任务总时长上限：每周可投入小时 ÷ 7 × 1.2（×60 = ×72/7，先乘后除避免浮点误差） */
export function dailyCapMinutes(weeklyHours) {
  return Math.floor((Number(weeklyHours) * 72) / 7);
}

function validatePlan(plan, weeklyHours) {
  if (!Array.isArray(plan.week) || plan.week.length !== 7) {
    throw new AppError(400, 'BAD_PLAN', '方案里应该有未来7天的任务安排。');
  }
  const cap = dailyCapMinutes(weeklyHours);
  for (const day of plan.week) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day.date || ''))) throw new AppError(400, 'BAD_PLAN', '某一天的日期格式不正确。');
    const total = (day.tasks || []).reduce((n, t) => n + (Number(t.minutes) || 0), 0);
    if (total > cap) {
      throw new AppError(400, 'OVER_CAP', `${day.date} 的任务共 ${total} 分钟，超过了每天的上限 ${cap} 分钟（每周可投入${weeklyHours}小时 ÷ 7 × 1.2）。请调整后重试。`);
    }
  }
  return { cap };
}

/** 生成方案（附录B.6） */
r.post('/plan/generate', requireStudent, async (req, res) => {
  const u = req.user;
  const answers = lastMenu(u.id, 'plan');
  if (!answers) throw new AppError(400, 'NO_MENU', '请先完成学习方案的菜单题。');
  const { key, source } = resolveKey(u, 'M7_plan', req.get('X-User-Key'));
  const { p, chosen, reason } = profileOf(u.id);
  const weeklyHours = Number(answers.weekly_hours) || p?.weekly_hours || 20;
  const start = todayLocal();

  const prompt = {
    system: renderPrompt('plan', {
      ...userBrief(u),
      导师显示名: displayName(getAgent('planner')),
      共同规则: commonRules(),
      已核实资料: verifiedMaterials(),
      画像摘要: p?.summary || '（还没有画像）',
      已选路径: chosen ? `${chosen.name}（理由：${reason || '未填'}）` : '（还没有选定路径）',
      每周可投入: weeklyHours,
      可用时段: (answers.slots || []).join('、'),
      本阶段重点: (answers.focus || []).join('、'),
      是否包含科研阅读: answers.research === '包含（推荐）' ? '是' : '否',
      节奏偏好: answers.rhythm,
      减量标记: reduceFlag(u.id) ? '有：学生最近的完成率偏低，本周任务量减少约30%，优先保留核心任务。' : '无',
      开始日期: start,
    }),
    user: '请生成这位学生的阶段学习方案，只输出 JSON。',
  };
  const { data } = await generateJson({ user: u, moduleId: 'M7_plan', purpose: '生成学习方案', prompt, key, source, useReason: true, maxTokens: 3500 });
  validatePlan(data, weeklyHours);
  rememberDraft(u.id, 'plan', data);
  res.json({ plan: data, daily_cap_minutes: dailyCapMinutes(weeklyHours) });
});

/** 采用方案：保存并生成任务（学生点“采用这份方案”才写入） */
r.post('/plan/save', requireStudent, (req, res) => {
  const u = req.user;
  const plan = req.body?.plan;
  if (!plan || typeof plan !== 'object') throw new AppError(400, 'BAD_PLAN', '方案内容不正确。');
  const answers = lastMenu(u.id, 'plan');
  const weeklyHours = Number(answers?.weekly_hours) || Number(plan.weekly_hours) || 20;
  validatePlan(plan, weeklyHours);

  const now = nowLocal();
  db.prepare('UPDATE plans SET active = 0 WHERE user_id = ?').run(u.id);
  const info = db.prepare('INSERT INTO plans(user_id, plan_json, active, reduce_flag, created_at) VALUES(?, ?, 1, ?, ?)')
    .run(u.id, JSON.stringify({ ...plan, weekly_hours: weeklyHours }), reduceFlag(u.id) ? 1 : 0, now);
  const planId = Number(info.lastInsertRowid);
  recordAdoption(u.id, 'plan', planId, plan);

  // 重新生成未来7天的任务
  db.prepare('DELETE FROM tasks WHERE user_id = ? AND date >= ?').run(u.id, todayLocal());
  const ins = db.prepare('INSERT INTO tasks(user_id, plan_id, date, title, kind, minutes, done) VALUES(?, ?, ?, ?, ?, ?, 0)');
  let count = 0;
  for (const day of plan.week) {
    for (const t of day.tasks || []) {
      ins.run(u.id, planId, day.date, String(t.title || '').slice(0, 120), String(t.kind || '').slice(0, 20), Number(t.minutes) || 0);
      count += 1;
    }
  }
  setFlowStatus(u.id, 5, 'done');
  if (flowStatusOf(u.id, 6) === 'not_started') setFlowStatus(u.id, 6, 'in_progress');
  res.json({ plan_id: planId, task_count: count, daily_cap_minutes: dailyCapMinutes(weeklyHours) });
});

/** 当前方案 + 未来7天任务 + 方案版本历史 */
r.get('/plan', requireStudent, (req, res) => {
  const u = req.user;
  const plan = db.prepare('SELECT * FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(u.id);
  const active = activePlan(u.id);
  // 未采用方案时也要显示任务：导师团确认的行动项、手动添加的任务都不依赖方案存在
  const tasks = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND date >= ? ORDER BY date, id').all(u.id, todayLocal());
  const versions = db.prepare('SELECT id, active, reduce_flag, created_at FROM plans WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id);
  res.json({
    plan: active?.plan_json ? JSON.parse(active.plan_json) : null,
    plan_id: active?.id || null,
    versions,
    latest_is_active: !!(plan && active && plan.id === active.id),
    tasks,
    tasks_by_date: groupByDate(tasks),
    reduce_flag: !!active?.reduce_flag,
  });
});

function groupByDate(tasks) {
  const map = {};
  for (const t of tasks) (map[t.date] ||= []).push(t);
  return map;
}

/** 手动增删改任务 */
r.post('/tasks', requireStudent, (req, res) => {
  const u = req.user;
  const b = req.body || {};
  const date = String(b.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError(400, 'BAD_DATE', '日期格式不正确。');
  const title = String(b.title || '').trim().slice(0, 120);
  if (!title) throw new AppError(400, 'NO_TITLE', '请填写任务内容。');
  const plan = activePlan(u.id);
  const minutes = Math.max(0, Math.min(600, Number(b.minutes) || 0));
  // 当天总时长不能超过上限
  const answers = lastMenu(u.id, 'plan');
  const weeklyHours = Number(answers?.weekly_hours) || Number(plan?.plan_json ? JSON.parse(plan.plan_json).weekly_hours : 0) || 0;
  if (weeklyHours) {
    const used = db.prepare('SELECT COALESCE(SUM(minutes), 0) AS m FROM tasks WHERE user_id = ? AND date = ?').get(u.id, date).m;
    const cap = dailyCapMinutes(weeklyHours);
    if (used + minutes > cap) throw new AppError(400, 'OVER_CAP', `这一天已经有 ${used} 分钟任务，加上这条会超过每天 ${cap} 分钟的上限。`);
  }
  const info = db.prepare('INSERT INTO tasks(user_id, plan_id, date, title, kind, minutes, done) VALUES(?, ?, ?, ?, ?, ?, 0)')
    .run(u.id, plan?.id || null, date, title, String(b.kind || '专业课').slice(0, 20), minutes);
  res.json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid) });
});

r.put('/tasks/:id', requireStudent, (req, res) => {
  const u = req.user;
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(Number(req.params.id), u.id);
  if (!row) throw new AppError(404, 'NOT_FOUND', '没有这条任务。');
  const b = req.body || {};
  db.prepare('UPDATE tasks SET title = ?, kind = ?, minutes = ?, done = ? WHERE id = ?').run(
    b.title !== undefined ? String(b.title).slice(0, 120) : row.title,
    b.kind !== undefined ? String(b.kind).slice(0, 20) : row.kind,
    b.minutes !== undefined ? Math.max(0, Math.min(600, Number(b.minutes) || 0)) : row.minutes,
    b.done !== undefined ? (b.done ? 1 : 0) : row.done,
    row.id);
  res.json({ task: db.prepare('SELECT * FROM tasks WHERE id = ?').get(row.id) });
});

r.delete('/tasks/:id', requireStudent, (req, res) => {
  const info = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '没有这条任务。');
  res.json({ ok: true });
});

/** 连续打卡天数（今天没打卡则从昨天开始算） */
function streak(userId) {
  const has = new Set(db.prepare('SELECT date FROM checkins WHERE user_id = ? ORDER BY date DESC LIMIT 400').all(userId).map((x) => x.date));
  let d = todayLocal();
  if (!has.has(d)) d = addDays(d, -1);
  let n = 0;
  while (has.has(d)) { n += 1; d = addDays(d, -1); }
  return n;
}

/** 一组日期内的任务完成率：打过卡的日子用打卡时的勾选数，没打卡的日子按当天任务全部未完成计 */
function completion(userId, dates) {
  const rows = db.prepare('SELECT date, done_count, total_count FROM checkins WHERE user_id = ? AND date BETWEEN ? AND ?').all(userId, dates[0], dates[dates.length - 1]);
  const map = new Map(rows.map((x) => [x.date, x]));
  const countTasks = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND date = ?');
  let done = 0;
  let all = 0;
  for (const d of dates) {
    const c = map.get(d);
    done += c ? c.done_count : 0;
    all += c ? c.total_count : countTasks.get(userId, d).n;
  }
  return { done, all, rate: all ? done / all : 0 };
}

/** 打卡（每天一次，当天可修改）。服务端确认成功后才由前端盖章。 */
r.post('/checkin', requireStudent, (req, res) => {
  const u = req.user;
  const b = req.body || {};
  const date = typeof b.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : todayLocal();
  const today = todayLocal();
  if (date > today) throw new AppError(400, 'FUTURE', '还不能给未来的日期打卡。');
  const reflection = String(b.reflection || '').trim();
  if (reflection.length < 10) throw new AppError(400, 'SHORT_REFLECTION', `一句复盘至少10字，现在写了${reflection.length}字。说说今天真实发生了什么。`);
  const prev = db.prepare('SELECT reflection FROM checkins WHERE user_id = ? AND date < ? ORDER BY date DESC LIMIT 1').get(u.id, date);
  if (prev && prev.reflection && prev.reflection.trim() === reflection) {
    throw new AppError(400, 'SAME_REFLECTION', '换一句今天真实的复盘吧，和上一次完全一样。');
  }
  const doneIds = Array.isArray(b.done_task_ids) ? b.done_task_ids.map(Number).filter(Number.isInteger) : [];
  const dayTasks = db.prepare('SELECT id FROM tasks WHERE user_id = ? AND date = ?').all(u.id, date);
  const total = dayTasks.length;
  const doneCount = doneIds.filter((id) => dayTasks.some((t) => t.id === id)).length;
  const minutes = Math.max(0, Math.min(24 * 60, Number(b.minutes) || 0));
  const accuracy = b.accuracy === null || b.accuracy === undefined || b.accuracy === '' ? null : Math.max(0, Math.min(100, Number(b.accuracy)));
  const mood = Math.max(1, Math.min(5, Number(b.mood) || 3));

  // 勾选的任务状态同步
  const mark = db.prepare('UPDATE tasks SET done = ? WHERE id = ?');
  for (const t of dayTasks) mark.run(doneIds.includes(t.id) ? 1 : 0, t.id);

  const existing = db.prepare('SELECT id FROM checkins WHERE user_id = ? AND date = ?').get(u.id, date);
  if (existing) {
    db.prepare('UPDATE checkins SET minutes = ?, accuracy = ?, done_count = ?, total_count = ?, reflection = ?, mood = ? WHERE id = ?')
      .run(minutes, accuracy, doneCount, total, reflection, mood, existing.id);
  } else {
    db.prepare('INSERT INTO checkins(user_id, date, minutes, accuracy, done_count, total_count, reflection, mood) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(u.id, date, minutes, accuracy, doneCount, total, reflection, mood);
  }
  res.json({
    ok: true, date, done_count: doneCount, total_count: total,
    streak: streak(u.id), updated: !!existing,
    // 只在服务端确认成功后返回，前端据此盖章
    stamped_at: nowLocal(),
  });
});

r.get('/checkins', requireStudent, (req, res) => {
  const u = req.user;
  const days = Math.min(120, Math.max(1, Number(req.query.days) || 30));
  const rows = db.prepare('SELECT * FROM checkins WHERE user_id = ? ORDER BY date DESC LIMIT ?').all(u.id, days);
  const total = db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ?').get(u.id).n;
  const rate7 = completion(u.id, daysFrom(addDays(todayLocal(), -6), 7)).rate;
  res.json({ checkins: rows, total, streak: streak(u.id), rate7, today: todayLocal(), today_checked: rows.some((x) => x.date === todayLocal()) });
});

/** 今日打卡页数据 */
r.get('/checkin/today', requireStudent, (req, res) => {
  const u = req.user;
  const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : todayLocal();
  const tasks = db.prepare('SELECT * FROM tasks WHERE user_id = ? AND date = ? ORDER BY id').all(u.id, date);
  const checkin = db.prepare('SELECT * FROM checkins WHERE user_id = ? AND date = ?').get(u.id, date);
  const answers = lastMenu(u.id, 'plan');
  const weeklyHours = Number(answers?.weekly_hours) || 0;
  res.json({
    date,
    weekday: WEEKDAY[weekdayOf(date)],
    tasks,
    checkin: checkin || null,
    cap_minutes: weeklyHours ? dailyCapMinutes(weeklyHours) : null,
    streak: streak(u.id),
    can_edit: date === todayLocal(),
  });
});

/** 周复盘（菜单式）：完成率自动计算 */
r.post('/weekly-review', requireStudent, (req, res) => {
  const u = req.user;
  const b = req.body || {};
  const weekStart = typeof b.week_start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.week_start) ? b.week_start : mondayOf(todayLocal());
  const blockers = Array.isArray(b.blockers) ? b.blockers.slice(0, 10) : [];
  const adjust = Array.isArray(b.adjust) ? b.adjust.slice(0, 10) : [];
  const summary = String(b.summary || '').trim();
  if (!blockers.length) throw new AppError(400, 'NO_BLOCKERS', '请至少选一个本周的卡点。');
  if (!adjust.length) throw new AppError(400, 'NO_ADJUST', '请选择下周打算怎么调整。');
  if (summary.length < 10) throw new AppError(400, 'SHORT_SUMMARY', '一句话总结至少10字。');

  const { rate } = completion(u.id, daysFrom(weekStart, 7));
  const existing = db.prepare('SELECT id FROM weekly_reviews WHERE user_id = ? AND week_start = ?').get(u.id, weekStart);
  if (existing) {
    db.prepare('UPDATE weekly_reviews SET rate = ?, blockers_json = ?, adjust_json = ?, summary = ?, created_at = ? WHERE id = ?')
      .run(rate, JSON.stringify(blockers), JSON.stringify(adjust), summary, nowLocal(), existing.id);
  } else {
    db.prepare('INSERT INTO weekly_reviews(user_id, week_start, rate, blockers_json, adjust_json, summary, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(u.id, weekStart, rate, JSON.stringify(blockers), JSON.stringify(adjust), summary, nowLocal());
  }
  res.json({ week_start: weekStart, rate, blockers, adjust, summary });
});

r.get('/weekly-review', requireStudent, (req, res) => {
  const u = req.user;
  const list = db.prepare('SELECT * FROM weekly_reviews WHERE user_id = ? ORDER BY week_start DESC LIMIT 20').all(u.id);
  const weekStart = mondayOf(todayLocal());
  const dates = daysFrom(weekStart, 7);
  const rows = db.prepare(`SELECT date, done_count, total_count, reflection, minutes, mood FROM checkins WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date`).all(u.id, dates[0], dates[6]);
  const { done, all, rate } = completion(u.id, dates);
  res.json({
    reviews: list.map((x) => ({ ...x, blockers: JSON.parse(x.blockers_json || '[]'), adjust: JSON.parse(x.adjust_json || '[]') })),
    current: { week_start: weekStart, dates, rate, done, all, checkins: rows, reviewed: list.some((x) => x.week_start === weekStart) },
  });
});

export default r;
