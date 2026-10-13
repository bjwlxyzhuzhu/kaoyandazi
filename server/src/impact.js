// M17 成效数据看板（只统计真实班级，排除演示账号与评委沙箱）
// 每个指标都带“计算口径”，并能下钻到原始记录（PRD M17 验收：每个数字都能下钻）。
import fs from 'node:fs';
import path from 'node:path';
import { SHARED_DIR } from './config.js';
import { db } from './db.js';
import { todayLocal, addDays } from './time.js';
import { stations } from './stations.js';
import { classroomTasks } from './assess.js';

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const surveys = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'surveys.json'), 'utf8'));

/** 统计口径里的“真实学生”：学生角色、非演示、所在班级不是沙箱 */
export const REAL_SQL = `role = 'student' AND is_demo = 0 AND class_id IN (SELECT id FROM classes WHERE is_sandbox = 0)`;
export function realStudents() {
  return db.prepare(`SELECT id, student_no, name, key_enc, last_seen, created_at FROM users WHERE ${REAL_SQL} ORDER BY student_no`).all();
}
function inIds(ids) { return ids.length ? ids.map(() => '?').join(',') : 'NULL'; }

function streakOf(dates) {
  const set = new Set(dates);
  let d = todayLocal();
  if (!set.has(d)) d = addDays(d, -1);
  let n = 0;
  while (set.has(d)) { n += 1; d = addDays(d, -1); }
  return n;
}

