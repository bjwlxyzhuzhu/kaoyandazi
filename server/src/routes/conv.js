// 通用对话（PRD 第9章「通用对话」）：GET /conv/:kind、POST /conv/:kind/new、POST /conv/:kind/send（SSE）
// SSE 事件：meta → delta* → done | error
import { Router } from 'express';
import { db } from '../db.js';
import { nowLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent, rateLimit } from '../auth.js';
import { companions, resolvePersona } from '../registry.js';
import { companionPrompt } from '../prompts.js';
import { getLlmConfig } from '../llm/settings.js';
import { resolveKey, recordCall } from '../llm/keys.js';
import { streamChat } from '../llm/client.js';
import { splitReply } from '../llm/options.js';
import { redact } from '../crypto.js';
import { promptForKind } from '../convkinds.js';
import { fetchUrl } from '../search/tools.js';
import { searchWorks } from '../research/works.js';
import { checkResearchBoundary } from '../research/boundary.js';
import { organizeMemory, userMessageCount } from '../memory.js';
import { mentorRuntime, citedSources } from '../workshop.js';
import { agents as allAgents, getAgent as agentOf, displayName as nameOf } from '../registry.js';
import { renderPrompt as render, commonRules, verifiedMaterials, userBrief } from '../prompts.js';

/** 每种对话对应的模块（决定用哪把 Key）、可用导师与系统提示词 */
/** 可以 1:1 提问的导师：非陪伴、非后台工作者、非分身与主持 */
export const ASK_AGENTS = allAgents.filter((a) => a.role !== 'companion' && !a.worker && !['twin', 'host'].includes(a.key) && !a.key.startsWith('examiner') && !a.key.startsWith('research') && a.key !== 'interview').map((a) => a.key);

const KINDS = {
  companion: {
    moduleId: 'M9_companion',
    purpose: '陪伴',
    agents: companions.map((a) => a.key),
    defaultAgent: (user) => resolvePersona(user.persona),
    systemPrompt: (user, agentKey) => companionPrompt(user, agentKey),
  },
  // M4—M7 的对话（提示词与可用导师由 convkinds.js 提供）
  intake: { moduleId: 'M4_intake', purpose: '入学访谈', agents: ['intake'], defaultAgent: () => 'intake', systemPrompt: promptForKind('intake') },
  pathway: { moduleId: 'M5_path', purpose: '路径选择', agents: ['pathway'], defaultAgent: () => 'pathway', systemPrompt: promptForKind('pathway') },
  school: { moduleId: 'M6_school', purpose: '择校对话', agents: ['school'], defaultAgent: () => 'school', systemPrompt: promptForKind('school'), fetchLinks: true },
  weekly: { moduleId: 'M9_companion', purpose: '周复盘', agents: companions.map((a) => a.key), defaultAgent: (user) => resolvePersona(user.persona), systemPrompt: promptForKind('weekly') },
  // M11 科研导师（高阶，用学生自己的 Key）：寻源需要真实检索，其余为普通对话
  research_search: { moduleId: 'M11_research', purpose: '文献检索', agents: ['research_search'], defaultAgent: () => 'research_search', systemPrompt: promptForKind('research_search'), researchSearch: true, boundary: true },
  research_read: { moduleId: 'M11_research', purpose: '精读文献', agents: ['research_read'], defaultAgent: () => 'research_read', systemPrompt: promptForKind('research_read'), boundary: true },
  research_topic: { moduleId: 'M11_research', purpose: '选题追问', agents: ['research_topic'], defaultAgent: () => 'research_topic', systemPrompt: promptForKind('research_topic'), boundary: true },
  // M10 成果教练（高阶）
  // 1:1 问一位导师（政策、经验、学法、方向、择校、计划……），回答可引用导师工坊里教师发布的资料
  ask: {
    moduleId: 'M18_basic', purpose: '问导师', agents: ASK_AGENTS, defaultAgent: () => 'policy',
    systemPrompt: (user, agentKey) => {
      const a = agentOf(agentKey);
      return render('mentor_ask', { ...userBrief(user), 导师显示名: nameOf(a), 导师职责说明: a.summary, 导师语气: a.tone || '', 共同规则: commonRules(), 已核实资料: verifiedMaterials() });
    },
  },
  achievement: { moduleId: 'M10_coach', purpose: '成果教练', agents: ['achievement'], defaultAgent: () => 'achievement', systemPrompt: promptForKind('achievement'), boundary: true },
};

