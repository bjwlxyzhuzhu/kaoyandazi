// 教师后台（M16）与赛事支持（M17）
// M16：GET /teacher/overview  GET /teacher/students  GET /teacher/students/:id  POST /teacher/broadcast  POST /teacher/reset-password
//      GET/PUT /teacher/verified-materials  GET/PUT /teacher/org  POST /teacher/test-search
// M17：GET/POST/DELETE /teacher/demo-accounts  GET/PUT /teacher/anonymous-mode
//      GET /teacher/impact  GET /teacher/impact/drill/:metric  GET /teacher/impact/export  GET /teacher/runlog
// 学生：GET /notices
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, getSetting, setSetting, getSettingJson } from '../db.js';
import { nowLocal, todayLocal, addDays } from '../time.js';
import { AppError } from '../errors.js';
import { requireTeacher, requireLogin } from '../auth.js';
import { hashPassword } from '../crypto.js';
import { verifiedMaterials } from '../prompts.js';
import { sendMail } from '../mail.js';
import { webSearch, searchEnabled } from '../search/tools.js';
import { stations, allFlowStatus, currentStation } from '../stations.js';
import { portfolioOf, ITEMS } from '../assess.js';
import { computeImpact, drill, realStudents, REAL_SQL } from '../impact.js';
import { makeXlsx } from '../xlsx.js';
import { anonEnabled, anonText, orgInfo, resetAnonCache } from '../anon.js';
import { classroomStats } from '../assess.js';

const r = Router();
const T = requireTeacher;
const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---------- 运行日志（技术实现维度的证据：每日请求成功率、错误统计） ----------

const runlog = new Map();
let lastFlush = 0;
function flushRunlog(force = false) {
  if (!force && Date.now() - lastFlush < 30000) return;
  lastFlush = Date.now();
  const saved = getSettingJson('runlog', {});
  for (const [d, v] of runlog) {
    const s = saved[d] || { total: 0, ok: 0, client_errors: 0, server_errors: 0 };
    saved[d] = { total: s.total + v.total, ok: s.ok + v.ok, client_errors: s.client_errors + v.client_errors, server_errors: s.server_errors + v.server_errors };
  }
  runlog.clear();
  const keep = Object.keys(saved).sort().slice(-60);
  setSetting('runlog', JSON.stringify(Object.fromEntries(keep.map((k) => [k, saved[k]]))));
}
export function runlogMiddleware(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  res.on('finish', () => {
    const d = todayLocal();
    const v = runlog.get(d) || { total: 0, ok: 0, client_errors: 0, server_errors: 0 };
    v.total += 1;
    if (res.statusCode >= 500) v.server_errors += 1;
    else if (res.statusCode >= 400) v.client_errors += 1;
    else v.ok += 1;
    runlog.set(d, v);
    flushRunlog();
  });
  next();
}

r.get('/teacher/runlog', T, (_req, res) => {
  flushRunlog(true);
  const saved = getSettingJson('runlog', {});
  res.json({
    days: Object.entries(saved).sort().map(([date, v]) => ({ date, ...v, success_rate: v.total ? Math.round(((v.total - v.server_errors) / v.total) * 10000) / 100 : null })),
    note: '成功率 =（请求总数 − 服务器错误数）÷ 请求总数。学生输错密码、额度用完这类 4xx 属于正常拒绝，单独统计，不算故障。',
  });
});

// ---------- M16 全班概览与学生 ----------

r.get('/teacher/overview', T, (_req, res) => {
  const imp = computeImpact();
  const m = Object.fromEntries(imp.metrics.map((x) => [x.id, x]));
  const students = realStudents();
  const paths = {};
  for (const p of db.prepare(`SELECT chosen_path FROM profiles WHERE user_id IN (SELECT id FROM users WHERE ${REAL_SQL})`).all()) paths[p.chosen_path || '未选'] = (paths[p.chosen_path || '未选'] || 0) + 1;
  let portfolioDone = 0;
  for (const s of students) portfolioDone += portfolioOf(s.id).items.filter((i) => i.status === 'done').length;
  res.json({
    scope: imp.scope,
    cards: ['registered', 'key_bound', 'weekly_active', 'checkin_today', 'rate7', 'interventions', 'intervention_response', 'kb_items', 'cards'].map((k) => m[k]),
    funnel: imp.funnel,
    paths: Object.entries(paths).map(([k, v]) => ({ path: k, count: v })),
    portfolio_rate: students.length ? Math.round((portfolioDone / (students.length * ITEMS.length)) * 100) : null,
    note: '这里只统计真实班级；看不到任何学生的私聊、会议原文、长期记忆内容和数字分身。',
  });
});

