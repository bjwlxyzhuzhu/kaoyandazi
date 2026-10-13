// M4—M7 对话的上下文装配与提示词（PRD 附录B.3—B.6）
import { db } from './db.js';
import { addDays, todayLocal } from './time.js';
import { renderPrompt, commonRules, verifiedMaterials, userBrief } from './prompts.js';
import { getAgent, displayName } from './registry.js';

/** 最近一次菜单答案 */
function lastMenu(userId, flow) {
  const row = db.prepare('SELECT answers_json FROM menu_answers WHERE user_id = ? AND flow = ? ORDER BY id DESC LIMIT 1').get(userId, flow);
  return row ? JSON.parse(row.answers_json) : null;
}

function menuToText(answers, flow) {
  if (!answers) return '（学生还没有填写菜单题）';
  const labels = {
    grade: '年级', major_group: '专业大类', tendency: '目前倾向', weekly_hours: '每周可投入（小时）',
    english: '英语情况', rank: '成绩排名', achievements: '已有成果', troubles: '最大的困扰',
    subject: '目标专业', region: '地域偏好', level: '层次倾向', degree: '学硕/专硕', cross: '是否跨考', risk: '风险偏好',
    slots: '可用时段', focus: '本阶段重点', research: '是否包含科研阅读', rhythm: '节奏偏好',
  };
  return Object.entries(answers)
    .map(([k, v]) => `- ${labels[k] || k}：${Array.isArray(v) ? v.join('、') : v}`)
    .join('\n');
}

function profileOf(userId) {
  const row = db.prepare('SELECT profile_json, paths_json, chosen_path, choice_reason FROM profiles WHERE user_id = ?').get(userId);
  if (!row) return { profile: null, paths: null, chosen: null, reason: null };
  return {
    profile: row.profile_json ? JSON.parse(row.profile_json) : null,
    paths: row.paths_json ? JSON.parse(row.paths_json) : null,
    chosen: row.chosen_path || null,
    reason: row.choice_reason || null,
  };
}

function profileSummary(p) {
  if (!p) return '（还没有生成画像）';
  const parts = [p.summary, p.motivation && `动机：${p.motivation}`, p.career_goal && `职业目标：${p.career_goal}`,
    p.strengths?.length && `优势：${p.strengths.join('、')}`, p.gaps?.length && `短板：${p.gaps.join('、')}`,
    p.weekly_hours && `每周可投入：${p.weekly_hours}小时`];
  return parts.filter(Boolean).join('；');
}

function pathListText(paths) {
  if (!paths?.length) return '（还没有候选路径）';
  return paths.map((p) => `- ${p.name}（id=${p.id}）：适合的理由：${p.fit}；代价与风险：${p.cost}`).join('\n');
}

function selectedPathText(chosen, reason) {
  if (!chosen) return '（学生还没有选定路径）';
  return `已选路径 id：${chosen}\n理由：${reason || '（未填写）'}`;
}

function schoolsText(userId) {
  const rows = db.prepare('SELECT school, major, tier, facts_json, basis, uncertainty FROM schools WHERE user_id = ? ORDER BY id').all(userId);
  if (!rows.length) return '（比较表还是空的）';
  return rows.map((r) => {
    const facts = r.facts_json ? JSON.parse(r.facts_json) : [];
    const factsText = facts.map((f) => `${f.item}：${f.value}（来源：${f.source || '未填'}，等级：${f.level || '未填'}）`).join('；') || '暂无数据';
    return `- 【${r.tier || '未分层'}】${r.school} ${r.major || ''}\n  数据：${factsText}\n  选择依据：${r.basis || '（未填）'}\n  不确定之处：${r.uncertainty || '（未填）'}`;
  }).join('\n');
}

/** 最近7天的打卡概况 */
function weekText(userId) {
  const from = addDays(todayLocal(), -6);
  const rows = db.prepare('SELECT date, done_count, total_count, minutes, mood, reflection FROM checkins WHERE user_id = ? AND date >= ? ORDER BY date').all(userId, from);
  if (!rows.length) return '（最近7天没有打卡记录）';
  return rows.map((c) => `- ${c.date}：完成 ${c.done_count}/${c.total_count}，${c.minutes} 分钟，状态 ${c.mood}；复盘：${String(c.reflection || '').slice(0, 60)}`).join('\n');
}

/** 科研知识库概况（进科研导师的上下文）：文献数、主题、最近的阅读卡、候选选题 */
function researchBrief(userId) {
  const papers = db.prepare('SELECT id, title, year, verify_status, topic_id FROM papers WHERE user_id = ? ORDER BY id DESC').all(userId);
  const topics = db.prepare('SELECT id, name FROM topics WHERE user_id = ? ORDER BY id').all(userId);
  const cards = db.prepare('SELECT id, paper_id, question, my_judgment FROM reading_cards WHERE user_id = ? ORDER BY id DESC LIMIT 5').all(userId);
  const ideas = db.prepare('SELECT question, status FROM topic_ideas WHERE user_id = ? ORDER BY id DESC LIMIT 5').all(userId);
  const lines = [];
  lines.push(`文献 ${papers.length} 篇` + (papers.length ? `：\n${papers.slice(0, 15).map((p) => `  - [${verifyLabel(p.verify_status)}] ${p.title}${p.year ? `（${p.year}）` : ''}`).join('\n')}` : ''));
  if (topics.length) lines.push(`主题：${topics.map((t) => t.name).join('、')}`);
  if (cards.length) lines.push(`最近的阅读卡：\n${cards.map((c) => `  - ${String(c.question || '').slice(0, 80)}${c.my_judgment ? '（学生已写判断）' : '（学生还没写判断）'}`).join('\n')}`);
  if (ideas.length) lines.push(`候选选题：\n${ideas.map((i) => `  - ${i.question}（${i.status}）`).join('\n')}`);
  return lines.join('\n') || '（知识库还是空的）';
}

