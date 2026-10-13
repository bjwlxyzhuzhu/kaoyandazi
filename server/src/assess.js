// M14 结课考核中心：考核档案袋、AI使用与核验说明、行动方案汇编（学生端与教师端共用）
// 全部基于平台记录用规则计算，不调用大模型；“我的反思”只能由学生在专门的接口里填写。
import fs from 'node:fs';
import path from 'node:path';
import { SHARED_DIR } from './config.js';
import { db } from './db.js';
import { todayLocal, addDays } from './time.js';
import { getTaskDefs, chapterMeta } from './courseware.js';
import { unlockedChapters } from './routes/classroom.js';
import { getAgent, displayName } from './registry.js';

export const ASSESS = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'assessment.json'), 'utf8'));
export const ITEMS = ASSESS.items;
export const PLAN_SECTIONS = ASSESS.plan_sections;

const parse = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const n = (sql, ...args) => db.prepare(sql).get(...args).n;
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

// ---------- 课堂任务与互评 ----------

/** 已解锁章节里的全部课堂任务 */
export function classroomTasks() {
  const out = [];
  for (const ch of unlockedChapters()) {
    for (const t of getTaskDefs(ch)?.tasks || []) out.push({ chapter: ch, id: t.id, type: t.type, title: t.title });
  }
  return out;
}

export function classroomStats(userId) {
  const tasks = classroomTasks();
  const subs = db.prepare('SELECT chapter, task_id FROM submissions WHERE user_id = ?').all(userId);
  const done = tasks.filter((t) => subs.some((s) => s.chapter === t.chapter && s.task_id === t.id));
  const assigned = n('SELECT COUNT(*) AS n FROM peer_reviews WHERE reviewer_id = ?', userId);
  const reviewed = n('SELECT COUNT(*) AS n FROM peer_reviews WHERE reviewer_id = ? AND rubric_json IS NOT NULL', userId);
  return {
    tasks: tasks.length, submitted: done.length, submit_rate: pct(done.length, tasks.length),
    missing: tasks.filter((t) => !done.includes(t)).map((t) => `第${t.chapter}章 ${t.title}`),
    peer_assigned: assigned, peer_done: reviewed, peer_rate: assigned ? pct(reviewed, assigned) : null,
  };
}

// ---------- 考核档案袋 ----------

function schoolsItem(userId) {
  const rows = db.prepare('SELECT * FROM schools WHERE user_id = ?').all(userId);
  const facts = rows.flatMap((r) => parse(r.facts_json, []));
  const verified = facts.filter((f) => f.verified).length;
  const tiers = new Set(rows.map((r) => r.tier).filter(Boolean));
  const levels = {};
  for (const f of facts) levels[f.level || '未标注'] = (levels[f.level || '未标注'] || 0) + 1;
  const noBasis = rows.filter((r) => !String(r.basis || '').trim() || !String(r.uncertainty || '').trim()).length;
  const missing = [];
  if (!rows.length) missing.push('还没有建目标院校比较表');
  else {
    if (rows.length < 3) missing.push(`院校只有 ${rows.length} 所，量规要求至少3所`);
    if (tiers.size < 2) missing.push('还没有分出冲刺 / 稳妥 / 保底层次');
    if (noBasis) missing.push(`${noBasis} 所院校没写“选择依据”或“不确定之处”`);
    if (!verified) missing.push('还没有核验过任何一条数据');
  }
  return {
    status: !rows.length ? 'missing' : missing.length ? 'partial' : 'done',
    products: rows.map((r) => `【${r.tier || '未分层'}】${r.school} ${r.major || ''}`.trim()),
    metrics: { 院校数: rows.length, 数据条数: facts.length, 已核验: verified, 核验比例: `${pct(verified, facts.length)}%`, 来源等级分布: levels },
    missing,
  };
}