/** 7日完成率：某天起往前7天，已勾选任务 / 全部任务 */
function rate7(ids, endDate) {
  if (!ids.length) return null;
  const row = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM tasks WHERE user_id IN (${inIds(ids)}) AND date > ? AND date <= ?`).get(...ids, addDays(endDate, -7), endDate);
  return row.total ? pct(row.done, row.total) : null;
}

export function computeImpact() {
  const students = realStudents();
  const ids = students.map((s) => s.id);
  const N = ids.length;
  const ph = inIds(ids);
  const today = todayLocal();
  const weekAgo = addDays(today, -6);
  const metrics = [];
  const add = (group, id, label, value, formula, unit = '') => metrics.push({ group, id, label, value, unit, formula });

  // 规模
  const ownKey = new Set(db.prepare(`SELECT DISTINCT user_id FROM ai_calls WHERE key_source = 'user' AND user_id IN (${ph})`).all(...ids).map((r) => r.user_id));
  const bound = students.filter((s) => s.key_enc || ownKey.has(s.id)).length;
  const active = students.filter((s) => s.last_seen && s.last_seen.slice(0, 10) >= weekAgo).length;
  const dayRows = db.prepare(`SELECT user_id, COUNT(DISTINCT d) AS days FROM (
      SELECT user_id, substr(created_at, 1, 10) AS d FROM ai_calls WHERE user_id IN (${ph})
      UNION SELECT user_id, date AS d FROM checkins WHERE user_id IN (${ph})
    ) GROUP BY user_id`).all(...ids, ...ids);
  const totalDays = dayRows.reduce((s, r) => s + r.days, 0);
  add('规模', 'registered', '注册人数', N, '真实班级里的学生账号数（不含演示账号、评委沙箱）', '人');
  add('规模', 'key_bound', 'Key 绑定率', pct(bound, N), '在服务器保存过自己的 Key，或至少用自己的 Key 成功调用过一次的人数 ÷ 注册人数', '%');
  add('规模', 'weekly_active', '周活跃人数', active, '最近7天内登录过的人数', '人');
  add('规模', 'days_per_user', '人均使用天数', N ? Math.round((totalDays / N) * 10) / 10 : null, '每人有 AI 调用或打卡记录的不同日期数，取平均', '天');

  // 流程漏斗
  const funnel = stations.map((st) => {
    const done = db.prepare(`SELECT COUNT(*) AS n FROM flow_status WHERE station = ? AND status = 'done' AND user_id IN (${ph})`).get(st.no, ...ids).n;
    return { station: st.no, name: st.name, done, rate: pct(done, N) };
  });
  for (const f of funnel) add('流程', `station_${f.station}`, `第${f.station}站 ${f.name} 完成率`, f.rate, `该站状态为“已完成”的人数 ÷ 注册人数（完成 ${f.done} 人）`, '%');

  // 执行
  const checkedToday = db.prepare(`SELECT COUNT(*) AS n FROM checkins WHERE date = ? AND user_id IN (${ph})`).get(today, ...ids).n;
  add('执行', 'checkin_today', '今日打卡率', pct(checkedToday, N), '今天打卡的人数 ÷ 注册人数', '%');
  add('执行', 'rate7', '7日完成率', rate7(ids, today), '最近7天全班已勾选任务数 ÷ 全部任务数', '%');
  const trend = [];
  for (let i = 13; i >= 0; i -= 1) { const d = addDays(today, -i); trend.push({ date: d, rate: rate7(ids, d) }); }
  const streaks = { '0天': 0, '1—2天': 0, '3—6天': 0, '7—13天': 0, '14天以上': 0 };
  for (const s of students) {
    const n = streakOf(db.prepare('SELECT date FROM checkins WHERE user_id = ?').all(s.id).map((r) => r.date));
    const k = n === 0 ? '0天' : n <= 2 ? '1—2天' : n <= 6 ? '3—6天' : n <= 13 ? '7—13天' : '14天以上';
    streaks[k] += 1;
  }

  // 干预
  const ivRows = db.prepare(`SELECT rule, COUNT(*) AS triggered, SUM(CASE WHEN chosen IS NOT NULL THEN 1 ELSE 0 END) AS chosen FROM interventions WHERE user_id IN (${ph}) GROUP BY rule ORDER BY rule`).all(...ids);
  const ivTotal = ivRows.reduce((s, r) => s + r.triggered, 0);
  const ivChosen = ivRows.reduce((s, r) => s + r.chosen, 0);
  add('干预', 'interventions', '干预触发次数', ivTotal, '规则 R1—R8 生成的提醒卡片总数', '次');
  add('干预', 'intervention_response', '干预响应率', pct(ivChosen, ivTotal), '学生选择了某个选项的卡片数 ÷ 触发的卡片数', '%');
  // 响应后7天完成率变化：每张已选择的卡片，比较选择前7天与之后7天本人的完成率
  const deltas = [];
  for (const iv of db.prepare(`SELECT user_id, substr(resolved_at, 1, 10) AS d FROM interventions WHERE chosen IS NOT NULL AND resolved_at IS NOT NULL AND user_id IN (${ph})`).all(...ids)) {
    const before = rate7([iv.user_id], addDays(iv.d, -1));
    const after = rate7([iv.user_id], addDays(iv.d, 7));
    if (before !== null && after !== null && addDays(iv.d, 7) <= today) deltas.push(after - before);
  }
  add('干预', 'intervention_effect', '响应后7天完成率变化', deltas.length ? Math.round((deltas.reduce((a, b) => a + b, 0) / deltas.length) * 10) / 10 : null, `已选择、且已过7天的卡片：之后7天完成率 − 之前7天完成率，取平均（样本 ${deltas.length} 张）`, '百分点');

  // 学习产物
  const facts = db.prepare(`SELECT facts_json FROM schools WHERE user_id IN (${ph})`).all(...ids).flatMap((r) => parse(r.facts_json, []));
  add('学习产物', 'schools_verify', '院校表核验比例', pct(facts.filter((f) => f.verified).length, facts.length), `已核验的院校数据条数 ÷ 全部数据条数（共 ${facts.length} 条）`, '%');
  add('学习产物', 'kb_items', '知识库条目', db.prepare(`SELECT COUNT(*) AS n FROM kb_items WHERE user_id IN (${ph})`).get(...ids).n, '备考与科研空间的条目总数（不含文献）', '条');
  add('学习产物', 'papers', '文献（已核验）', db.prepare(`SELECT COUNT(*) AS n FROM papers WHERE verify_status = 'verified' AND user_id IN (${ph})`).get(...ids).n, 'DOI 核验通过的文献数', '篇');
  add('学习产物', 'cards', '阅读卡', db.prepare(`SELECT COUNT(*) AS n FROM reading_cards WHERE user_id IN (${ph})`).get(...ids).n, '阅读卡总数', '张');
  add('学习产物', 'ideas', '选题卡', db.prepare(`SELECT COUNT(*) AS n FROM topic_ideas WHERE status != 'dropped' AND user_id IN (${ph})`).get(...ids).n, '未放弃的选题卡总数', '张');

  // 课堂
  const tasks = classroomTasks();
  const subs = db.prepare(`SELECT COUNT(*) AS n FROM submissions WHERE user_id IN (${ph})`).get(...ids).n;
  add('课堂', 'submissions', '课堂任务提交率', pct(subs, tasks.length * N), `已提交份数 ÷（已解锁任务 ${tasks.length} 个 × 注册人数）`, '%');
  const peer = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN rubric_json IS NOT NULL THEN 1 ELSE 0 END) AS done FROM peer_reviews WHERE reviewer_id IN (${ph})`).get(...ids);
  add('课堂', 'peer', '互评完成率', pct(peer.done || 0, peer.total), '已完成的互评 ÷ 分配的互评任务', '%');

  // 问卷：前测 / 中测 / 后测（每人取最近一次），满意度
  const latest = (kind) => db.prepare(`SELECT s.user_id, s.answers_json FROM surveys s WHERE s.kind = ? AND s.user_id IN (${ph})
    AND s.id = (SELECT MAX(id) FROM surveys WHERE user_id = s.user_id AND kind = ?)`).all(kind, ...ids, kind).map((r) => ({ user_id: r.user_id, a: parse(r.answers_json, {}) }));
  const sv = { pre: latest('pre'), mid: latest('mid'), post: latest('post') };
  const avg = (rows, key) => { const v = rows.map((r) => Number(r.a[key])).filter(Number.isFinite); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null; };
  const surveyTable = surveys.ability.map((label, i) => ({ key: `ability_${i + 1}`, label, pre: avg(sv.pre, `ability_${i + 1}`), mid: avg(sv.mid, `ability_${i + 1}`), post: avg(sv.post, `ability_${i + 1}`) }));
  add('问卷', 'survey_counts', '问卷填写人数（前/中/后）', `${sv.pre.length} / ${sv.mid.length} / ${sv.post.length}`, '每份问卷每人只计最近一次', '人');
  const sat = latest('satisfaction');
  add('问卷', 'satisfaction', '总体满意度', avg(sat, 'overall'), `满意度问卷“总体满意度”（1—5）平均，${sat.length} 人填写`, '分');
  const rec = sat.map((r) => Number(r.a.recommend)).filter(Number.isFinite);
  add('问卷', 'nps', '推荐度（NPS）', rec.length ? Math.round(((rec.filter((x) => x >= 9).length - rec.filter((x) => x <= 6).length) / rec.length) * 100) : null, '推荐者（9—10分）占比 − 贬损者（0—6分）占比', '');

  // AI 使用
  const calls = db.prepare(`SELECT kind, COUNT(*) AS n FROM ai_calls WHERE ok = 1 AND user_id IN (${ph}) GROUP BY kind ORDER BY n DESC`).all(...ids);
  const totalCalls = calls.reduce((s, r) => s + r.n, 0);
  add('AI使用', 'ai_calls', 'AI 调用次数', totalCalls, '成功的模型调用（被边界拦下、未调用模型的不计）', '次');
  const act = Object.fromEntries(db.prepare(`SELECT action, COUNT(*) AS n FROM ai_actions WHERE user_id IN (${ph}) GROUP BY action`).all(...ids).map((r) => [r.action, r.n]));
  add('AI使用', 'ai_modify', 'AI 产物修改率', pct(act.modify || 0, (act.confirm || 0) + (act.modify || 0)), '修改后采用 ÷（直接采用 + 修改后采用），来自画像、方案等确认时的比对', '%');
  add('AI使用', 'ai_verify', '核验动作次数', act.verify || 0, '学生点“核验”（院校数据、文献 DOI）的次数', '次');

  return {
    generated_at: new Date().toISOString(),
    scope: `真实班级学生 ${N} 人；演示账号与评委沙箱不计入任何统计。`,
    metrics,
    funnel,
    trend,
    streaks: Object.entries(streaks).map(([k, v]) => ({ bucket: k, count: v })),
    interventions: ivRows.map((r) => ({ rule: r.rule, triggered: r.triggered, chosen: r.chosen, rate: pct(r.chosen, r.triggered) })),
    surveys: surveyTable,
    ai_usage: calls,
  };
}

