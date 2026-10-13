// M8 干预规则引擎 R1—R8（PRD 7.8）。全部基于规则与模板，不调用大模型。
import { db } from './db.js';
import { nowLocal, todayLocal, addDays, weekdayOf } from './time.js';
import { getSetting } from './db.js';
import { sendMail, mailConfigured } from './mail.js';

/** 同一类干预3天内不重复 */
export const REPEAT_DAYS = 3;
/** 每日巡检的整点（教师后台可改） */
export const DEFAULT_CHECK_HOUR = 8;

const MENUS = {
  R1: [],
  R2: [
    { key: 'reduce', label: '下周减量30%', effect: 'reduce' },
    { key: 'reschedule', label: '换学习时段', effect: 'goto', route: '/road/5' },
    { key: 'talk', label: '和搭子聊聊', effect: 'talk' },
    { key: 'pause', label: '暂停几天', effect: 'pause', requireNote: true },
  ],
  R3: [
    { key: 'lighter', label: '降低任务量', effect: 'reduce' },
    { key: 'split', label: '拆小任务', effect: 'goto', route: '/road/5' },
    { key: 'talk', label: '和搭子找原因', effect: 'talk' },
    { key: 'keep', label: '保持不变', effect: 'keep', requireNote: true },
  ],
  R4: [
    { key: 'coach', label: '找成果教练帮忙', effect: 'goto', route: '/road/9' },
    { key: 'handled', label: '已处理好', effect: 'done' },
    { key: 'drop', label: '放弃这项', effect: 'done', requireNote: true },
  ],
  R5: [
    { key: 'now', label: '现在去做', effect: 'goto' },
    { key: 'thisweek', label: '本周内完成', effect: 'keep' },
    { key: 'talk', label: '和搭子聊聊', effect: 'talk' },
  ],
  R6: [
    { key: 'weekly', label: '做周复盘并生成下周计划', effect: 'goto', route: '/road/6' },
    { key: 'talk', label: '先和搭子复盘', effect: 'talk' },
    { key: 'keep', label: '沿用本周计划', effect: 'keep' },
  ],
  R7: [
    { key: 'recommend', label: '找阅读助手推荐一篇', effect: 'goto', route: '/road/8' },
    { key: 'twocards', label: '本周补2篇', effect: 'keep' },
    { key: 'retopic', label: '调整选题方向', effect: 'goto', route: '/road/8' },
  ],
  R8: [
    { key: 'checklist', label: '查看缺项清单', effect: 'goto', route: '/growth' },
    { key: 'talk', label: '和搭子定补齐计划', effect: 'talk' },
  ],
};

export const RULE_TITLES = {
  R1: '今天还没打卡',
  R2: '有两天没打卡了',
  R3: '最近任务有点重',
  R4: '登记的成果快截止了',
  R5: '有一站停了好几天',
  R6: '该做本周复盘了',
  R7: '阅读断了几天',
  R8: '结课考核快到了',
};

/** 取该学生的巡检偏好 */
function prefs(user) {
  const hour = Number(getSetting('checks.hour') ?? DEFAULT_CHECK_HOUR);
  return { hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : DEFAULT_CHECK_HOUR };
}

function alreadyTriggered(userId, rule, withinDays = REPEAT_DAYS) {
  const from = addDays(todayLocal(), -(withinDays - 1));
  const row = db.prepare("SELECT id FROM interventions WHERE user_id = ? AND rule = ? AND substr(created_at, 1, 10) >= ? LIMIT 1")
    .get(userId, rule, from);
  return !!row;
}

