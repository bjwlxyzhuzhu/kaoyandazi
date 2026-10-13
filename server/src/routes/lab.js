// M15 API实验室（第六章课堂任务）：POST /lab/models  POST /lab/chat（SSE）  GET/POST/PUT/DELETE /lab/agents  GET /lab/anatomy
// 全部使用学生自己的 Key（高阶模块）；可以临时换一把 Key，只用于本次请求，不入库、不写日志。
import { Router } from 'express';
import { db } from '../db.js';
import { nowLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent, rateLimit } from '../auth.js';
import { getLlmConfig } from '../llm/settings.js';
import { resolveKey, recordCall } from '../llm/keys.js';
import { listModels, streamChat } from '../llm/client.js';
import { maskKey, redact } from '../crypto.js';
import { renderPrompt, commonRules, userBrief } from '../prompts.js';

const r = Router();
const labLimit = rateLimit({ windowMs: 60 * 1000, max: 20, key: (req) => `lab:${req.user?.id}` });

/** 实验室用哪把 Key：请求体里的临时 Key 优先，其次走两级 Key 规则（M15_lab 为高阶） */
function labKey(req) {
  const temp = typeof req.body?.temp_key === 'string' ? req.body.temp_key.trim() : '';
  if (temp) {
    if (!/^sk-[\w-]{8,}$/.test(temp)) throw new AppError(400, 'BAD_KEY', '临时 Key 的格式不对，一般以 sk- 开头。');
    return { key: temp, source: 'user' };
  }
  return resolveKey(req.user, 'M15_lab', req.get('X-User-Key'));
}

r.post('/lab/models', requireStudent, labLimit, async (req, res) => {
  const { key, source } = labKey(req);
  const llm = getLlmConfig();
  const models = await listModels({ baseUrl: llm.baseUrl, key, source });
  res.json({ models, base_url: llm.baseUrl, key_mask: maskKey(key), default_model: llm.chatModel });
});

function clampParams(b, llm) {
  return {
    model: String(b.model || llm.chatModel).slice(0, 80),
    system: String(b.system || '').slice(0, 4000),
    temperature: Math.max(0, Math.min(2, Number.isFinite(Number(b.temperature)) ? Number(b.temperature) : 0.7)),
    maxTokens: Math.max(16, Math.min(4000, Math.floor(Number(b.max_tokens) || 800))),
  };
}

/**
 * 对话实验。models 传一个是普通对话；传两个是“双模型对比”，同一个问题依次发给两个模型。
 * SSE：meta → (model_start → delta* → model_end)× → done
 */
r.post('/lab/chat', requireStudent, labLimit, async (req, res) => {
  const u = req.user;
  const { key, source } = labKey(req);
  const llm = getLlmConfig();
  const text = String(req.body?.text || '').trim();
  if (!text) throw new AppError(400, 'EMPTY', '请输入要发给模型的内容。');
  if (text.length > 4000) throw new AppError(400, 'TOO_LONG', '一次最多4000字。');
  const p = clampParams(req.body || {}, llm);
  const models = (Array.isArray(req.body?.models) && req.body.models.length ? req.body.models : [p.model])
    .map((m) => String(m).slice(0, 80)).filter(Boolean).slice(0, 2);
  const history = (Array.isArray(req.body?.history) ? req.body.history : []).slice(-10)
    .filter((m) => ['user', 'assistant'].includes(m?.role) && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let open = true;
  res.on('close', () => { open = false; });
  const emit = (ev, data) => { if (open) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); };
  emit('meta', { models, mock: llm.mock, key_mask: maskKey(key) });

  for (const model of models) {
    emit('model_start', { model });
    const t0 = Date.now();
    try {
      const messages = [...(p.system ? [{ role: 'system', content: p.system }] : []), ...history, { role: 'user', content: text }];
      const out = await streamChat({ baseUrl: llm.baseUrl, key, model, messages, temperature: p.temperature, maxTokens: p.maxTokens, source, onDelta: (t) => emit('delta', { model, text: t }) });
      recordCall({ userId: u.id, kind: 'M15_lab', purpose: models.length > 1 ? 'API实验室·双模型对比' : 'API实验室·对话', model: out.model, source, usage: out.usage });
      emit('model_end', { model, used_model: out.model, ms: Date.now() - t0, usage: out.usage });
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'LLM_FAILED';
      recordCall({ userId: u.id, kind: 'M15_lab', purpose: 'API实验室', model, source, usage: null, ok: false, error: code });
      if (!(e instanceof AppError)) console.warn('[实验室] 调用失败：', redact(e?.message || ''));
      emit('model_end', { model, error: e instanceof AppError ? e.message : '这个模型这次没有返回内容。', code });
    }
  }
  emit('done', {});
  if (open) res.end();
});

// ---------- 我的小智能体 ----------

function publicAgent(a) {
  return { id: a.id, name: a.name, system_prompt: a.system_prompt || '', model: a.model || '', temperature: a.temperature, max_tokens: a.max_tokens, created_at: a.created_at, updated_at: a.updated_at };
}