r.get('/teacher/students', T, (_req, res) => {
  const rows = realStudents().map((s) => {
    const pf = portfolioOf(s.id);
    const lastCheck = db.prepare('SELECT MAX(date) AS d FROM checkins WHERE user_id = ?').get(s.id).d;
    const pending = db.prepare('SELECT COUNT(*) AS n FROM interventions WHERE user_id = ? AND chosen IS NULL AND resolved_at IS NULL').get(s.id).n;
    const path = db.prepare('SELECT chosen_path FROM profiles WHERE user_id = ?').get(s.id)?.chosen_path || '';
    return { id: s.id, student_no: s.student_no, name: s.name, station: currentStation(s.id), path, last_checkin: lastCheck, last_seen: s.last_seen, pending_interventions: pending, portfolio_missing: pf.missing_count };
  });
  res.json({ students: rows });
});

/**
 * 学生详情：画像、路径、方案、打卡、院校表、成果、知识库概况、选题卡、课堂任务、干预与选择、邮件记录、考核档案袋。
 * 隐私边界（PRD M16 / 16.2 第7条）：看不到 1:1 私聊、会议原文、长期记忆内容、数字分身与上传文件。
 */
r.get('/teacher/students/:id', T, (req, res) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'student'").get(Number(req.params.id));
  if (!u) throw new AppError(404, 'NOT_FOUND', '没有这名学生。');
  const prof = db.prepare('SELECT profile_json, chosen_path, choice_reason, updated_at FROM profiles WHERE user_id = ?').get(u.id);
  const p = parse(prof?.profile_json, null);
  const plan = db.prepare('SELECT plan_json, created_at, reduce_flag FROM plans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(u.id);
  const pj = parse(plan?.plan_json, null);
  res.json({
    student: { id: u.id, student_no: u.student_no, name: u.name, major: u.major, grade: u.grade, major_group: u.major_group, email: u.email, created_at: u.created_at, last_seen: u.last_seen },
    flow: allFlowStatus(u.id),
    profile: p ? { summary: p.summary, strengths: p.strengths, gaps: p.gaps, weekly_hours: p.weekly_hours, updated_at: prof.updated_at } : null,
    path: prof?.chosen_path ? { id: prof.chosen_path, reason: prof.choice_reason } : null,
    plan: pj ? { goal: pj.goal, phases: pj.phases, adopted_at: plan.created_at, reduced: !!plan.reduce_flag, versions: db.prepare('SELECT COUNT(*) AS n FROM plans WHERE user_id = ?').get(u.id).n } : null,
    checkins: db.prepare('SELECT date, minutes, done_count, total_count, mood, reflection FROM checkins WHERE user_id = ? ORDER BY date DESC LIMIT 30').all(u.id),
    weekly_reviews: db.prepare('SELECT week_start, rate, summary FROM weekly_reviews WHERE user_id = ? ORDER BY id DESC LIMIT 8').all(u.id),
    schools: db.prepare('SELECT school, major, tier, facts_json, basis, uncertainty FROM schools WHERE user_id = ?').all(u.id).map((s) => { const f = parse(s.facts_json, []); return { school: s.school, major: s.major, tier: s.tier, facts: f.length, verified: f.filter((x) => x.verified).length, basis: s.basis, uncertainty: s.uncertainty }; }),
    achievements: db.prepare('SELECT type, name, stage, deadline FROM achievements WHERE user_id = ?').all(u.id),
    kb: {
      items: db.prepare('SELECT COUNT(*) AS n FROM kb_items WHERE user_id = ?').get(u.id).n,
      papers: db.prepare('SELECT COUNT(*) AS n FROM papers WHERE user_id = ?').get(u.id).n,
      cards: db.prepare('SELECT COUNT(*) AS n FROM reading_cards WHERE user_id = ?').get(u.id).n,
    },
    ideas: db.prepare("SELECT question, status FROM topic_ideas WHERE user_id = ? ORDER BY id DESC").all(u.id),
    classroom: classroomStats(u.id),
    interventions: db.prepare('SELECT rule, title, chosen, note, created_at, resolved_at FROM interventions WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(u.id),
    mail_log: db.prepare('SELECT kind, ok, info, created_at FROM mail_log WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(u.id),
    portfolio: portfolioOf(u.id),
    memory_count: db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').get(u.id).n,
    privacy: '看不到 1:1 私聊原文、导师团会议原文、长期记忆内容、数字分身档案与上传文件。这些只有学生本人可见。',
  });
});

r.post('/teacher/reset-password', T, (req, res) => {
  const no = String(req.body?.student_no || '').trim();
  const u = db.prepare("SELECT id, name FROM users WHERE student_no = ? AND role = 'student'").get(no);
  if (!u) throw new AppError(404, 'NOT_FOUND', '没有这个学号。');
  const temp = `sh-${crypto.randomBytes(4).toString('hex')}`;
  db.prepare('UPDATE users SET pw_hash = ? WHERE id = ?').run(hashPassword(temp), u.id);
  res.json({ student_no: no, name: u.name, temp_password: temp, note: '临时密码只显示这一次，请当面或私信告诉学生，并提醒尽快修改。' });
});

// ---------- 群发通知 ----------

r.post('/teacher/broadcast', T, async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 60);
  const text = String(req.body?.text || '').trim().slice(0, 1000);
  if (!title || !text) throw new AppError(400, 'EMPTY', '请填写标题和内容。');
  const list = getSettingJson('notices', []);
  list.unshift({ id: Date.now(), title, text, at: nowLocal() });
  setSetting('notices', JSON.stringify(list.slice(0, 20)));
  let mailed = 0;
  if (req.body?.email === true) {
    for (const s of db.prepare(`SELECT * FROM users WHERE ${REAL_SQL} AND email IS NOT NULL AND email_remind = 1`).all()) {
      const r0 = await sendMail({ user: s, to: s.email, subject: `【山海问知】${title}`, text: `${s.name}同学：\n\n${text}\n\n——山海问知`, kind: 'broadcast', force: true });
      if (r0.sent) mailed += 1;
    }
  }
  res.json({ ok: true, mailed, note: req.body?.email ? `站内通知已发布；邮件发送成功 ${mailed} 封（未配置 SMTP 时为 0，详见邮件记录）。` : '站内通知已发布。' });
});

