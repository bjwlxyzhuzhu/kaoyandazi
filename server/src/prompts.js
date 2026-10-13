// 提示词装配：模板放在 server/prompts/*.md，便于不改代码就能维护（PRD 第12章“可维护”）
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './config.js';
import { db, getSetting } from './db.js';
import { getAgent, displayName } from './registry.js';
import { todayLocal } from './time.js';

const dir = path.join(ROOT_DIR, 'server', 'prompts');
const load = (name) => fs.readFileSync(path.join(dir, `${name}.md`), 'utf8').trim();

export function fill(template, vars) {
  return template.replace(/\{([^{}\n]{1,20})\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m));
}

export function commonRules() {
  return load('common_rules');
}

/** 已核实资料：教师在后台维护（settings.verified_materials），未维护时用默认文件 */
export function verifiedMaterials() {
  return getSetting('verified_materials') || load('verified_materials');
}

/** 长期记忆（改写自 memory.js，这里直接读库以避免模块循环依赖） */
function memoryText(userId) {
  const rows = db.prepare('SELECT content, category FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT 40').all(userId);
  if (!rows.length) return '（还没有长期记忆）';
  return rows.slice().reverse().map((m) => `- [${m.category || '其他'}] ${m.content}`).join('\n');
}

/** 1:1 陪伴导师（M9）的系统提示词：人设 + 共同规则 + 长期记忆 + 学情上下文 */
export function companionPrompt(user, agentKey) {
  const agent = getAgent(agentKey);
  return fill(load('companion'), {
    导师显示名: displayName(agent),
    人设风格: agent.tone,
    姓名: user.name,
    日期: todayLocal(),
    共同规则: commonRules(),
    已核实资料: verifiedMaterials(),
    专业: user.major || '未填写',
    年级: user.grade || '未填写',
    专业大类: user.major_group || '未填写',
    长期记忆: memoryText(user.id),
    画像与路径: learnerBrief(user.id),
    学情: learningBrief(user.id),
    待处理提醒: pendingText(user.id),
    心理危机热线: '12356',
  });
}

/** 画像 + 已选路径（进上下文） */
function learnerBrief(userId) {
  const row = db.prepare('SELECT profile_json, chosen_path, choice_reason FROM profiles WHERE user_id = ?').get(userId);
  if (!row) return '（还没有画像）';
  const p = row.profile_json ? JSON.parse(row.profile_json) : {};
  const paths = p.paths || [];
  const chosen = paths.find((x) => x.id === row.chosen_path);
  const parts = [];
  if (p.summary) parts.push(p.summary);
  if (p.gaps?.length) parts.push(`短板：${p.gaps.join('、')}`);
  if (chosen) parts.push(`已选路径：${chosen.name}（理由：${row.choice_reason || '未填写'}）`);
  return parts.length ? parts.join('\n') : '（画像还不完整）';
}

/** 今日任务、近5次打卡、方案摘要（进上下文） */
function learningBrief(userId) {
  const today = todayLocal();
  const tasks = db.prepare('SELECT title, kind, minutes, done FROM tasks WHERE user_id = ? AND date = ? ORDER BY id').all(userId, today);
  const plan = db.prepare('SELECT plan_json FROM plans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(userId);
  const checkins = db.prepare(`SELECT date, done_count, total_count, minutes, mood, reflection FROM checkins
    WHERE user_id = ? ORDER BY date DESC LIMIT 5`).all(userId);
  const lines = [];
  if (plan) {
    const pj = JSON.parse(plan.plan_json);
    if (pj.goal) lines.push(`本阶段目标：${pj.goal}`);
    if (plan.reduce_flag) lines.push('注意：你最近选择了减量，下周的方案会相应减少任务。');
  }
  lines.push(tasks.length
    ? `今日任务：\n${tasks.map((t) => `  - ${t.done ? '✅' : '⬜'} ${t.title}（${t.minutes}分钟）`).join('\n')}`
    : '今日没有安排任务。');
  if (checkins.length) {
    lines.push(`近${checkins.length}次打卡：\n${checkins.map((c) => `  - ${c.date} 完成 ${c.done_count}/${c.total_count}，状态${c.mood}；复盘：${String(c.reflection || '').slice(0, 40)}`).join('\n')}`);
  } else {
    lines.push('还没有打卡记录。');
  }
  return lines.join('\n');
}

/** 待处理干预 */
function pendingText(userId) {
  const rows = db.prepare("SELECT rule, title, message FROM interventions WHERE user_id = ? AND chosen IS NULL AND resolved_at IS NULL ORDER BY id DESC LIMIT 3").all(userId);
  if (!rows.length) return '（无）';
  return rows.map((x) => `- ${x.title}：${x.message}`).join('\n');
}

/** 通用装配：按名字取模板并填变量（M4—M7） */
export function renderPrompt(name, vars) {
  return fill(load(name), vars);
}

export function userBrief(user) {
  return {
    姓名: user.name,
    专业: user.major || '未填写',
    年级: user.grade || '未填写',
    专业大类: user.major_group || '未填写',
  };
}
