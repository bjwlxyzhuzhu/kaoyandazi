// M10 成果铺垫：成果目录、我的成果项目（教练对话在 conv 里，高阶）
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import { SHARED_DIR } from '../config.js';
import { db } from '../db.js';
import { nowLocal, todayLocal, addDays } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent } from '../auth.js';
import { setFlowStatus, flowStatusOf } from '../stations.js';

const catalog = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'achievements.json'), 'utf8'));
const r = Router();

const STAGES = catalog.stages;
const TYPES = catalog.types;

function publicAchievement(a) {
  const today = todayLocal();
  const days = a.deadline ? Math.round((new Date(`${a.deadline}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000) : null;
  return {
    id: a.id, type: a.type || '', name: a.name, deadline: a.deadline || '',
    stage: a.stage || '了解中', notes: a.notes || '',
    created_at: a.created_at,
    days_left: days,
    urgent: days !== null && days >= 0 && days <= 7 && !['已完成', '已放弃'].includes(a.stage || ''),
    overdue: days !== null && days < 0 && !['已完成', '已放弃'].includes(a.stage || ''),
  };
}

/** 成果目录：按路径与专业大类筛选推荐（PRD M10） */
r.get('/achievements/catalog', requireStudent, (req, res) => {
  const u = req.user;
  const profile = db.prepare('SELECT chosen_path FROM profiles WHERE user_id = ?').get(u.id);
  const chosen = profile?.chosen_path || null;
  const list = catalog.catalog.map((c) => {
    const byMajor = !c.major_groups?.length || c.major_groups.includes(u.major_group);
    const byPath = !chosen || !c.paths?.length || c.paths.includes(chosen);
    return { ...c, recommended: byMajor && byPath, matches_major: byMajor, matches_path: byPath };
  });
  res.json({
    catalog: list,
    stages: STAGES,
    types: TYPES,
    tiers: catalog.tiers,
    chosen_path: chosen,
    note: '时间规律以官方通知为准，平台不保证日期准确。推荐按“你选的路径 + 专业大类”筛出。',
  });
});

r.get('/achievements', requireStudent, (req, res) => {
  const rows = db.prepare('SELECT * FROM achievements WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  const list = rows.map(publicAchievement);
  res.json({
    achievements: list,
    stats: {
      total: list.length,
      active: list.filter((a) => !['已完成', '已放弃'].includes(a.stage)).length,
      done: list.filter((a) => a.stage === '已完成').length,
      urgent: list.filter((a) => a.urgent).length,
    },
    stages: STAGES,
  });
});

r.post('/achievements', requireStudent, (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) throw new AppError(400, 'NO_NAME', '请填写成果名称。');
  const type = TYPES.includes(b.type) ? b.type : '竞赛';
  const stage = STAGES.includes(b.stage) ? b.stage : '了解中';
  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(b.deadline || '')) ? b.deadline : '';
  const info = db.prepare('INSERT INTO achievements(user_id, type, name, deadline, stage, notes, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, type, name.slice(0, 120), deadline || null, stage, String(b.notes || '').slice(0, 1000), nowLocal());
  if (flowStatusOf(req.user.id, 9) === 'not_started') setFlowStatus(req.user.id, 9, 'in_progress');
  res.json({ achievement: publicAchievement(db.prepare('SELECT * FROM achievements WHERE id = ?').get(info.lastInsertRowid)) });
});

r.put('/achievements/:id', requireStudent, (req, res) => {
  const a = db.prepare('SELECT * FROM achievements WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!a) throw new AppError(404, 'NOT_FOUND', '没有这个成果项目。');
  const b = req.body || {};
  const patch = {};
  if (b.name !== undefined) patch.name = String(b.name).slice(0, 120);
  if (b.type !== undefined) patch.type = TYPES.includes(b.type) ? b.type : a.type;
  if (b.stage !== undefined) patch.stage = STAGES.includes(b.stage) ? b.stage : a.stage;
  if (b.notes !== undefined) patch.notes = String(b.notes).slice(0, 1000);
  if (b.deadline !== undefined) patch.deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(b.deadline)) ? b.deadline : null;
  const keys = Object.keys(patch);
  if (keys.length) db.prepare(`UPDATE achievements SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), a.id);
  const now = db.prepare('SELECT * FROM achievements WHERE id = ?').get(a.id);
  // 全部成果都结束时，第9站算完成
  const open = db.prepare("SELECT COUNT(*) AS n FROM achievements WHERE user_id = ? AND stage NOT IN ('已完成','已放弃')").get(req.user.id).n;
  if (db.prepare('SELECT COUNT(*) AS n FROM achievements WHERE user_id = ?').get(req.user.id).n > 0 && open === 0) {
    if (flowStatusOf(req.user.id, 9) !== 'done') setFlowStatus(req.user.id, 9, 'done');
  }
  res.json({ achievement: publicAchievement(now) });
});

r.delete('/achievements/:id', requireStudent, (req, res) => {
  const info = db.prepare('DELETE FROM achievements WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '没有这个成果项目。');
  res.json({ ok: true });
});

/** 近7天截止的成果（给首页和干预用） */
r.get('/achievements/upcoming', requireStudent, (req, res) => {
  const rows = db.prepare(`SELECT * FROM achievements WHERE user_id = ? AND deadline IS NOT NULL AND deadline != ''
    AND stage NOT IN ('已完成','已放弃') AND deadline <= ? ORDER BY deadline`).all(req.user.id, addDays(todayLocal(), 30));
  res.json({ upcoming: rows.map(publicAchievement) });
});

export default r;