function planItem(userId) {
  const versions = n('SELECT COUNT(*) AS n FROM plans WHERE user_id = ?', userId);
  const days = n('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ?', userId);
  const from = addDays(todayLocal(), -6);
  const t7 = db.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM tasks WHERE user_id = ? AND date >= ? AND date <= ?').get(userId, from, todayLocal());
  const reviews = n('SELECT COUNT(*) AS n FROM weekly_reviews WHERE user_id = ?', userId);
  const reduced = n('SELECT COUNT(*) AS n FROM plans WHERE user_id = ? AND reduce_flag = 1', userId);
  const missing = [];
  if (!versions) missing.push('还没有采用学习方案');
  if (!days) missing.push('还没有打过卡');
  if (!reviews) missing.push('还没有做过周复盘');
  if (versions === 1 && reviews) missing.push('方案还没按数据调整过（量规“优秀”要求至少调整1次）');
  return {
    status: !versions && !days ? 'missing' : (versions && days && reviews) ? 'done' : 'partial',
    products: [`方案 ${versions} 个版本`, `打卡 ${days} 天`, `周复盘 ${reviews} 次`],
    metrics: { 打卡天数: days, '7日完成率': `${pct(t7.done, t7.total)}%`, 周复盘次数: reviews, 方案版本数: versions, 减量调整次数: reduced },
    missing,
  };
}

function kbItem(userId) {
  const prep = n("SELECT COUNT(*) AS n FROM kb_items WHERE user_id = ? AND space = 'prep'", userId);
  const research = n("SELECT COUNT(*) AS n FROM kb_items WHERE user_id = ? AND space = 'research'", userId);
  const papers = n('SELECT COUNT(*) AS n FROM papers WHERE user_id = ?', userId);
  const verifiedPapers = n("SELECT COUNT(*) AS n FROM papers WHERE user_id = ? AND verify_status = 'verified'", userId);
  const cards = n('SELECT COUNT(*) AS n FROM reading_cards WHERE user_id = ?', userId);
  const judged = n("SELECT COUNT(*) AS n FROM reading_cards WHERE user_id = ? AND TRIM(COALESCE(my_judgment, '')) != ''", userId);
  const ideas = n("SELECT COUNT(*) AS n FROM topic_ideas WHERE user_id = ? AND status != 'dropped'", userId);
  const mistakes = db.prepare("SELECT content_json FROM kb_items WHERE user_id = ? AND type = 'mistake'").all(userId);
  const causes = {};
  for (const m of mistakes) { const c = parse(m.content_json, {}).cause || '未填'; causes[c] = (causes[c] || 0) + 1; }
  const qbank = n('SELECT COUNT(*) AS n FROM interview_qbank WHERE user_id = ?', userId);
  const missing = [];
  if (!prep) missing.push('备考空间还是空的（知识点、错题或笔记）');
  if (!papers && !research) missing.push('科研空间还是空的（文献或科研笔记）');
  if (cards < 3) missing.push(`阅读卡 ${cards} 张，第5章课堂要求至少3张`);
  if (cards > judged) missing.push(`${cards - judged} 张阅读卡还没写“我的判断”`);
  if (!ideas) missing.push('还没有选题卡');
  const total = prep + research + papers + cards + ideas;
  return {
    status: !total ? 'missing' : missing.length ? 'partial' : 'done',
    products: [`备考条目 ${prep}`, `科研条目 ${research}`, `文献 ${papers}（已核验 ${verifiedPapers}）`, `阅读卡 ${cards}`, `选题卡 ${ideas}`, `复试问题库 ${qbank}`],
    metrics: { 条目数: prep + research, 文献数: papers, 核验文献数: verifiedPapers, 阅读卡数: cards, 选题卡数: ideas, 错因分布: causes },
    missing,
  };
}

function classroomItem(userId) {
  const s = classroomStats(userId);
  const missing = [...s.missing.map((m) => `未提交：${m}`)];
  if (s.peer_assigned > s.peer_done) missing.push(`还有 ${s.peer_assigned - s.peer_done} 份互评没完成`);
  return {
    status: !s.submitted ? 'missing' : missing.length ? 'partial' : 'done',
    products: [`课堂任务 ${s.submitted}/${s.tasks}`, s.peer_assigned ? `互评 ${s.peer_done}/${s.peer_assigned}` : '互评：老师还没开启'],
    metrics: { 提交率: `${s.submit_rate}%`, 互评完成率: s.peer_rate === null ? '未开启' : `${s.peer_rate}%` },
    missing,
  };
}

