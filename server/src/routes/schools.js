// M6 择校工作台（第2章考核：目标院校信息分析表，15%）
import { Router } from 'express';
import { db } from '../db.js';
import { nowLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent } from '../auth.js';
import { setFlowStatus, flowStatusOf } from '../stations.js';
import { generateJson } from '../llm/json.js';
import { resolveKey } from '../llm/keys.js';
import { renderPrompt, commonRules, verifiedMaterials, userBrief } from '../prompts.js';
import { displayName, getAgent } from '../registry.js';
import { webSearch, fetchUrl, searchEnabled, searchDailyLimit, guessLevel } from '../search/tools.js';

const r = Router();

const LEVELS = ['官方', '院校', '经验帖', 'AI推断'];
const TIERS = ['冲刺', '稳妥', '保底'];

function lastMenu(userId, flow) {
  const row = db.prepare('SELECT answers_json FROM menu_answers WHERE user_id = ? AND flow = ? ORDER BY id DESC LIMIT 1').get(userId, flow);
  return row ? JSON.parse(row.answers_json) : null;
}

function profileSummary(userId) {
  const row = db.prepare('SELECT profile_json, chosen_path, choice_reason FROM profiles WHERE user_id = ?').get(userId);
  if (!row) return '（还没有画像）';
  const p = row.profile_json ? JSON.parse(row.profile_json) : {};
  const paths = p.paths || [];
  const chosen = paths.find((x) => x.id === row.chosen_path);
  return [p.summary, chosen && `已选路径：${chosen.name}`, row.choice_reason && `理由：${row.choice_reason}`].filter(Boolean).join('；');
}

function menuText(answers) {
  if (!answers) return '（学生还没有填写筛选条件）';
  const labels = { subject: '目标专业', region: '地域偏好', level: '层次倾向', degree: '学硕/专硕', cross: '是否跨考', risk: '风险偏好' };
  return Object.entries(answers).map(([k, v]) => `- ${labels[k] || k}：${Array.isArray(v) ? v.join('、') : v}`).join('\n');
}

function normalizeFacts(facts) {
  if (!Array.isArray(facts)) return [];
  return facts.slice(0, 20).map((f) => ({
    item: String(f?.item || '').slice(0, 40),
    value: String(f?.value ?? '').slice(0, 200),
    source: String(f?.source || '').slice(0, 120),
    url: String(f?.url || '').slice(0, 400),
    level: LEVELS.includes(f?.level) ? f.level : 'AI推断',
  })).filter((f) => f.item);
}

function publicSchool(row) {
  return {
    id: row.id, school: row.school, major: row.major, tier: row.tier,
    facts: row.facts_json ? JSON.parse(row.facts_json) : [],
    basis: row.basis || '', uncertainty: row.uncertainty || '',
    created_at: row.created_at,
  };
}

/** 第4站完成条件：比较表至少一所，且每所都写了“选择依据”和“不确定之处”（考核点） */
function syncStation4(userId) {
  const rows = db.prepare('SELECT basis, uncertainty FROM schools WHERE user_id = ?').all(userId);
  const complete = rows.length > 0 && rows.every((s) => String(s.basis || '').trim() && String(s.uncertainty || '').trim());
  const cur = flowStatusOf(userId, 4);
  if (complete && cur !== 'done') setFlowStatus(userId, 4, 'done');
  else if (!complete && rows.length && cur === 'not_started') setFlowStatus(userId, 4, 'in_progress');
}

/** 搜索服务的可用状态（前端据此显示提示） */
r.get('/schools/status', requireStudent, (_req, res) => {
  res.json({ search_enabled: searchEnabled(), daily_limit: searchDailyLimit() });
});