/** 学生正在精读的那篇：最近一张阅读卡对应的文献，否则用最近加入的一篇 */
function readTarget(userId) {
  const row = db.prepare(`SELECT p.* FROM papers p WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 1`).get(userId);
  if (!row) return null;
  return {
    ...row,
    authors: row.authors_json ? JSON.parse(row.authors_json) : [],
  };
}

function verifyLabel(s) {
  return { verified: '✅ 已核验', failed: '❌ 核验失败', unverified: '⚠️ 待核验' }[s] || '⚠️ 待核验';
}

function achievementList(userId) {
  const rows = db.prepare('SELECT type, name, deadline, stage FROM achievements WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(userId);
  if (!rows.length) return '（还没有登记成果项目）';
  return rows.map((a) => `- 【${a.type}】${a.name}${a.deadline ? `（截止 ${a.deadline}）` : ''}｜阶段：${a.stage}`).join('\n');
}

function baseVars(user, agentKey) {
  const agent = getAgent(agentKey);
  return {
    ...userBrief(user),
    导师显示名: displayName(agent),
    共同规则: commonRules(),
    已核实资料: verifiedMaterials(),
  };
}

/**
 * 返回该种对话的 systemPrompt 生成函数。
 * 学生身份、菜单答案、画像等上下文在每次请求时重新装配。
 */
export function promptForKind(kind) {
  return (user, agentKey) => {
    const vars = baseVars(user, agentKey);
    if (kind === 'intake') {
      return renderPrompt('intake', { ...vars, 菜单答案: menuToText(lastMenu(user.id, 'intake'), 'intake') });
    }
    if (kind === 'pathway') {
      const p = profileOf(user.id);
      return renderPrompt('pathway', {
        ...vars,
        画像摘要: profileSummary(p.profile),
        路径列表: pathListText(p.paths),
        已选路径: selectedPathText(p.chosen, p.reason),
      });
    }
    if (kind === 'school' || kind === 'school_intro') {
      const p = profileOf(user.id);
      const answers = lastMenu(user.id, 'school');
      const name = kind === 'school' ? 'school_chat' : 'school';
      return renderPrompt(name, {
        ...vars,
        画像摘要: profileSummary(p.profile),
        菜单条件: menuToText(answers, 'school'),
        目标专业: answers?.subject || '未指定',
        比较表: schoolsText(user.id),
      });
    }
    if (kind === 'weekly') {
      return renderPrompt('weekly', { ...vars, 本周数据: weekText(user.id), 周复盘菜单: menuToText(lastMenu(user.id, 'weekly'), 'weekly') });
    }
    // ---------- M11 科研智能体群（阶段5） ----------
    const boundsVars = { 学术进阶边界: renderPrompt('research_bounds', { 知识库概况: researchBrief(user.id) }), 知识库概况: researchBrief(user.id) };
    if (kind === 'research_search') {
      return renderPrompt('research_search', { ...vars, ...boundsVars, 菜单答案: menuToText(lastMenu(user.id, 'research'), 'research') });
    }
    if (kind === 'research_read') {
      const paper = readTarget(user.id);
      return renderPrompt('research_read', {
        ...vars, ...boundsVars,
        阅读目的: lastMenu(user.id, 'research_read')?.purpose || '（未选）',
        文献题目: paper?.title || '（还没有选中文献）',
        文献作者: paper?.authors?.join('、') || '未标注',
        文献年份: paper?.year || '不详',
        文献来源: paper?.venue || '未标注',
        文献DOI: paper?.doi || '（无）',
        核验状态: verifyLabel(paper?.verify_status),
        文献摘要: paper?.abstract || '（无摘要）',
        文献正文: paper?.fulltext ? paper.fulltext.slice(0, 20000) : '（学生没有提供全文，请只依据摘要精读，并说明摘要看不到的部分）',
      });
    }
    if (kind === 'research_topic') {
      return renderPrompt('research_topic', {
        ...vars, ...boundsVars,
        选题用途: lastMenu(user.id, 'research_topic')?.purpose || '（未选）',
        可用资源: (lastMenu(user.id, 'research_topic')?.resources || []).join('、') || '（未选）',
        文献清单: researchBrief(user.id),
      });
    }
    // ---------- M10 成果教练（阶段5） ----------
    if (kind === 'achievement') {
      const profile = db.prepare('SELECT chosen_path FROM profiles WHERE user_id = ?').get(user.id);
      return renderPrompt('achievement_coach', {
        ...vars,
        已选路径: profile?.chosen_path || '（还没选）',
        菜单答案: menuToText(lastMenu(user.id, 'achievement'), 'achievement'),
        成果项目: achievementList(user.id),
      });
    }
    throw new Error(`未知的对话类型：${kind}`);
  };
}

