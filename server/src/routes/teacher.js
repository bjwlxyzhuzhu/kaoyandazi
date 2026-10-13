// 教师端（阶段1只包含：模型与 Key、模块分级、用量统计、个别学生临时提额、邀请码）
import { Router } from 'express';
import { db } from '../db.js';
import { AppError } from '../errors.js';
import { requireTeacher } from '../auth.js';
import { allModuleTiers, setModuleTiers } from '../registry.js';
import { getLlmConfig, publicLlmConfig, updateLlmConfig } from '../llm/settings.js';
import { listModels } from '../llm/client.js';
import { monthlyUsage, setQuotaOverride, dailyLimitFor, dailyUsed } from '../llm/keys.js';
import { todayLocal } from '../time.js';

const r = Router();
r.use('/teacher', requireTeacher);

function llmView() {
  return { ...publicLlmConfig(), month: monthlyUsage() };
}

r.get('/teacher/llm', (_req, res) => res.json(llmView()));

r.put('/teacher/llm', (req, res) => {
  updateLlmConfig(req.body || {});
  res.json(llmView());
});

/** 测试连通：用平台 Key 拉取模型列表 */
r.post('/teacher/test-llm', async (_req, res) => {
  const c = getLlmConfig();
  const key = c.mock ? 'mock-platform' : c.platformKey;
  if (!c.baseUrl || !key) throw new AppError(400, 'PLATFORM_NOT_CONFIGURED', '请先填写接口地址和平台 Key。');
  const models = await listModels({ baseUrl: c.baseUrl, key, source: 'platform' });
  res.json({ ok: true, models, mock: c.mock, chat_model_found: !c.chatModel || models.includes(c.chatModel) });
});

r.get('/teacher/module-tiers', (_req, res) => res.json({ modules: allModuleTiers() }));

r.put('/teacher/module-tiers', (req, res) => {
  res.json({ modules: setModuleTiers(req.body?.tiers || {}) });
});

/** 平台 Key 用量：按模块、按学生、按天 */
r.get('/teacher/llm/usage', (_req, res) => {
  const base = "FROM ai_calls a WHERE a.key_source = 'platform' AND a.ok = 1";
  const byModule = db.prepare(`SELECT a.kind, COUNT(*) AS calls, SUM(a.prompt_tokens + a.completion_tokens) AS tokens ${base} GROUP BY a.kind ORDER BY calls DESC`).all();
  const byStudent = db.prepare(`SELECT u.student_no, u.name, COUNT(*) AS calls, SUM(a.prompt_tokens + a.completion_tokens) AS tokens
    FROM ai_calls a JOIN users u ON u.id = a.user_id WHERE a.key_source = 'platform' AND a.ok = 1
    GROUP BY a.user_id ORDER BY calls DESC LIMIT 200`).all();
  const byDay = db.prepare(`SELECT substr(a.created_at, 1, 10) AS day, COUNT(*) AS calls, SUM(a.prompt_tokens + a.completion_tokens) AS tokens
    ${base} GROUP BY day ORDER BY day DESC LIMIT 31`).all();
  res.json({ by_module: byModule, by_student: byStudent, by_day: byDay, month: monthlyUsage() });
});

function findStudent(studentNo) {
  const u = db.prepare("SELECT * FROM users WHERE student_no = ? AND role = 'student'").get(String(studentNo || '').trim());
  if (!u) throw new AppError(404, 'NO_STUDENT', '没有找到这个学号的学生。');
  return u;
}

/** 个别学生临时调整每日基础额度（limit 为 null 表示恢复默认） */
r.get('/teacher/quota/:studentNo', (req, res) => {
  const u = findStudent(req.params.studentNo);
  res.json({ student_no: u.student_no, name: u.name, limit: dailyLimitFor(u.id), used: dailyUsed(u.id) });
});

r.put('/teacher/quota/:studentNo', (req, res) => {
  const u = findStudent(req.params.studentNo);
  const limit = req.body?.limit;
  if (limit !== null && (!Number.isFinite(Number(limit)) || Number(limit) < 0)) throw new AppError(400, 'BAD_LIMIT', '额度应为不小于0的整数。');
  const until = typeof req.body?.until === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.until) ? req.body.until : todayLocal();
  setQuotaOverride(u.id, limit === null ? null : Number(limit), until);
  res.json({ student_no: u.student_no, name: u.name, limit: dailyLimitFor(u.id), used: dailyUsed(u.id), until });
});

/** 设置：阶段1只开放邀请码 */
r.get('/teacher/settings', (_req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE is_sandbox = 0 ORDER BY id LIMIT 1').get();
  res.json({ class: cls });
});

r.put('/teacher/settings', (req, res) => {
  const code = typeof req.body?.invite_code === 'string' ? req.body.invite_code.trim() : '';
  if (code) {
    if (!/^[A-Za-z0-9]{4,32}$/.test(code)) throw new AppError(400, 'BAD_CODE', '邀请码只能是4—32位字母或数字。');
    const cls = db.prepare('SELECT * FROM classes WHERE is_sandbox = 0 ORDER BY id LIMIT 1').get();
    const dup = db.prepare('SELECT id FROM classes WHERE invite_code = ? COLLATE NOCASE AND id != ?').get(code, cls.id);
    if (dup) throw new AppError(409, 'DUP_CODE', '这个邀请码已被其他班级使用。');
    db.prepare('UPDATE classes SET invite_code = ? WHERE id = ?').run(code, cls.id);
  }
  res.json({ class: db.prepare('SELECT * FROM classes WHERE is_sandbox = 0 ORDER BY id LIMIT 1').get() });
});

export default r;