function dailySearchUsage(userId) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ? AND kind = 'M6_school' AND purpose LIKE '检索%' AND created_at LIKE ?`)
    .get(userId, `${nowLocal().slice(0, 10)}%`);
  return row.n;
}

/** 检索 + 生成分层候选（清单条件已填） */
r.post('/schools/generate', requireStudent, async (req, res) => {
  const u = req.user;
  const answers = lastMenu(u.id, 'school');
  if (!answers) throw new AppError(400, 'NO_MENU', '请先完成择校的菜单条件。');
  const { key, source } = resolveKey(u, 'M6_school', req.get('X-User-Key'));

  // 检索：只在配置了检索服务时启用；不可用时提示学生贴官网链接
  let searchNote = '';
  const extra = [];
  if (searchEnabled()) {
    if (dailySearchUsage(u.id) >= searchDailyLimit()) throw new AppError(429, 'SEARCH_LIMIT', '今天的检索次数用完了，明天恢复；也可以直接把官网链接贴给我。');
    try {
      const q = `${answers.subject} 招生目录 考试科目 ${answers.region?.join(' ') || ''}`.trim();
      const hits = await webSearch(q, { count: 8 });
      extra.push(...hits);
      db.prepare(`INSERT INTO ai_calls(user_id, kind, purpose, model, key_source, prompt_tokens, completion_tokens, tool_calls, ok, created_at)
        VALUES(?, 'M6_school', '检索', 'web_search', ?, 0, 0, 1, 1, ?)`).run(u.id, source, nowLocal());
    } catch (e) {
      searchNote = e.message;
    }
  } else {
    searchNote = '平台暂时没有接入联网检索，所以下面的候选里所有具体数字都会标成“待核实”，请你到研招网和招生单位官网核对。';
  }

  const hitsText = extra.length
    ? extra.map((h) => `- ${h.title}（${h.level}）${h.url}\n  ${h.snippet}`).join('\n')
    : '（本次没有检索结果）';

  const prompt = {
    system: renderPrompt('school', {
      ...userBrief(u),
      导师显示名: displayName(getAgent('school')),
      共同规则: commonRules(),
      已核实资料: verifiedMaterials(),
      画像摘要: profileSummary(u.id),
      菜单条件: menuText(answers),
      目标专业: answers.subject,
      检索结果: hitsText,
      检索是否可用: searchEnabled() ? '可用' : '不可用',
    }),
    user: searchEnabled()
      ? `这是检索到的网页线索：\n${hitsText}\n\n请据此给出冲刺/稳妥/保底三层候选，只输出 JSON。`
      : '当前不能联网检索。请只依据已核实资料和常识给出三层候选方向，所有具体数字一律写“待核实”、等级写“AI推断”，并在 reason 里提醒学生去官网核对。只输出 JSON。',
  };
  const { data } = await generateJson({ user: u, moduleId: 'M6_school', purpose: '生成候选院校', prompt, key, source, maxTokens: 3000 });
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  if (!candidates.length) throw new AppError(502, 'BAD_CANDIDATES', '这次没有生成可用的候选，请再试一次。');
  // 兜底：没有可核对来源的具体数字一律抹成“待核实”，防止模型编造分数线、报录比、招生人数
  const hitUrls = new Set(extra.map((h) => h.url));
  const scrubFact = (f) => {
    const sourced = searchEnabled() && f.url && hitUrls.has(f.url);
    if (sourced) return { ...f, level: guessLevel(f.url) };
    const hasNumber = /\d/.test(f.value);
    return { ...f, value: hasNumber || !f.value ? '待核实' : f.value, url: '', level: 'AI推断' };
  };
  const scrubText = (t) => (searchEnabled() ? t : String(t).replace(/\d+(\.\d+)?\s*(分|人|%|名|：\s*1)/g, '（数字待核实）'));
  const cleaned = candidates.slice(0, 9).map((c) => ({
    school: String(c.school || '').slice(0, 60),
    major: String(c.major || '').slice(0, 80),
    tier: TIERS.includes(c.tier) ? c.tier : '稳妥',
    reason: scrubText(String(c.reason || '').slice(0, 300)),
    facts: normalizeFacts(c.facts).map(scrubFact),
  }));
  res.json({ candidates: cleaned, search_enabled: searchEnabled(), note: searchNote, hits: extra.slice(0, 8) });
});

/** 读取官网链接正文（防 SSRF） */
r.post('/schools/fetch', requireStudent, async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const out = await fetchUrl(url);
  res.json({ url: out.url, title: out.title, text: out.text, level: out.level || guessLevel(out.url) });
});

/** 检索（供学生主动查一条具体信息） */
r.post('/schools/search', requireStudent, async (req, res) => {
  const u = req.user;
  const query = String(req.body?.query || '').trim();
  if (!query) throw new AppError(400, 'EMPTY', '请输入要查的内容。');
  if (!searchEnabled()) throw new AppError(503, 'SEARCH_DISABLED', '平台暂时没有接入联网检索。请把官网链接贴给我，我来帮你读。');
  if (dailySearchUsage(u.id) >= searchDailyLimit()) throw new AppError(429, 'SEARCH_LIMIT', '今天的检索次数用完了，明天恢复；也可以直接把官网链接贴给我。');
  const hits = await webSearch(query, { count: 8, site: req.body?.site });
  db.prepare(`INSERT INTO ai_calls(user_id, kind, purpose, model, key_source, prompt_tokens, completion_tokens, tool_calls, ok, created_at)
    VALUES(?, 'M6_school', '检索', 'web_search', 'platform', 0, 0, 1, 1, ?)`).run(u.id, nowLocal());
  res.json({ hits });
});

// ---------- 比较表 ----------
r.get('/schools', requireStudent, (req, res) => {
  const rows = db.prepare('SELECT * FROM schools WHERE user_id = ? ORDER BY CASE tier WHEN \'冲刺\' THEN 1 WHEN \'稳妥\' THEN 2 ELSE 3 END, id').all(req.user.id);
  const list = rows.map(publicSchool);
  res.json({
    schools: list,
    stats: {
      total: list.length,
      verified: list.filter((s) => s.facts.length && s.facts.every((f) => f.verified)).length,
      facts: list.reduce((n, s) => n + s.facts.length, 0),
      facts_verified: list.reduce((n, s) => n + s.facts.filter((f) => f.verified).length, 0),
      missing_basis: list.filter((s) => !s.basis.trim() || !s.uncertainty.trim()).length,
    },
  });
});

r.post('/schools', requireStudent, (req, res) => {
  const u = req.user;
  const b = req.body || {};
  const school = String(b.school || '').trim().slice(0, 60);
  if (!school) throw new AppError(400, 'NO_SCHOOL', '请填写院校名称。');
  const tier = TIERS.includes(b.tier) ? b.tier : '稳妥';
  const info = db.prepare(`INSERT INTO schools(user_id, school, major, tier, facts_json, basis, uncertainty, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
    u.id, school, String(b.major || '').slice(0, 80), tier,
    JSON.stringify(normalizeFacts(b.facts)), String(b.basis || '').slice(0, 500), String(b.uncertainty || '').slice(0, 500), nowLocal());
  syncStation4(u.id);
  res.json({ school: publicSchool(db.prepare('SELECT * FROM schools WHERE id = ?').get(info.lastInsertRowid)) });
});

