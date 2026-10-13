// M1 出发准备向导、M3 今日与流程、菜单题、问卷
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { SHARED_DIR } from '../config.js';
import { db, getSetting, setSetting } from '../db.js';
import { nowLocal, todayLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent, requireLogin } from '../auth.js';
import { stations, allFlowStatus, currentStation, flowStatusOf, setFlowStatus, isStationOpen, getStation, stationMentors } from '../stations.js';
import { CURRENT_STAGE } from '../stage.js';

const menus = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'menus.json'), 'utf8'));
const surveys = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'surveys.json'), 'utf8'));

const r = Router();

// ---------- 菜单题（全部点选，不调用大模型） ----------
r.get('/menus/:flow', requireStudent, (req, res) => {
  const def = menus.flows[req.params.flow];
  if (!def) throw new AppError(404, 'NO_MENU', '没有这组菜单题。');
  const saved = db.prepare('SELECT answers_json, created_at FROM menu_answers WHERE user_id = ? AND flow = ? ORDER BY id DESC LIMIT 1')
    .get(req.user.id, req.params.flow);
  res.json({
    flow: req.params.flow,
    title: def.title,
    note: def.note || '',
    questions: def.questions,
    answers: saved ? JSON.parse(saved.answers_json) : null,
    saved_at: saved?.created_at || null,
  });
});

function validateMenu(def, answers) {
  const out = {};
  for (const q of def.questions) {
    const v = answers?.[q.key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
    if (empty) {
      if (q.required) throw new AppError(400, 'MENU_INCOMPLETE', `还有一题没有回答：${q.label}`);
      continue;
    }
    if (q.type === 'multi') {
      if (!Array.isArray(v)) throw new AppError(400, 'MENU_BAD', `${q.label} 需要是多选。`);
      const bad = v.find((x) => !q.options.includes(x));
      if (bad) throw new AppError(400, 'MENU_BAD', `${q.label} 里有不认识的选项。`);
      out[q.key] = v;
    } else if (q.type === 'slider') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < q.min || n > q.max) throw new AppError(400, 'MENU_BAD', `${q.label} 应在 ${q.min}—${q.max} 之间。`);
      out[q.key] = n;
    } else if (q.type === 'single') {
      if (!q.options.includes(v)) throw new AppError(400, 'MENU_BAD', `${q.label} 里有不认识的选项。`);
      out[q.key] = v;
    } else {
      out[q.key] = String(v).trim().slice(0, q.max || 200);
    }
  }
  return out;
}

r.post('/menus/:flow', requireStudent, (req, res) => {
  const flow = req.params.flow;
  const def = menus.flows[flow];
  if (!def) throw new AppError(404, 'NO_MENU', '没有这组菜单题。');
  const answers = validateMenu(def, req.body?.answers);
  const info = db.prepare('INSERT INTO menu_answers(user_id, flow, answers_json, created_at) VALUES(?, ?, ?, ?)')
    .run(req.user.id, flow, JSON.stringify(answers), nowLocal());
  res.json({ id: Number(info.lastInsertRowid), answers });
});

export function latestMenuAnswers(userId, flow) {
  const row = db.prepare('SELECT answers_json FROM menu_answers WHERE user_id = ? AND flow = ? ORDER BY id DESC LIMIT 1').get(userId, flow);
  return row ? JSON.parse(row.answers_json) : null;
}

// ---------- M1 出发准备 ----------
r.get('/prepare', requireStudent, (req, res) => {
  const u = req.user;
  const pre = db.prepare("SELECT id FROM surveys WHERE user_id = ? AND kind = 'pre' LIMIT 1").get(u.id);
  const steps = [
    { no: 1, key: 'consent', title: 'AI 使用须知', done: !!u.consent_at, at: u.consent_at },
    { no: 2, key: 'modules', title: '认识基础与高阶模块', done: !!getSetting(`prepare.modules_read.${u.id}`), at: null },
    { no: 3, key: 'survey', title: '前测问卷', done: !!pre, at: null },
    { no: 4, key: 'persona', title: '选择搭子人设', done: !!u.persona, at: null },
  ];
  res.json({ steps, done: steps.every((s) => s.done), persona: u.persona });
});

