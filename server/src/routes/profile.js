// M4 入学访谈与画像、M5 路径选择
import { Router } from 'express';
import { rememberDraft, recordAdoption, logAction } from '../trace.js';
import { db } from '../db.js';
import { nowLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent } from '../auth.js';
import { setFlowStatus } from '../stations.js';
import { generateJson } from '../llm/json.js';
import { resolveKey } from '../llm/keys.js';
import { renderPrompt, commonRules, verifiedMaterials, userBrief } from '../prompts.js';
import { displayName, getAgent } from '../registry.js';

const r = Router();

const MENU_LABELS = {
  grade: '年级', major_group: '专业大类', tendency: '目前倾向', weekly_hours: '每周可投入（小时）',
  english: '英语情况', rank: '成绩排名', achievements: '已有成果', troubles: '最大的困扰',
};

function lastMenu(userId, flow) {
  const row = db.prepare('SELECT answers_json FROM menu_answers WHERE user_id = ? AND flow = ? ORDER BY id DESC LIMIT 1').get(userId, flow);
  return row ? JSON.parse(row.answers_json) : null;
}

function menuText(answers) {
  if (!answers) return '（学生还没有填写菜单题）';
  return Object.entries(answers).map(([k, v]) => `- ${MENU_LABELS[k] || k}：${Array.isArray(v) ? v.join('、') : v}`).join('\n');
}

function interviewText(userId, limit = 60) {
  const conv = db.prepare("SELECT id FROM conversations WHERE user_id = ? AND kind = 'intake' ORDER BY id DESC LIMIT 1").get(userId);
  if (!conv) return '（还没有访谈记录）';
  const rows = db.prepare('SELECT role, content FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?').all(conv.id, limit).reverse();
  if (!rows.length) return '（还没有访谈记录）';
  return rows.map((m) => `${m.role === 'user' ? '学生' : '访谈者'}：${m.content.replace(/\n+/g, ' ').slice(0, 300)}`).join('\n');
}

function getProfile(userId) {
  return db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId) || null;
}

/** 当前画像（含路径） */
r.get('/profile', requireStudent, (req, res) => {
  const row = getProfile(req.user.id);
  const answers = lastMenu(req.user.id, 'intake');
  res.json({
    has_menu: !!answers,
    menu_answers: answers,
    profile: row?.profile_json ? JSON.parse(row.profile_json) : null,
    paths: row?.paths_json ? JSON.parse(row.paths_json) : null,
    compare_dims: row?.profile_json ? (JSON.parse(row.profile_json).compare_dims || ['兴趣', '可行性', '回报', '风险', '时间']) : ['兴趣', '可行性', '回报', '风险', '时间'],
    chosen_path: row?.chosen_path || null,
    choice_reason: row?.choice_reason || null,
    path_scores: row?.path_scores_json ? JSON.parse(row.path_scores_json) : null,
    updated_at: row?.updated_at || null,
  });
});

/** 访谈记录（供学生回看） */
r.get('/profile/interview', requireStudent, (req, res) => {
  const conv = db.prepare("SELECT id FROM conversations WHERE user_id = ? AND kind = 'intake' ORDER BY id DESC LIMIT 1").get(req.user.id);
  const msgs = conv ? db.prepare('SELECT role, content, created_at FROM messages WHERE conv_id = ? ORDER BY id').all(conv.id) : [];
  res.json({ conv_id: conv?.id || null, messages: msgs });
});