export function actionPlanRow(userId) {
  return db.prepare('SELECT * FROM action_plans WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(userId) || null;
}

function finalItem(userId) {
  const ap = actionPlanRow(userId);
  const reflections = parse(ap?.reflections_json, {});
  const done = PLAN_SECTIONS.filter((s) => String(reflections[s.key] || '').trim()).length;
  const stmt = parse(ap?.ai_statement_json, {});
  const mocks = n('SELECT COUNT(*) AS n FROM mock_interviews WHERE user_id = ? AND self_review IS NOT NULL', userId);
  const missing = [];
  if (!ap?.draft_json) missing.push('还没有汇编行动方案');
  else if (done < PLAN_SECTIONS.length) missing.push(`行动方案还有 ${PLAN_SECTIONS.length - done} 个部分没写“我的反思”`);
  if (!String(stmt.note || '').trim()) missing.push('AI使用与核验说明还没写补充说明');
  if (!ap?.submitted_at) missing.push('还没有提交终结性材料');
  return {
    status: ap?.submitted_at ? 'done' : ap?.draft_json ? 'partial' : 'missing',
    products: [ap?.submitted_at ? `已提交（${ap.submitted_at}）` : '未提交', `反思 ${done}/${PLAN_SECTIONS.length}`, `复试模拟练习 ${mocks} 次（只用于练习，不计分）`],
    metrics: { 方案完成度: `${pct(done, PLAN_SECTIONS.length)}%`, 复试练习次数: mocks },
    missing,
  };
}

/**
 * 档案袋：五项，每项有产物、状态、平台指标、缺项提示、量规。
 * 公平性：所有指标都来自不需要自带 Key 的功能（复试练习只做展示、不进状态判断）。
 */
export function portfolioOf(userId) {
  const calc = { schools: schoolsItem, plan: planItem, kb: kbItem, classroom: classroomItem, final: finalItem };
  const items = ITEMS.map((it) => ({ key: it.key, name: it.name, weight: it.weight, group: it.group, source: it.source, levels: it.levels, indicators: it.indicators, ...calc[it.key](userId) }));
  return {
    items,
    missing_count: items.filter((i) => i.status !== 'done').length,
    summary: items.filter((i) => i.status !== 'done').map((i) => `${i.name}：${i.missing[0] || '未完成'}`),
  };
}

// ---------- AI使用与核验说明 ----------

const KIND_CATEGORY = {
  M4_intake: '访谈与画像', M5_path: '路径选择', M6_school: '择校', M7_plan: '学习方案',
  M9_companion: '陪伴对话', M9_memory: '记忆整理', M9_search: '陪伴对话', M10_coach: '成果教练',
  M11_research: '文献阅读与科研', M12_kbqa: '知识库问答', M13_basic: '复试模拟', M13_full: '复试模拟',
  M15_lab: 'API实验室', M18_basic: '导师团会议', M18_full: '导师团会议', M19_basic: '数字分身', M19_full: '数字分身',
};

/**
 * 统计全部来自原始日志：ai_calls（ok=1 的真实调用，被边界拦下的不算）与 ai_actions。
 * 这里的数字与直接查表得到的数字一致（自测逐项比对）。
 */
export function aiStats(userId) {
  const rows = db.prepare(`SELECT kind, key_source, COUNT(*) AS calls, COALESCE(SUM(prompt_tokens), 0) AS pt, COALESCE(SUM(completion_tokens), 0) AS ct,
      MIN(created_at) AS first_at, MAX(created_at) AS last_at
    FROM ai_calls WHERE user_id = ? AND ok = 1 GROUP BY kind, key_source`).all(userId);
  const byCat = {};
  for (const r of rows) {
    const cat = KIND_CATEGORY[r.kind] || r.kind;
    const c = byCat[cat] || (byCat[cat] = { category: cat, calls: 0, tokens: 0, platform: 0, own: 0, first_at: r.first_at, last_at: r.last_at });
    c.calls += r.calls;
    c.tokens += r.pt + r.ct;
    if (r.key_source === 'platform') c.platform += r.calls; else c.own += r.calls;
    if (r.first_at < c.first_at) c.first_at = r.first_at;
    if (r.last_at > c.last_at) c.last_at = r.last_at;
  }
  const total = rows.reduce((s, r) => ({ calls: s.calls + r.calls, tokens: s.tokens + r.pt + r.ct }), { calls: 0, tokens: 0 });
  const blocked = n("SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ? AND ok = 0 AND error LIKE 'blocked:%'", userId);

  const facts = db.prepare('SELECT facts_json FROM schools WHERE user_id = ?').all(userId).flatMap((r) => parse(r.facts_json, []));
  const actions = db.prepare('SELECT action, COUNT(*) AS n FROM ai_actions WHERE user_id = ? GROUP BY action').all(userId);
  const act = Object.fromEntries(actions.map((a) => [a.action, a.n]));
  const adopted = (act.confirm || 0) + (act.modify || 0);
  const papers = db.prepare('SELECT verify_status FROM papers WHERE user_id = ?').all(userId);
  return {
    categories: Object.values(byCat).sort((a, b) => b.calls - a.calls),
    total_calls: total.calls,
    total_tokens: total.tokens,
    blocked_requests: blocked,
    verification: {
      school_facts: facts.length,
      school_facts_verified: facts.filter((f) => f.verified).length,
      papers: papers.length,
      papers_verified: papers.filter((p) => p.verify_status === 'verified').length,
      papers_failed: papers.filter((p) => p.verify_status === 'failed').length,
      verify_actions: act.verify || 0,
    },
    adoption: { confirm: act.confirm || 0, modify: act.modify || 0, reject: act.reject || 0, modify_rate: adopted ? pct(act.modify || 0, adopted) : null },
  };
}

/** 说明草稿（模板拼装，不调用模型；学生在此基础上写补充说明） */
export function aiStatementDraft(user, stats) {
  const v = stats.verification;
  const lines = [
    `《AI使用与核验说明》—— ${user.name}（学号 ${user.student_no}）`,
    '',
    `一、使用统计：本学期我在平台上共调用 AI ${stats.total_calls} 次，合计约 ${stats.total_tokens} 个 token。`,
    ...stats.categories.map((c) => `  · ${c.category}：${c.calls} 次（平台 Key ${c.platform} 次，我自己的 Key ${c.own} 次），约 ${c.tokens} token，${c.first_at.slice(0, 10)} 至 ${c.last_at.slice(0, 10)}`),
    stats.blocked_requests ? `  · 另有 ${stats.blocked_requests} 次请求因超出平台边界（如代写、润色）被拦下，没有调用模型。` : '',
    '',
    '二、核验情况：',
    `  · 目标院校数据：共 ${v.school_facts} 条，我核验了其中 ${v.school_facts_verified} 条。`,
    `  · 学术文献：共 ${v.papers} 篇，经 DOI 核验确认真实的 ${v.papers_verified} 篇${v.papers_failed ? `，核验失败（可能是编造或抄错）的 ${v.papers_failed} 篇` : ''}。`,
    '',
    '三、我对 AI 产物的处理：',
    `  · 直接采用 ${stats.adoption.confirm} 次，修改后采用 ${stats.adoption.modify} 次，否决 ${stats.adoption.reject} 次${stats.adoption.modify_rate === null ? '' : `；修改率 ${stats.adoption.modify_rate}%`}。`,
    '',
    '四、我的补充说明（由我本人填写）：',
  ];
  return lines.filter((l) => l !== '').join('\n').replace(/\n二、/, '\n\n二、').replace(/\n三、/, '\n\n三、').replace(/\n四、/, '\n\n四、');
}

// ---------- 行动方案汇编（模板拼装，不调用模型） ----------

export function compilePlanDraft(user) {
  const uid = user.id;
  const prof = db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(uid);
  const p = parse(prof?.profile_json, null);
  const paths = parse(prof?.paths_json, []);
  const chosen = paths.find((x) => x.id === prof?.chosen_path);
  const schools = db.prepare('SELECT * FROM schools WHERE user_id = ? ORDER BY id').all(uid);
  const plan = db.prepare('SELECT plan_json, created_at FROM plans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(uid);
  const pj = parse(plan?.plan_json, null);
  const reviews = db.prepare('SELECT week_start, rate, summary FROM weekly_reviews WHERE user_id = ? ORDER BY id DESC LIMIT 4').all(uid);
  const pi = planItem(uid);
  const ki = kbItem(uid);
  const cards = db.prepare('SELECT r.question, r.my_judgment, p.title FROM reading_cards r LEFT JOIN papers p ON p.id = r.paper_id WHERE r.user_id = ? ORDER BY r.id DESC LIMIT 5').all(uid);
  const ideas = db.prepare("SELECT question, status FROM topic_ideas WHERE user_id = ? AND status != 'dropped' ORDER BY id DESC LIMIT 3").all(uid);
  const ach = db.prepare('SELECT type, name, stage, deadline FROM achievements WHERE user_id = ? ORDER BY id').all(uid);
  const mocks = db.prepare('SELECT review_json, created_at FROM mock_interviews WHERE user_id = ? AND review_json IS NOT NULL ORDER BY id DESC LIMIT 3').all(uid);
  const qbank = db.prepare('SELECT question, status FROM interview_qbank WHERE user_id = ? ORDER BY id DESC LIMIT 8').all(uid);
  const none = '（平台里还没有这一部分的记录）';

  const sec = {
    profile: p ? [
      p.summary,
      p.strengths?.length ? `优势：${p.strengths.join('、')}` : '',
      p.gaps?.length ? `短板：${p.gaps.join('、')}` : '',
      p.weekly_hours ? `每周可投入：${p.weekly_hours} 小时` : '',
    ].filter(Boolean).join('\n') : none,
    path: chosen ? [`我选择的路径：${chosen.name}`, `我写下的理由：${prof.choice_reason || '（未填写）'}`, `这条路的代价与风险：${chosen.cost || '（未填写）'}`].join('\n') : none,
    schools: schools.length ? schools.map((s) => {
      const facts = parse(s.facts_json, []);
      return `【${s.tier || '未分层'}】${s.school} ${s.major || ''}：已核验 ${facts.filter((f) => f.verified).length}/${facts.length} 条数据\n  选择依据：${s.basis || '（未填写）'}\n  不确定之处：${s.uncertainty || '（未填写）'}`;
    }).join('\n') : none,
    plan: pj ? [
      `方案目标：${pj.goal || ''}`,
      ...(pj.phases || []).map((ph) => `  ${ph.name}（${ph.range}）：${ph.focus}；里程碑：${ph.milestone}`),
      `执行数据：${Object.entries(pi.metrics).map(([k, v]) => `${k} ${v}`).join('，')}`,
      ...reviews.map((r) => `  周复盘（${r.week_start}，完成率 ${Math.round((r.rate || 0) * 100)}%）：${r.summary}`),
    ].join('\n') : none,
    kb: [
      `知识库概况：${ki.products.join('，')}`,
      ...cards.map((c) => `  阅读卡《${c.title || '未关联文献'}》：${c.question}${c.my_judgment ? `；我的判断：${c.my_judgment}` : ''}`),
      ...ideas.map((i) => `  选题卡（${i.status === 'chosen' ? '已选定' : '候选'}）：${i.question}`),
    ].join('\n'),
    achievements: ach.length ? ach.map((a) => `【${a.type}】${a.name}｜${a.stage}${a.deadline ? `｜截止 ${a.deadline}` : ''}`).join('\n') : none,
    interview: (mocks.length || qbank.length) ? [
      `复试模拟练习 ${mocks.length} 次（AI模拟，只用于练习）`,
      ...mocks.map((m) => `  ${m.created_at.slice(0, 10)}：改进重点 ${(parse(m.review_json, {}).top3 || []).join('；')}`),
      qbank.length ? `复试问题库：${qbank.map((q) => `${q.question}（${q.status}）`).join('；')}` : '',
    ].filter(Boolean).join('\n') : none,
  };
  return {
    title: `个人考研（升学）行动方案 —— ${user.name}`,
    compiled_at: new Date().toISOString(),
    sections: PLAN_SECTIONS.map((s) => ({ key: s.key, title: s.title, content: sec[s.key] })),
  };
}

export function examinerName(key) { return displayName(getAgent(key)); }
export { chapterMeta };