r.get('/notices', requireLogin, (_req, res) => {
  res.json({ notices: getSettingJson('notices', []).slice(0, 5) });
});

// ---------- 已核实资料、机构信息、检索测试 ----------

r.get('/teacher/verified-materials', T, (_req, res) => res.json({ text: verifiedMaterials(), custom: !!getSetting('verified_materials') }));
r.put('/teacher/verified-materials', T, (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 20000);
  setSetting('verified_materials', text);
  res.json({ text: verifiedMaterials(), custom: !!text });
});

r.get('/teacher/org', T, (_req, res) => res.json({ org: orgInfo() }));
r.put('/teacher/org', T, (req, res) => {
  const b = req.body || {};
  const cur = orgInfo();
  const next = {};
  for (const k of ['school_name', 'college_name', 'teacher_names', 'extra_terms']) next[k] = String(b[k] ?? cur[k] ?? '').trim().slice(0, 300);
  setSetting('org', JSON.stringify(next));
  resetAnonCache();
  res.json({ org: next });
});

r.post('/teacher/test-search', T, async (req, res) => {
  if (!searchEnabled()) return res.json({ ok: false, message: '没有配置检索服务（SEARCH_PROVIDER），择校工作台会降级为“学生贴官网链接 + 手动核验”。' });
  try {
    const out = await webSearch(String(req.body?.query || '研究生招生 复试分数线'), { count: 3 });
    res.json({ ok: true, results: (out.results || out).slice?.(0, 3) || out });
  } catch (e) {
    res.json({ ok: false, message: e instanceof AppError ? e.message : '检索失败。' });
  }
});

// ---------- M17 评委测试账号（沙箱班级、演示标记、有效期、调用上限） ----------

function sandboxClass() { return db.prepare('SELECT * FROM classes WHERE is_sandbox = 1 ORDER BY id LIMIT 1').get(); }

r.get('/teacher/demo-accounts', T, (_req, res) => {
  const cls = sandboxClass();
  res.json({
    sandbox: cls ? { name: cls.name } : null,
    daily_limit: Number(getSetting('demo.daily_limit') || 40),
    demo_key_configured: !!process.env.DEMO_API_KEY,
    accounts: db.prepare('SELECT id, student_no, name, expires_at, demo_note, last_seen, created_at FROM users WHERE is_demo = 1 ORDER BY id DESC').all()
      .map((u) => ({ ...u, expired: !!(u.expires_at && u.expires_at < nowLocal()) })),
    note: '评委账号放在沙箱班级、标记为“演示”，任何统计都不包含。基础模块用平台 Key，高阶模块用管理员配置的演示 Key（DEMO_API_KEY），两者都受每日调用上限约束。',
  });
});