/** 生成画像（附录B.4）。JSON 不合法自动重试1次，仍失败则提示，访谈记录不丢失。 */
r.post('/profile/generate', requireStudent, async (req, res) => {
  const u = req.user;
  const answers = lastMenu(u.id, 'intake');
  if (!answers) throw new AppError(400, 'NO_MENU', '请先完成入学访谈的菜单题。');
  const { key, source } = resolveKey(u, 'M4_intake', req.get('X-User-Key'));
  const agent = getAgent('profile');
  const prompt = {
    system: renderPrompt('profile', {
      ...userBrief(u),
      导师显示名: displayName(agent),
      共同规则: commonRules(),
      已核实资料: verifiedMaterials(),
      菜单答案: menuText(answers),
      访谈记录: interviewText(u.id),
    }),
    user: '请根据上面的菜单答案和访谈记录，生成这位学生的画像和多条发展路径。只输出 JSON。',
  };
  const { data } = await generateJson({ user: u, moduleId: 'M4_intake', purpose: '生成画像', prompt, key, source, useReason: true, maxTokens: 3000 });
  if (!data?.paths || !Array.isArray(data.paths)) throw new AppError(502, 'BAD_PROFILE', '这次生成的内容不完整，请再点一次“生成画像”。');
  rememberDraft(u.id, 'profile', data);
  res.json({ profile: data });
});

/** 学生修改后确认保存（可改任何字段） */
r.put('/profile', requireStudent, (req, res) => {
  const u = req.user;
  const profile = req.body?.profile;
  if (!profile || typeof profile !== 'object') throw new AppError(400, 'BAD_PROFILE', '画像内容不正确。');
  const paths = Array.isArray(profile.paths) ? profile.paths : [];
  if (paths.length && !paths.some((p) => p.id !== 'kaoyan')) {
    throw new AppError(400, 'NEED_OTHER_PATH', '至少保留一条不是考研的路径。');
  }
  const now = nowLocal();
  const exists = getProfile(u.id);
  if (exists) {
    db.prepare('UPDATE profiles SET profile_json = ?, paths_json = ?, updated_at = ? WHERE user_id = ?')
      .run(JSON.stringify(profile), JSON.stringify(paths), now, u.id);
  } else {
    db.prepare('INSERT INTO profiles(user_id, profile_json, paths_json, updated_at) VALUES(?, ?, ?, ?)')
      .run(u.id, JSON.stringify(profile), JSON.stringify(paths), now);
  }
  // 版本历史
  db.prepare('INSERT INTO profile_history(user_id, profile_json, created_at) VALUES(?, ?, ?)')
    .run(u.id, JSON.stringify(profile), now);
  setFlowStatus(u.id, 2, 'done');
  recordAdoption(u.id, 'profile', u.id, profile);
  res.json({ profile, paths });
});

/** 路径对比打分 */
r.put('/profile/scores', requireStudent, (req, res) => {
  const scores = req.body?.scores;
  if (!scores || typeof scores !== 'object') throw new AppError(400, 'BAD_SCORES', '打分内容不正确。');
  const row = getProfile(req.user.id);
  if (!row) throw new AppError(400, 'NO_PROFILE', '请先生成画像。');
  db.prepare('UPDATE profiles SET path_scores_json = ?, updated_at = ? WHERE user_id = ?')
    .run(JSON.stringify(scores), nowLocal(), req.user.id);
  res.json({ path_scores: scores });
});

/** M5 自主选择一条路径并写理由（不足30字不能确认） */
r.post('/profile/choose', requireStudent, (req, res) => {
  const u = req.user;
  const pathId = String(req.body?.path_id || '').trim();
  const reason = String(req.body?.reason || '').trim();
  const row = getProfile(u.id);
  if (!row) throw new AppError(400, 'NO_PROFILE', '请先完成画像，再选路径。');
  const paths = row.paths_json ? JSON.parse(row.paths_json) : [];
  const target = paths.find((p) => p.id === pathId);
  if (!target) throw new AppError(400, 'BAD_PATH', '没有这条路径，请重新选择。');
  if (reason.length < 30) throw new AppError(400, 'REASON_TOO_SHORT', `理由至少要30字，现在写了${reason.length}字。可以说说：为什么这条路适合你、你愿意付出什么代价。`);
  // 历史保留：重选时把旧的选择记进版本历史
  db.prepare('UPDATE profiles SET chosen_path = ?, choice_reason = ?, updated_at = ? WHERE user_id = ?')
    .run(pathId, reason, nowLocal(), u.id);
  setFlowStatus(u.id, 3, 'done');
  res.json({ chosen_path: pathId, choice_reason: reason, path: target });
});

export default r;