// ---------- 下钻：每个指标对应的原始记录 ----------

export function drill(metric) {
  const students = realStudents();
  const ids = students.map((s) => s.id);
  const ph = inIds(ids);
  const who = new Map(students.map((s) => [s.id, `${s.student_no} ${s.name}`]));
  const W = (rows) => rows.map((r) => ({ 学生: who.get(r.user_id) || '', ...Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'user_id')) }));
  const today = todayLocal();
  const m = String(metric);
  if (m === 'registered') return students.map((s) => ({ 学生: who.get(s.id), 注册时间: s.created_at, 最近登录: s.last_seen }));
  if (m === 'key_bound') {
    const own = new Set(db.prepare(`SELECT DISTINCT user_id FROM ai_calls WHERE key_source = 'user' AND user_id IN (${ph})`).all(...ids).map((r) => r.user_id));
    return students.map((s) => ({ 学生: who.get(s.id), 服务器保存了Key: s.key_enc ? '是' : '否', 用过自己的Key: own.has(s.id) ? '是' : '否' }));
  }
  if (m === 'weekly_active') return students.filter((s) => s.last_seen && s.last_seen.slice(0, 10) >= addDays(today, -6)).map((s) => ({ 学生: who.get(s.id), 最近登录: s.last_seen }));
  if (m === 'days_per_user') return W(db.prepare(`SELECT user_id, COUNT(DISTINCT d) AS 使用天数 FROM (SELECT user_id, substr(created_at,1,10) AS d FROM ai_calls WHERE user_id IN (${ph}) UNION SELECT user_id, date FROM checkins WHERE user_id IN (${ph})) GROUP BY user_id`).all(...ids, ...ids));
  if (m.startsWith('station_')) return W(db.prepare(`SELECT user_id, status AS 状态, updated_at AS 更新时间 FROM flow_status WHERE station = ? AND user_id IN (${ph}) ORDER BY user_id`).all(Number(m.slice(8)), ...ids));
  if (m === 'checkin_today') return W(db.prepare(`SELECT user_id, date AS 日期, done_count AS 完成, total_count AS 任务, minutes AS 分钟 FROM checkins WHERE date = ? AND user_id IN (${ph})`).all(today, ...ids));
  if (m === 'rate7') return W(db.prepare(`SELECT user_id, date AS 日期, title AS 任务, done AS 已完成 FROM tasks WHERE date > ? AND date <= ? AND user_id IN (${ph}) ORDER BY date`).all(addDays(today, -7), today, ...ids));
  if (m === 'interventions' || m === 'intervention_response' || m === 'intervention_effect') return W(db.prepare(`SELECT user_id, rule AS 规则, title AS 标题, chosen AS 选择, created_at AS 触发时间, resolved_at AS 处理时间 FROM interventions WHERE user_id IN (${ph}) ORDER BY id`).all(...ids));
  if (m === 'schools_verify') return W(db.prepare(`SELECT user_id, school AS 院校, tier AS 层次, facts_json FROM schools WHERE user_id IN (${ph})`).all(...ids)).map((r) => { const f = parse(r.facts_json, []); delete r.facts_json; return { ...r, 数据条数: f.length, 已核验: f.filter((x) => x.verified).length }; });
  if (m === 'kb_items') return W(db.prepare(`SELECT user_id, space AS 空间, type AS 类型, title AS 标题, created_at AS 时间 FROM kb_items WHERE user_id IN (${ph})`).all(...ids));
  if (m === 'papers') return W(db.prepare(`SELECT user_id, title AS 题名, doi AS DOI, verify_status AS 核验 FROM papers WHERE verify_status = 'verified' AND user_id IN (${ph})`).all(...ids));
  if (m === 'cards') return W(db.prepare(`SELECT user_id, question AS 研究问题, created_at AS 时间 FROM reading_cards WHERE user_id IN (${ph})`).all(...ids));
  if (m === 'ideas') return W(db.prepare(`SELECT user_id, question AS 研究问题, status AS 状态 FROM topic_ideas WHERE status != 'dropped' AND user_id IN (${ph})`).all(...ids));
  if (m === 'submissions') return W(db.prepare(`SELECT user_id, chapter AS 章, task_id AS 任务, score AS 分数, created_at AS 时间 FROM submissions WHERE user_id IN (${ph})`).all(...ids));
  if (m === 'peer') return db.prepare(`SELECT reviewer_id AS user_id, CASE WHEN rubric_json IS NULL THEN '未完成' ELSE '已完成' END AS 状态, created_at AS 分配时间 FROM peer_reviews WHERE reviewer_id IN (${ph})`).all(...ids).map((r) => ({ 评价者: who.get(r.user_id), 状态: r.状态, 分配时间: r.分配时间 }));
  if (m === 'survey_counts' || m === 'satisfaction' || m === 'nps') return W(db.prepare(`SELECT user_id, kind AS 问卷, created_at AS 时间 FROM surveys WHERE user_id IN (${ph}) ORDER BY id`).all(...ids)).map((r) => ({ ...r, 学生: '（匿名）' }));
  if (m === 'ai_calls') return W(db.prepare(`SELECT user_id, kind AS 模块, purpose AS 用途, key_source AS Key来源, prompt_tokens + completion_tokens AS token, created_at AS 时间 FROM ai_calls WHERE ok = 1 AND user_id IN (${ph}) ORDER BY id DESC LIMIT 2000`).all(...ids));
  if (m === 'ai_modify' || m === 'ai_verify') return W(db.prepare(`SELECT user_id, object_type AS 对象, action AS 动作, created_at AS 时间 FROM ai_actions WHERE user_id IN (${ph}) ORDER BY id`).all(...ids));
  return null;
}