r.post('/prepare/consent', requireStudent, (req, res) => {
  if (req.body?.agreed !== true) throw new AppError(400, 'NOT_AGREED', '需要勾选同意后才能继续。');
  db.prepare('UPDATE users SET consent_at = ? WHERE id = ?').run(nowLocal(), req.user.id);
  res.json({ ok: true });
});

r.post('/prepare/modules-read', requireStudent, (req, res) => {
  setSetting(`prepare.modules_read.${req.user.id}`, nowLocal());
  res.json({ ok: true });
});

/** 第1步的正文：三条红线与知情同意 */
r.get('/prepare/consent', requireLogin, (_req, res) => {
  res.json({
    title: 'AI 使用须知',
    points: [
      '不把身份证号、住址、电话、家庭经济情况等敏感信息输入平台或 AI；不输入未公开的试题；不粘贴受版权保护的全文。',
      '不提交由 AI 代写的作业、论文、竞赛材料或复试材料；AI 可以帮你理思路、提问、检查逻辑，结论和文字要你自己写。',
      '使用要留痕：平台会记录每一次 AI 调用的用途、时间和用量，你可以在“成长档案”里看到这份记录。',
    ],
    notes: [
      'AI 生成的内容都会标注“AI生成”，关键判断字段（如“我的判断”“我的反思”）不会由 AI 预填。',
      '涉及院校、政策、文献等事实时，平台会标注来源和证据等级；没有可靠来源时会直接说“不确定”。',
      '老师看不到你与导师的私聊原文；你的 API Key 默认只保存在你自己的电脑上。',
      '如果聊到让你很难受的事情，平台会停下来先陪你，并建议你联系辅导员、学校心理咨询中心或心理援助热线 12356。',
    ],
  });
});

// ---------- 问卷（附录F） ----------
function surveyDef(kind) {
  const meta = surveys.kinds[kind];
  if (!meta) throw new AppError(404, 'NO_SURVEY', '没有这份问卷。');
  const items = [];
  if (kind === 'satisfaction') {
    items.push(...meta.items);
  } else {
    surveys.ability.forEach((text, i) => items.push({ key: `ability_${i + 1}`, label: text, type: 'scale', min: 1, max: 5 }));
    if (kind === 'pre' || kind === 'post') items.push(...surveys.behavior);
  }
  return { kind, title: meta.title, desc: meta.desc, items, scaleLabels: surveys.scales.labels };
}