r.get('/lab/agents', requireStudent, (req, res) => {
  res.json({ agents: db.prepare('SELECT * FROM lab_agents WHERE user_id = ? ORDER BY id DESC').all(req.user.id).map(publicAgent) });
});

function agentFields(b, llm) {
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) throw new AppError(400, 'NO_NAME', '给你的小智能体起个名字。');
  const p = clampParams(b, llm);
  if (!p.system.trim()) throw new AppError(400, 'NO_PROMPT', '小智能体至少要有一段系统提示词。');
  return { name, ...p };
}

r.post('/lab/agents', requireStudent, (req, res) => {
  const f = agentFields(req.body || {}, getLlmConfig());
  const n = db.prepare('SELECT COUNT(*) AS n FROM lab_agents WHERE user_id = ?').get(req.user.id).n;
  if (n >= 20) throw new AppError(400, 'FULL', '最多保存20个小智能体，先删掉几个吧。');
  const info = db.prepare('INSERT INTO lab_agents(user_id, name, system_prompt, model, temperature, max_tokens, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(req.user.id, f.name, f.system, f.model, f.temperature, f.maxTokens, nowLocal());
  res.json({ agent: publicAgent(db.prepare('SELECT * FROM lab_agents WHERE id = ?').get(info.lastInsertRowid)) });
});

r.put('/lab/agents/:id', requireStudent, (req, res) => {
  const a = db.prepare('SELECT * FROM lab_agents WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!a) throw new AppError(404, 'NOT_FOUND', '没有这个小智能体。');
  const f = agentFields({ ...publicAgent(a), ...req.body, system: req.body?.system ?? a.system_prompt }, getLlmConfig());
  db.prepare('UPDATE lab_agents SET name = ?, system_prompt = ?, model = ?, temperature = ?, max_tokens = ?, updated_at = ? WHERE id = ?')
    .run(f.name, f.system, f.model, f.temperature, f.maxTokens, nowLocal(), a.id);
  res.json({ agent: publicAgent(db.prepare('SELECT * FROM lab_agents WHERE id = ?').get(a.id)) });
});

r.delete('/lab/agents/:id', requireStudent, (req, res) => {
  const info = db.prepare('DELETE FROM lab_agents WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '没有这个小智能体。');
  res.json({ ok: true });
});

// ---------- 看懂平台本身 ----------

/**
 * 展示一个平台智能体的简化系统提示词，和一次真实形状的工具调用（寻源的文献检索）请求与响应。
 * 工具调用样例是固定的教学示例（标注“示例”），不是任何学生的真实数据。
 */
r.get('/lab/anatomy', requireStudent, (req, res) => {
  const u = req.user;
  const llm = getLlmConfig();
  const prompt = renderPrompt('research_search', {
    ...userBrief(u),
    导师显示名: '寻源｜检索导师',
    共同规则: '（这里是平台给所有导师的共同规则：不编造、不替你决定、每轮附选项……为了好读，此处省略）',
    学术进阶边界: '（这里是“不做写作、润色、投稿”的边界说明，此处省略）',
    已核实资料: '（这里是老师维护的已核实资料，此处省略）',
    菜单答案: '- 研究兴趣来自哪里：专业课\n- 文献语言：都要',
    知识库概况: '（你的知识库概况）',
  });
  res.json({
    formula: '智能体 = 模型 + 提示词 + 工具 + 记忆',
    parts: [
      { name: '模型', text: `平台当前用的对话模型是 ${llm.chatModel || '（未配置）'}。同一个模型，换一段提示词就是另一个导师。` },
      { name: '提示词', text: '下面是检索导师“寻源”的系统提示词（简化版）。它规定了身份、步骤和不许做的事。' },
      { name: '工具', text: '寻源不靠模型“回忆”文献，而是先调用检索工具 search_works，再只从返回结果里挑。下面是一次调用的请求和响应（示例）。' },
      { name: '记忆', text: '陪伴导师会把你说过的重要事情整理成长期记忆，下次对话时拼进提示词里——这就是它“记得你”的原因。你可以在“它记得什么”里查看和删除。' },
    ],
    system_prompt: prompt,
    tool_call_example: {
      note: '示例：结构与平台真实调用一致，内容为教学演示，不是任何学生的数据。',
      request: { method: 'GET', url: 'https://api.openalex.org/works?search=生成式人工智能 教育评价&per_page=8' },
      response: {
        meta: { count: 22059 },
        results: [{ id: 'https://openalex.org/W0000000000', title: '（示例）一篇关于生成式人工智能与教育评价的论文', publication_year: 2025, doi: 'https://doi.org/10.xxxx/示例' }],
      },
      then: '平台把这些结果（带 work_id）塞进提示词，模型只能从里面挑选并说明理由；work_id 不在结果里的推荐会被视为编造。',
    },
  });
});

export default r;