const HISTORY_LIMIT = 12;

const MAX_LINKS = 2;

/** 读取消息里的前两个链接；失败的链接把原因告诉模型，让它如实转告学生 */
async function readLinks(text) {
  const urls = [...new Set(String(text).match(/https?:\/\/[^\s<>"'，。；）)]+/g) || [])].slice(0, MAX_LINKS);
  if (!urls.length) return '';
  const parts = [];
  for (const url of urls) {
    try {
      const page = await fetchUrl(url);
      parts.push(`【学生提供的链接】${page.url}\n证据等级（按域名判断）：${page.level}\n页面标题：${page.title || '（无）'}\n页面正文（节选）：\n${page.text}`);
    } catch (e) {
      parts.push(`【学生提供的链接】${url}\n读取失败：${e instanceof AppError ? e.message : '打不开这个网页。'}请如实告诉学生没有读到，不要猜测页面内容。`);
    }
  }
  return `以下是本轮学生贴来的网页内容，只能依据这些内容回答，引用时注明来源链接：\n\n${parts.join('\n\n')}`;
}

/**
 * 科研检索：先从学生的话里抽出检索式（用最直观的办法：整句去问句词），
 * 跑一次真实的 OpenAlex 检索，把**真实返回的文献**交给模型。
 * 模型只能从这批里挑，work_id 必须是这里出现过的，从而杜绝编造文献。
 */
async function runResearchSearch(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  // 去掉常见的问句外壳，留下关键词
  const query = raw
    .replace(/【选择】[A-Z]：/g, '')
    .replace(/(帮我|我想|请|能不能|可以|怎么|如何|什么|哪些|有没有|一下|我的|我想找|检索|搜索|找)/g, ' ')
    .replace(/[？?。！!，,、；;：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (query.length < 2) return '';
  try {
    const out = await searchWorks({ query, limit: 8 });
    if (!out.works.length) {
      return `【平台已替你检索】关键词「${query}」在 OpenAlex 里没有找到结果。请如实告诉学生没找到，建议换关键词，或去知网检索后导出。不要编造文献。`;
    }
    const lines = out.works.map((w, i) => `${i + 1}. work_id=${w.work_id}\n   题名：${w.title}\n   作者：${w.authors.slice(0, 3).join('、') || '未标注'}${w.authors.length > 3 ? ' 等' : ''}\n   年份：${w.year || '不详'}｜来源：${w.venue || '未标注'}\n   DOI：${w.doi || '（无）'}\n   摘要：${(w.abstract || '（无摘要）').slice(0, 300)}`);
    return `【平台已替你检索】关键词「${query}」，OpenAlex 真实返回 ${out.works.length} 条（共 ${out.total} 条）。
你只能从下面这批文献里挑选推荐，**work_id 必须原样使用，绝不能编造标题、作者、期刊或 DOI**：
${out.total > out.works.length ? `（这是前 ${out.works.length} 条）\n` : ''}
${lines.join('\n\n')}
${out.zh_coverage_low ? '\n注意：中文文献覆盖不足，请如实说明，并给出“教我去知网检索并导出”的选项。' : ''}`;
  } catch (e) {
    return `【平台检索失败】${e instanceof AppError ? e.message : '检索服务暂时不可用。'}请如实告诉学生这次没检索到，可以稍后再试，或自己到知网检索后导出。不要凭记忆推荐文献。`;
  }
}

const pending = new Set(); // 正在生成的对话 id：关闭面板不取消请求，恢复时读取同一结果

const r = Router();
const sendLimit = rateLimit({ windowMs: 60 * 1000, max: 20, key: (req) => `send:${req.user?.id}` });

function kindOf(req) {
  const k = KINDS[req.params.kind];
  if (!k) throw new AppError(404, 'UNKNOWN_KIND', '没有这种对话。');
  return k;
}

function publicMessage(m) {
  let options = null;
  if (m.options_json) {
    try { options = JSON.parse(m.options_json); } catch { options = null; }
  }
  return { id: m.id, role: m.role, content: m.content, options, agent_key: m.agent_key, created_at: m.created_at };
}

function ownConversation(userId, kind, id) {
  return db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ? AND kind = ?').get(id, userId, kind);
}

function createConversation(userId, kind) {
  const info = db.prepare('INSERT INTO conversations(user_id, kind, title, created_at) VALUES(?, ?, ?, ?)')
    .run(userId, kind, '新对话', nowLocal());
  return db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
}

r.get('/conv/:kind', requireStudent, (req, res) => {
  kindOf(req);
  const kind = req.params.kind;
  const list = db.prepare('SELECT id, title, created_at FROM conversations WHERE user_id = ? AND kind = ? ORDER BY id DESC LIMIT 30')
    .all(req.user.id, kind);
  const conv = req.query.id ? ownConversation(req.user.id, kind, Number(req.query.id)) : (list[0] ? ownConversation(req.user.id, kind, list[0].id) : null);
  if (req.query.id && !conv) throw new AppError(404, 'NOT_FOUND', '没有找到这段对话。');
  const messages = conv ? db.prepare('SELECT * FROM messages WHERE conv_id = ? ORDER BY id').all(conv.id).map(publicMessage) : [];
  res.json({ conversation: conv, messages, pending: conv ? pending.has(conv.id) : false, list, mock: getLlmConfig().mock });
});

r.post('/conv/:kind/new', requireStudent, (req, res) => {
  kindOf(req);
  res.json({ conversation: createConversation(req.user.id, req.params.kind) });
});

r.post('/conv/:kind/send', requireStudent, sendLimit, async (req, res) => {
  const k = kindOf(req);
  const kind = req.params.kind;
  const user = req.user;
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) throw new AppError(400, 'EMPTY', '请输入内容或点选一个选项。');
  if (text.length > 2000) throw new AppError(400, 'TOO_LONG', '一次最多输入2000字，可以分几次说。');

  // 本次请求冻结导师：请求发出后切换导师，只影响之后的轮次
  const agentKey = k.agents.includes(req.body?.agent_key) ? req.body.agent_key : k.defaultAgent(user);

  // 科研边界先判：撞到边界就根本不涉及模型，也就不该因为「没绑 Key」把学生挡在门外，
  // 该他看到的是那句礼貌拒绝，而不是“去设置 Key”。
  const boundaryHit = k.boundary ? checkResearchBoundary(text) : null;

  let conv = req.body?.conv_id ? ownConversation(user.id, kind, Number(req.body.conv_id)) : null;
  if (req.body?.conv_id && !conv) throw new AppError(404, 'NOT_FOUND', '没有找到这段对话。');
  if (conv && pending.has(conv.id)) throw new AppError(409, 'BUSY', '上一条回复还在生成中，请稍等。');

  // 先确定用哪把 Key：额度不足或缺少 Key 时直接返回提示，前端保留已输入的内容。
  // 被边界拦下的请求不碰模型，跳过这一步。
  const llm = getLlmConfig();
  const { key, source } = boundaryHit ? { key: '', source: null } : resolveKey(user, k.moduleId, req.get('X-User-Key'));

  if (!conv) conv = createConversation(user.id, kind);
  const convId = conv.id;
  pending.add(convId);

  const history = db.prepare('SELECT role, content FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?')
    .all(convId, HISTORY_LIMIT).reverse();
  const userMsg = db.prepare('INSERT INTO messages(conv_id, role, content, created_at) VALUES(?, ?, ?, ?)')
    .run(convId, 'user', text, nowLocal());
  if (conv.title === '新对话') db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(text.replace(/^【选择】[A-Z]：/, '').slice(0, 20), convId);

  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let open = true;
  res.on('close', () => { open = false; });
  const emit = (event, data) => {
    if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  emit('meta', { conv_id: convId, user_message_id: Number(userMsg.lastInsertRowid), agent_key: agentKey, mock: llm.mock });

  try {
    // 科研边界：写作、润色、翻译成稿、投稿建议、排版、学术不端类请求直接拦下，不调用模型（不浪费学生 token）
    if (boundaryHit) {
      const body = boundaryHit.reply;
      const block = { options: boundaryHit.options, multi: false, free_text: true, stage_done: false };
      emit('delta', { text: body });
      const info = db.prepare('INSERT INTO messages(conv_id, role, content, options_json, created_at, agent_key) VALUES(?, ?, ?, ?, ?, ?)')
        .run(convId, 'assistant', body, JSON.stringify(block), nowLocal(), agentKey);
      // 这次请求没有调用模型，只留一条“被拦下”的痕迹：ok=0 不会被算进任何用量统计
      recordCall({ userId: user.id, kind: k.moduleId, purpose: k.purpose, model: 'boundary', source, usage: null, ok: false, error: `blocked:${boundaryHit.kind}` });
      emit('done', { message: publicMessage(db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid)), boundary: boundaryHit.kind });
      return;
    }
    // 导师工坊：只读已发布版本的角色卡补充、经验库与资料片段
    const rt = mentorRuntime(agentKey, text);
    const messages = [
      { role: 'system', content: k.systemPrompt(user, agentKey) + (rt.block ? `

${rt.block}` : '') },
      ...history.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ];
    // 择校对话：学生贴了官网链接时先读取页面正文，作为本轮的参考资料（单页、不递归、防内网地址）
    if (k.fetchLinks) {
      const pages = await readLinks(text);
      if (pages) messages.splice(messages.length - 1, 0, { role: 'system', content: pages });
    }
    // 科研检索：先跑一次真实检索，把结果交给模型，它只能从这批里挑（防止编造文献）
    if (k.researchSearch) {
      const found = await runResearchSearch(text);
      if (found) messages.splice(messages.length - 1, 0, { role: 'system', content: found });
    }
    const out = await streamChat({
      baseUrl: llm.baseUrl, key, model: llm.chatModel, messages, source,
      onDelta: (t) => emit('delta', { text: t }),
    });
    const { body, block } = splitReply(out.content);
    const cited = citedSources(body, rt.sources);
    const info = db.prepare('INSERT INTO messages(conv_id, role, content, options_json, created_at, agent_key) VALUES(?, ?, ?, ?, ?, ?)')
      .run(convId, 'assistant', body || '（这次没有生成内容，请再试一次。）', (block || cited.length) ? JSON.stringify({ ...(block || { options: [], multi: false, free_text: true }), ...(cited.length ? { sources: cited } : {}) }) : null, nowLocal(), agentKey);
    recordCall({ userId: user.id, kind: k.moduleId, purpose: k.purpose, model: out.model, source, usage: out.usage, error: out.usage?.estimated ? 'usage_estimated' : null });
    const saved = db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);

    // M9 长期记忆：陪伴导师每2条消息整理一次（在同一次请求里完成，失败不影响本轮回复）
    if (kind === 'companion') {
      try {
        const count = userMessageCount(user.id, kind);
        if (count > 0 && count % 2 === 0) {
          const recent = [
            ...history.slice(-6).map((m) => `${m.role === 'user' ? '学生' : '导师'}：${m.content.replace(/\n+/g, ' ').slice(0, 200)}`),
            `学生：${text.slice(0, 300)}`,
            `导师：${(body || '').replace(/\n+/g, ' ').slice(0, 300)}`,
          ].join('\n');
          emit('memory', { organizing: true });
          const result = await organizeMemory({ user, kind, agentKey, recent });
          if (result.added || result.removed) emit('memory', { added: result.added, removed: result.removed });
        }
      } catch (e) {
        console.warn('[记忆] 本轮整理跳过：', e?.message);
      }
    }

    emit('done', { message: publicMessage(saved) });
  } catch (e) {
    // 失败：撤回本轮用户消息，前端把原文放回输入框，避免重试时重复
    db.prepare('DELETE FROM messages WHERE id = ?').run(userMsg.lastInsertRowid);
    const code = e instanceof AppError ? e.code : 'INTERNAL';
    const message = e instanceof AppError ? e.message : '出了点问题，请稍后重试。';
    if (!(e instanceof AppError)) console.error('[对话] 未预期的错误：', redact(e?.stack || e));
    recordCall({ userId: user.id, kind: k.moduleId, purpose: k.purpose, model: llm.chatModel, source, usage: null, ok: false, error: code });
    emit('error', { code, message, restore_text: text });
  } finally {
    pending.delete(convId);
    if (open) res.end();
  }
});

export default r;