r.get('/surveys/compare', requireStudent, (req, res) => {
  const last = (kind) => {
    const row = db.prepare('SELECT answers_json, created_at FROM surveys WHERE user_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(req.user.id, kind);
    return row ? { answers: JSON.parse(row.answers_json), at: row.created_at } : null;
  };
  const pre = last('pre');
  const mid = last('mid');
  const post = last('post');
  const pick = (s, k) => (s && Number.isFinite(Number(s.answers[k])) ? Number(s.answers[k]) : null);
  res.json({
    items: surveys.ability.map((text, i) => {
      const k = `ability_${i + 1}`;
      return { key: k, label: text, pre: pick(pre, k), mid: pick(mid, k), post: pick(post, k) };
    }),
    done: { pre: pre?.at || null, mid: mid?.at || null, post: post?.at || null, satisfaction: last('satisfaction')?.at || null },
    note: '只有你自己能看到自己的结果；全班统计完全匿名。',
  });
});

r.get('/surveys/:kind', requireStudent, (req, res) => {
  const kind = req.params.kind;
  const def = surveyDef(kind);
  const row = db.prepare('SELECT answers_json, created_at FROM surveys WHERE user_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(req.user.id, kind);
  res.json({ ...def, answers: row ? JSON.parse(row.answers_json) : null, submitted_at: row?.created_at || null });
});

r.post('/surveys/:kind', requireStudent, (req, res) => {
  const kind = req.params.kind;
  const def = surveyDef(kind);
  const answers = req.body?.answers || {};
  for (const it of def.items) {
    const v = answers[it.key];
    if (it.required === false) continue;
    if (it.type === 'scale') {
      const n = Number(v);
      const lo = it.min ?? 1;
      const hi = it.max ?? 5;
      if (!Number.isFinite(n) || n < lo || n > hi) throw new AppError(400, 'SURVEY_INCOMPLETE', `「${it.label}」还没有填（${lo}—${hi}）。`);
    } else if (it.type === 'multi') {
      if (!Array.isArray(v) || !v.length) throw new AppError(400, 'SURVEY_INCOMPLETE', `「${it.label}」至少选一项。`);
    } else {
      if (v === undefined || v === null || String(v).trim() === '') throw new AppError(400, 'SURVEY_INCOMPLETE', `「${it.label}」还没有填。`);
    }
  }
  db.prepare('INSERT INTO surveys(user_id, kind, answers_json, created_at) VALUES(?, ?, ?, ?)')
    .run(req.user.id, kind, JSON.stringify(answers), nowLocal());
  // 前测完成即视为第1站完成
  if (kind === 'pre') setFlowStatus(req.user.id, 1, 'done');
  res.json({ ok: true });
});

// ---------- M3 流程与今日 ----------
r.get('/flow', requireStudent, (req, res) => {
  const list = allFlowStatus(req.user.id).map((s) => {
    const def = getStation(s.station);
    return {
      ...s,
      full: def.full,
      chapter: def.chapter,
      product: def.product,
      goal: def.goal,
      route: def.route,
      open: isStationOpen(s.station, CURRENT_STAGE),
    };
  });
  const cur = currentStation(req.user.id);
  res.json({ stations: list, current: cur, done_count: list.filter((s) => s.status === 'done').length });
});

r.post('/flow/:station', requireStudent, (req, res) => {
  const no = Number(req.params.station);
  if (!getStation(no)) throw new AppError(404, 'NO_STATION', '没有这一站。');
  const status = req.body?.status;
  if (!['not_started', 'in_progress', 'done'].includes(status)) throw new AppError(400, 'BAD_STATUS', '状态只能是 not_started / in_progress / done。');
  setFlowStatus(req.user.id, no, status);
  res.json({ station: no, status, current: currentStation(req.user.id) });
});

/** 首页数据：今天的下一步、摘要指标、今天谁陪你 */
r.get('/today', requireStudent, (req, res) => {
  const u = req.user;
  const cur = currentStation(u.id);
  const def = getStation(cur);
  const st = flowStatusOf(u.id, cur);
  const today = todayLocal();
  const taskRow = db.prepare('SELECT COUNT(*) AS total, SUM(done) AS done FROM tasks WHERE user_id = ? AND date = ?').get(u.id, today);
  const checked = db.prepare('SELECT id FROM checkins WHERE user_id = ? AND date = ?').get(u.id, today);
  const list = allFlowStatus(u.id);
  const doneCount = list.filter((s) => s.status === 'done').length;
  const pendingCount = db.prepare('SELECT COUNT(*) AS n FROM interventions WHERE user_id = ? AND chosen IS NULL AND resolved_at IS NULL').get(u.id).n;

  // 本阶段的下一步：按当前站给出一个具体动作
  let nextStep = def.goal;
  let action = def.name;
  let actionRoute = def.route;
  if (cur === 1 && st !== 'done') {
    nextStep = '完成“出发准备”的四个小步骤：读须知、认识模块、填前测、选搭子。';
    action = '去做出发准备';
    actionRoute = '/prepare';
  } else if (cur === 5 && taskRow.total === 0) {
    nextStep = '生成一份学习方案，改到能用，再点“采用”。';
    action = '去制定方案';
  } else if (taskRow.total > 0 && !checked) {
    nextStep = `今天还有 ${taskRow.total - (taskRow.done || 0)} 个任务没勾，别忘了收尾时写一句复盘。`;
    action = '去打卡';
    actionRoute = '/road/6';
  }

  res.json({
    current: cur,
    station: { no: def.no, name: def.name, full: def.full, chapter: def.chapter, product: def.product, goal: def.goal, route: def.route, status: st },
    next_step: nextStep,
    action,
    action_route: actionRoute,
    stats: {
      done_stations: doneCount,
      total_stations: stations.length,
      today_tasks: taskRow.total || 0,
      today_tasks_done: taskRow.done || 0,
      today_checked: !!checked,
      pending_interventions: pendingCount,
    },
    mentors: stationMentors(u, cur),
    handoff: handoffFor(u, cur),
  });
});

/**
 * 7.6 站点交接：进入新站时，主讲导师引用上一站的产物做一次简短发言。
 * 只在“刚进入这一站”时给学生看一次，内容由模板拼装（不调用大模型）。
 */
function handoffFor(user, station) {
  const seenKey = `handoff.seen.${user.id}.${station}`;
  if (getSetting(seenKey)) return null;
  const prev = station - 1;
  if (prev < 1) return null;
  // 上一站必须已完成，否则还不算“交接”
  if (flowStatusOf(user.id, prev) !== 'done') return null;
  const prevDef = getStation(prev);
  if (!prevDef) return null;
  const { primary } = stationMentors(user, station);

  const artefacts = {
    1: () => {
      const pre = db.prepare("SELECT created_at FROM surveys WHERE user_id = ? AND kind = 'pre' ORDER BY id DESC LIMIT 1").get(user.id);
      return pre ? '你已经读完了 AI 使用须知、填完了前测问卷，也选好了搭子。' : '你已经完成了出发准备。';
    },
    2: () => {
      const p = db.prepare('SELECT profile_json FROM profiles WHERE user_id = ?').get(user.id);
      if (!p) return '你的画像已经确认了。';
      const j = JSON.parse(p.profile_json);
      return j.summary ? `你的画像是这样写的：“${String(j.summary).slice(0, 60)}”。` : '你的画像已经确认了。';
    },
    3: () => {
      const p = db.prepare('SELECT chosen_path, choice_reason FROM profiles WHERE user_id = ?').get(user.id);
      const paths = p?.chosen_path ? JSON.parse(db.prepare('SELECT paths_json FROM profiles WHERE user_id = ?').get(user.id).paths_json || '[]') : [];
      const name = paths.find((x) => x.id === p?.chosen_path)?.name;
      return name ? `${name}是你自己选的，理由是“${String(p.choice_reason || '').slice(0, 50)}”。` : '你已经选好了方向。';
    },
    4: () => {
      const n = db.prepare('SELECT COUNT(*) AS n FROM schools WHERE user_id = ?').get(user.id).n;
      return n ? `你的比较表里已经有 ${n} 所院校了。` : '你已经开始整理目标院校。';
    },
    5: () => {
      const plan = db.prepare('SELECT plan_json FROM plans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(user.id);
      if (!plan) return '你的学习方案已经采用。';
      const j = JSON.parse(plan.plan_json);
      return j.goal ? `你的方案目标是：“${String(j.goal).slice(0, 60)}”。` : '你的学习方案已经采用。';
    },
  };
  const detail = artefacts[prev]?.() || `第${prev}站（${prevDef.name}）已经完成。`;
  return {
    from: prevDef.name,
    text: `我是${primary ? primary.name : '你的导师'}。${detail}接下来我们做「${getStation(station).name}」，先从这一步开始。`,
  };
}

/** 学生看过了就把交接标记为已读 */
r.post('/today/handoff-seen', requireStudent, (req, res) => {
  const station = Number(req.body?.station);
  if (!Number.isInteger(station)) throw new AppError(400, 'BAD_STATION', '站点编号不正确。');
  setSetting(`handoff.seen.${req.user.id}.${station}`, nowLocal());
  res.json({ ok: true });
});

export default r;