function createIntervention(userId, rule, message, extra = {}) {
  const options = MENUS[rule] || [];
  const info = db.prepare(`INSERT INTO interventions(user_id, rule, title, message, options_json, emailed, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, rule, RULE_TITLES[rule], message, JSON.stringify(options), extra.emailed ? 1 : 0, nowLocal());
  return db.prepare('SELECT * FROM interventions WHERE id = ?').get(info.lastInsertRowid);
}

// ---------- 各规则的触发判断 ----------

function hasPlan(userId) {
  return !!db.prepare('SELECT id FROM plans WHERE user_id = ? AND active = 1').get(userId);
}

function checked(userId, date) {
  return !!db.prepare('SELECT id FROM checkins WHERE user_id = ? AND date = ?').get(userId, date);
}

function completionRate(userId, dates) {
  let done = 0;
  let all = 0;
  const countTasks = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND date = ?');
  for (const d of dates) {
    const c = db.prepare('SELECT done_count, total_count FROM checkins WHERE user_id = ? AND date = ?').get(userId, d);
    done += c ? c.done_count : 0;
    all += c ? c.total_count : countTasks.get(userId, d).n;
  }
  return { done, all, rate: all ? done / all : 0 };
}

/** 返回该学生本次需要触发的规则列表 [{rule, message, email?}] */
export function evaluate(user, now = new Date()) {
  const uid = user.id;
  const today = todayLocal(now);
  const hits = [];
  const plan = hasPlan(uid);
  const everChecked = !!db.prepare('SELECT id FROM checkins WHERE user_id = ? LIMIT 1').get(uid);
  const hour = nowLocal(now).slice(11, 13);

  // R1 每日提醒：当天有任务、到提醒时间还没打卡（仅邮件）
  const todayTasks = db.prepare('SELECT id FROM tasks WHERE user_id = ? AND date = ?').get(uid, today);
  if (user.email_remind && todayTasks && !checked(uid, today) && Number(hour) >= Number(user.remind_hour ?? 20)) {
    hits.push({ rule: 'R1', emailOnly: true, message: `今天还有任务没完成，记得回来勾一下并写一句复盘。` });
  }

  // R2 断卡：有方案、曾打卡，昨天和前天都没打卡
  if (plan && everChecked && !checked(uid, addDays(today, -1)) && !checked(uid, addDays(today, -2))) {
    hits.push({ rule: 'R2', message: '你昨天和前天都没有打卡。是任务太重，还是这几天有别的事？选一个处理方式，我们下周调整。' });
  }

  // R3 计划过载：近7天打卡 ≥3 次，且完成率 < 50%
  const last7 = Array.from({ length: 7 }, (_, i) => addDays(today, -i));
  const checkinDays = last7.filter((d) => checked(uid, d)).length;
  const rate7 = completionRate(uid, last7);
  if (checkinDays >= 3 && rate7.all > 0 && rate7.rate < 0.5) {
    hits.push({ rule: 'R3', message: `最近7天你打了 ${checkinDays} 次卡，完成率是 ${Math.round(rate7.rate * 100)}%。任务可能排多了，我们可以调整。` });
  }

  // R4 成果截止：登记的成果项目7天内截止且未完成
  const due = db.prepare(`SELECT id, name, deadline FROM achievements
    WHERE user_id = ? AND deadline IS NOT NULL AND deadline != ''
      AND stage NOT IN ('已完成', '已放弃')
      AND deadline >= ? AND deadline <= ?`).all(uid, today, addDays(today, 7));
  for (const a of due) {
    hits.push({ rule: 'R4', message: `「${a.name}」还有不到一周就到截止日期（${a.deadline}），现在进展怎么样？`, ref: a.id });
  }

  // R5 流程停滞：主线某一站停留超过7天
  const stuck = db.prepare(`SELECT station, updated_at FROM flow_status
    WHERE user_id = ? AND status = 'in_progress' AND substr(updated_at, 1, 10) <= ? ORDER BY station LIMIT 1`)
    .get(uid, addDays(today, -7));
  if (stuck) {
    const days = Math.abs(daysBetween(stuck.updated_at.slice(0, 10), today));
    hits.push({
      rule: 'R5',
      message: `你在第${stuck.station}站停留了 ${days} 天。要不要现在推进一小步？`,
      route: `/road/${stuck.station}`,
    });
  }

  // R6 周复盘：每周日，有学习方案
  if (weekdayOf(today) === 0 && plan) {
    const reviewed = db.prepare('SELECT id FROM weekly_reviews WHERE user_id = ? AND week_start = ?').get(uid, addDays(today, -6));
    if (!reviewed) hits.push({ rule: 'R6', message: '今天是周日，花几分钟回顾这一周吧。下周的计划也可以顺手调整。' });
  }

  // R7 阅读断档：已有选题方向，但7天内没有新增阅读卡
  const hasTopic = !!db.prepare('SELECT id FROM topics WHERE user_id = ? LIMIT 1').get(uid)
    || !!db.prepare('SELECT id FROM topic_ideas WHERE user_id = ? LIMIT 1').get(uid);
  if (hasTopic) {
    const recentCard = db.prepare('SELECT id FROM reading_cards WHERE user_id = ? AND substr(created_at, 1, 10) >= ? LIMIT 1')
      .get(uid, addDays(today, -7));
    if (!recentCard) hits.push({ rule: 'R7', message: '这一周没有新增阅读卡。要不要挑一篇短的读一读？' });
  }

  // R8 考核临近：结课考核截止前7天（教师设置），档案袋仍有缺项
  const deadline = getSetting('portfolio.deadline');
  if (deadline && deadline >= today && deadline <= addDays(today, 7)) {
    const missing = countPortfolioMissing(uid);
    if (missing > 0) hits.push({ rule: 'R8', message: `距离结课考核截止（${deadline}）不到一周，考核档案袋还缺 ${missing} 项。` });
  }

  return hits;
}

function daysBetween(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}

/** 档案袋缺项数（阶段7会实现完整版；现在按已有产物统计） */
export function countPortfolioMissing(userId) {
  const checks = [
    ['个人画像', 'SELECT 1 FROM profiles WHERE user_id = ?'],
    ['路径选择', "SELECT 1 FROM profiles WHERE user_id = ? AND chosen_path IS NOT NULL AND choice_reason IS NOT NULL AND choice_reason != ''"],
    ['院校信息分析表', 'SELECT 1 FROM schools WHERE user_id = ?'],
    ['学习计划', 'SELECT 1 FROM plans WHERE user_id = ? AND active = 1'],
    ['打卡记录', 'SELECT 1 FROM checkins WHERE user_id = ?'],
    ['周复盘', 'SELECT 1 FROM weekly_reviews WHERE user_id = ?'],
  ];
  let missing = 0;
  for (const [, sql] of checks) {
    if (!db.prepare(sql).get(userId)) missing += 1;
  }
  return missing;
}

/**
 * 巡检一个学生：写干预、发邮件。返回本次新触发的规则编号。
 * 同一类干预3天内不重复；没有配置 SMTP 时照常写干预，只是不发邮件。
 */
export async function runChecksFor(user, { now = new Date(), force = false } = {}) {
  const hits = evaluate(user, now);
  const created = [];
  for (const hit of hits) {
    if (!force && alreadyTriggered(user.id, hit.rule)) continue;
    let emailed = false;
    let mailNote = '';
    if (hit.emailOnly) {
      // R1 只有邮件，没有卡片选项
      if (!user.email_remind) continue;
      const r = await sendMail({
        user, to: user.email, kind: 'R1',
        subject: '【山海问知】今天还没打卡',
        text: `${user.name}，${hit.message}\n\n山海问知 · 你的考研搭子`,
      });
      emailed = r.sent;
      mailNote = r.info;
    } else if (user.email_remind) {
      const r = await sendMail({
        user, to: user.email, kind: hit.rule,
        subject: `【山海问知】${RULE_TITLES[hit.rule]}`,
        text: `${user.name}，${hit.message}\n\n打开平台看看可以怎么处理：${process.env.SITE_URL || 'http://localhost:3000'}\n\n山海问知 · 你的考研搭子`,
      });
      emailed = r.sent;
      mailNote = r.info;
    } else {
      mailNote = '学生关闭了邮件提醒';
    }
    const row = createIntervention(user.id, hit.rule, hit.message, { emailed });
    if (hit.ref) db.prepare('UPDATE interventions SET note = ? WHERE id = ?').run(`ref:${hit.ref}`, row.id);
    created.push({ rule: hit.rule, id: row.id, emailOnly: !!hit.emailOnly, emailed, mailNote });
  }
  return created;
}

/** 全体学生巡检（教师后台“立即执行巡检”与定时任务共用） */
export async function runChecksForAll({ now = new Date(), force = false } = {}) {
  const students = db.prepare("SELECT * FROM users WHERE role = 'student' AND is_demo = 0").all();
  const out = [];
  for (const s of students) {
    const created = await runChecksFor(s, { now, force });
    if (created.length) out.push({ user_id: s.id, name: s.name, student_no: s.student_no, created });
  }
  return { students: students.length, triggered: out };
}

// ---------- 学生的干预列表与选择 ----------

export function publicIntervention(row) {
  return {
    id: row.id, rule: row.rule, title: row.title, message: row.message,
    options: row.options_json ? JSON.parse(row.options_json) : [],
    chosen: row.chosen,
    note: row.note && !String(row.note).startsWith('ref:') ? row.note : '',
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

export function pendingInterventions(userId) {
  return db.prepare("SELECT * FROM interventions WHERE user_id = ? AND chosen IS NULL AND resolved_at IS NULL ORDER BY id DESC").all(userId)
    .map(publicIntervention);
}

/** 学生做出选择：写入档案与搭子上下文，按选项生效 */
export function chooseIntervention(user, id, choiceKey, note = '') {
  const row = db.prepare('SELECT * FROM interventions WHERE id = ? AND user_id = ?').get(Number(id), user.id);
  if (!row) throw new Error('NOT_FOUND');
  const options = row.options_json ? JSON.parse(row.options_json) : [];
  const opt = options.find((o) => o.key === choiceKey);
  if (!opt) throw new Error('BAD_OPTION');
  const text = String(note || '').trim();
  if (opt.requireNote && text.length < 5) throw new Error('NEED_NOTE');

  db.prepare('UPDATE interventions SET chosen = ?, note = ?, resolved_at = ? WHERE id = ?')
    .run(choiceKey, text, nowLocal(), row.id);

  // 减量标记：下次生成方案时任务减少约30%
  if (opt.effect === 'reduce') {
    const plan = db.prepare('SELECT id FROM plans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(user.id);
    if (plan) db.prepare('UPDATE plans SET reduce_flag = 1 WHERE id = ?').run(plan.id);
    else db.prepare("INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
      .run(`plan.reduce_pending.${user.id}`, '1', nowLocal());
  }

  return { intervention: publicIntervention(db.prepare('SELECT * FROM interventions WHERE id = ?').get(row.id)), effect: opt.effect, route: opt.route || null };
}

/** 干预响应率：被选择的 ÷ 触发的（成效看板用） */
export function interventionStats({ from, to } = {}) {
  const where = [];
  const args = [];
  if (from) { where.push('substr(created_at, 1, 10) >= ?'); args.push(from); }
  if (to) { where.push('substr(created_at, 1, 10) <= ?'); args.push(to); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM interventions ${w}`).get(...args).n;
  const chosen = db.prepare(`SELECT COUNT(*) AS n FROM interventions ${w}${w ? ' AND' : 'WHERE'} chosen IS NOT NULL`).get(...args).n;
  const byRule = db.prepare(`SELECT rule, COUNT(*) AS n, SUM(CASE WHEN chosen IS NOT NULL THEN 1 ELSE 0 END) AS chosen FROM interventions ${w} GROUP BY rule ORDER BY rule`).all(...args);
  return { total, chosen, rate: total ? chosen / total : 0, byRule };
}