r.put('/schools/:id', requireStudent, (req, res) => {
  const u = req.user;
  const row = db.prepare('SELECT * FROM schools WHERE id = ? AND user_id = ?').get(Number(req.params.id), u.id);
  if (!row) throw new AppError(404, 'NOT_FOUND', '没有这条院校记录。');
  const b = req.body || {};
  const facts = b.facts !== undefined ? normalizeFacts(b.facts) : JSON.parse(row.facts_json || '[]');
  db.prepare('UPDATE schools SET school = ?, major = ?, tier = ?, facts_json = ?, basis = ?, uncertainty = ? WHERE id = ?').run(
    b.school !== undefined ? String(b.school).slice(0, 60) : row.school,
    b.major !== undefined ? String(b.major).slice(0, 80) : row.major,
    TIERS.includes(b.tier) ? b.tier : row.tier,
    JSON.stringify(facts),
    b.basis !== undefined ? String(b.basis).slice(0, 500) : row.basis,
    b.uncertainty !== undefined ? String(b.uncertainty).slice(0, 500) : row.uncertainty,
    row.id);
  syncStation4(u.id);
  res.json({ school: publicSchool(db.prepare('SELECT * FROM schools WHERE id = ?').get(row.id)) });
});

r.delete('/schools/:id', requireStudent, (req, res) => {
  const info = db.prepare('DELETE FROM schools WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '没有这条院校记录。');
  syncStation4(req.user.id);
  res.json({ ok: true });
});

/** 逐条核验：学生对某条事实点“我已核验” */
r.post('/schools/:id/verify', requireStudent, (req, res) => {
  const u = req.user;
  const row = db.prepare('SELECT * FROM schools WHERE id = ? AND user_id = ?').get(Number(req.params.id), u.id);
  if (!row) throw new AppError(404, 'NOT_FOUND', '没有这条院校记录。');
  const idx = Number(req.body?.index);
  const facts = JSON.parse(row.facts_json || '[]');
  if (!Number.isInteger(idx) || idx < 0 || idx >= facts.length) throw new AppError(400, 'BAD_INDEX', '这条数据不存在。');
  const verified = req.body?.verified !== false;
  facts[idx].verified = verified;
  facts[idx].verified_at = verified ? nowLocal() : null;
  db.prepare('UPDATE schools SET facts_json = ? WHERE id = ?').run(JSON.stringify(facts), row.id);
  // 留痕：核验动作进入 AI 使用与核验说明的统计（M14）
  db.prepare('INSERT INTO ai_actions(user_id, object_type, object_id, action, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(u.id, 'school_fact', row.id, verified ? 'verify' : 'unverify', nowLocal());
  res.json({ school: publicSchool(db.prepare('SELECT * FROM schools WHERE id = ?').get(row.id)) });
});

/** 导出目标院校信息分析表（CSV，UTF-8 BOM，Excel 可直接打开）+ 打印版 */
r.get('/schools/export', requireStudent, (req, res) => {
  const u = req.user;
  const rows = db.prepare('SELECT * FROM schools WHERE user_id = ? ORDER BY CASE tier WHEN \'冲刺\' THEN 1 WHEN \'稳妥\' THEN 2 ELSE 3 END, id').all(u.id).map(publicSchool);
  if (!rows.length) throw new AppError(400, 'EMPTY', '比较表还是空的，先添加院校再导出。');

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['院校', '专业（代码）', '层次', '数据项', '数值', '来源', '链接', '证据等级', '核验状态', '选择依据', '不确定之处'];
  const lines = [head.map(esc).join(',')];
  for (const s of rows) {
    // 每所学校的数据按行拆开：只有第一行重复院校、依据与不确定之处，便于阅读
    const facts = s.facts.length ? s.facts : [{ item: '（尚未录入数据）', value: '', source: '', url: '', level: '' }];
    facts.forEach((f, i) => {
      const first = i === 0;
      lines.push([
        first ? s.school : '',
        first ? s.major : '',
        first ? s.tier : '',
        f.item,
        f.value,
        f.source,
        f.url,
        f.level,
        f.verified ? '已核验' : '未核验',
        first ? s.basis : '',
        first ? s.uncertainty : '',
      ].map(esc).join(','));
    });
  }
  const csv = `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`;
  const name = `${u.name}-目标院校信息分析表`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}.csv` });
  res.send(csv);
});

export default r;