r.post('/teacher/demo-accounts', T, (req, res) => {
  const count = Math.max(1, Math.min(10, Number(req.body?.count) || 1));
  const days = Math.max(1, Math.min(60, Number(req.body?.days) || 14));
  const note = String(req.body?.note || '').slice(0, 60);
  if (req.body?.daily_limit !== undefined) setSetting('demo.daily_limit', String(Math.max(1, Math.min(500, Number(req.body.daily_limit) || 40))));
  const cls = sandboxClass();
  const expires = `${addDays(todayLocal(), days)} 23:59:59`;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const no = `judge-${crypto.randomBytes(3).toString('hex')}`;
    const pw = `demo-${crypto.randomBytes(4).toString('hex')}`;
    db.prepare(`INSERT INTO users(role, student_no, name, email, major, major_group, grade, pw_hash, is_demo, created_at, class_id, expires_at, demo_note)
      VALUES('student', ?, ?, ?, '演示专业', '教育', '大三', ?, 1, ?, ?, ?, ?)`).run(no, `评委${no.slice(-4)}（演示）`, `${no}@demo.invalid`, hashPassword(pw), nowLocal(), cls.id, expires, note);
    out.push({ student_no: no, password: pw, expires_at: expires });
  }
  resetAnonCache();
  res.json({ accounts: out, note: '密码只显示这一次。评委用学号和密码登录即可。' });
});

r.delete('/teacher/demo-accounts/:id', T, async (req, res) => {
  const u = db.prepare('SELECT id FROM users WHERE id = ? AND is_demo = 1').get(Number(req.params.id));
  if (!u) throw new AppError(404, 'NOT_FOUND', '没有这个评委账号。');
  const { purgeUsers } = await import('../userdata.js');
  res.json({ deleted: purgeUsers([u.id]) });
});

// ---------- M17 匿名演示模式 ----------

r.get('/teacher/anonymous-mode', T, (_req, res) => res.json({ enabled: anonEnabled(), org: orgInfo() }));
r.put('/teacher/anonymous-mode', T, (req, res) => {
  setSetting('anon.enabled', req.body?.enabled ? '1' : '0');
  resetAnonCache();
  res.json({ enabled: anonEnabled(), note: req.body?.enabled ? '匿名模式已开启：学校名、学院名、教师与学生姓名在界面、导出文件和邮件里都会替换成中性占位。' : '匿名模式已关闭。' });
});

// ---------- M17 成效看板 ----------

r.get('/teacher/impact', T, (_req, res) => res.json(computeImpact()));

r.get('/teacher/impact/drill/:metric', T, (req, res) => {
  const rows = drill(req.params.metric);
  if (!rows) throw new AppError(404, 'NO_METRIC', '没有这个指标。');
  res.json({ metric: req.params.metric, count: rows.length, rows: rows.slice(0, 2000) });
});

r.get('/teacher/impact/export', T, (_req, res) => {
  const imp = computeImpact();
  const A = (v) => (typeof v === 'string' ? anonText(v) : v);
  const sheets = [
    { name: '指标与口径', rows: [['分组', '指标', '数值', '单位', '计算口径', '下钻接口'], ...imp.metrics.map((m) => [m.group, m.label, m.value ?? '暂无数据', m.unit, m.formula, `/api/teacher/impact/drill/${m.id}`])] },
    { name: '流程漏斗', rows: [['站', '名称', '完成人数', '完成率%'], ...imp.funnel.map((f) => [f.station, f.name, f.done, f.rate ?? ''])] },
    { name: '7日完成率趋势', rows: [['日期', '7日完成率%'], ...imp.trend.map((t) => [t.date, t.rate ?? ''])] },
    { name: '连续打卡分布', rows: [['连续天数', '人数'], ...imp.streaks.map((s) => [s.bucket, s.count])] },
    { name: '干预', rows: [['规则', '触发', '被选择', '响应率%'], ...imp.interventions.map((i) => [i.rule, i.triggered, i.chosen, i.rate ?? ''])] },
    { name: '前中后测', rows: [['能力自评（1—5）', '前测', '中测', '后测'], ...imp.surveys.map((s) => [s.label, s.pre ?? '', s.mid ?? '', s.post ?? ''])] },
    { name: 'AI用途', rows: [['模块', '调用次数'], ...imp.ai_usage.map((a) => [a.kind, a.n])] },
    { name: '说明', rows: [['说明'], [imp.scope], [`导出时间：${nowLocal()}`], ['所有数字都来自平台的原始记录，没有任何估算或演示数据。']] },
  ].map((s) => ({ ...s, rows: s.rows.map((row) => row.map(A)) }));
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`成效看板-${todayLocal()}`)}.xlsx` });
  res.send(makeXlsx(sheets));
});

export { stations };
export default r;
