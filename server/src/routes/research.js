// M11 学术进阶与 M12 知识库接口
import { Router } from 'express';
import { rememberDraft, recordAdoption, logAction } from '../trace.js';
import { db } from '../db.js';
import { nowLocal, todayLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent, rateLimit } from '../auth.js';
import { searchWorks, verifyWork, lookupDoi, getWork } from '../research/works.js';
import { extractPdfText, guessTitle } from '../research/pdf.js';
import { parseAuto, decodeText, toBibtex, toRis, toCsv, cardToMarkdown } from '../research/formats.js';
import { makeZip } from '../research/zip.js';
import { checkResearchBoundary } from '../research/boundary.js';
import { setFlowStatus, flowStatusOf } from '../stations.js';
import { renderPrompt, commonRules, verifiedMaterials, userBrief } from '../prompts.js';
import { getAgent, displayName } from '../registry.js';
import { resolveKey } from '../llm/keys.js';
import { generateJson } from '../llm/json.js';

const r = Router();
const searchLimit = rateLimit({ windowMs: 60 * 1000, max: 20, key: (req) => `research:${req.user?.id}` });
const importLimit = rateLimit({ windowMs: 60 * 1000, max: 10, key: (req) => `kbi:${req.user?.id}` });

// ---------- 论文（papers） ----------

function publicPaper(p) {
  if (!p) return null;
  return {
    id: p.id,
    title: p.title,
    authors: p.authors_json ? JSON.parse(p.authors_json) : [],
    year: p.year,
    venue: p.venue || '',
    doi: p.doi || '',
    url: p.url || '',
    abstract: p.abstract || '',
    lang: p.lang || '',
    source: p.source || '',
    verify_status: p.verify_status || 'unverified',
    verify_info: p.verify_info ? JSON.parse(p.verify_info) : null,
    read_status: p.read_status || 'unread',
    topic_id: p.topic_id || null,
    tags: p.tags_json ? JSON.parse(p.tags_json) : [],
    has_fulltext: !!p.fulltext,
    created_at: p.created_at,
  };
}

function ownPaper(userId, id) {
  return db.prepare('SELECT * FROM papers WHERE id = ? AND user_id = ?').get(Number(id), userId);
}

function insertPaper(userId, it, extra = {}) {
  const info = db.prepare(`INSERT INTO papers(user_id, title, authors_json, year, venue, doi, url, abstract, lang, source,
    verify_status, verify_info, read_status, topic_id, tags_json, fulltext, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    userId, String(it.title || '').slice(0, 400),
    JSON.stringify(Array.isArray(it.authors) ? it.authors.slice(0, 30) : []),
    it.year || null, String(it.venue || '').slice(0, 200),
    String(it.doi || '').slice(0, 120), String(it.url || '').slice(0, 500),
    String(it.abstract || '').slice(0, 5000), String(it.lang || '').slice(0, 20),
    String(it.source || 'manual').slice(0, 20),
    extra.verify_status || 'unverified',
    extra.verify_info ? JSON.stringify(extra.verify_info) : null,
    extra.read_status || 'unread', extra.topic_id || null,
    JSON.stringify(it.tags || []),
    String(extra.fulltext || '').slice(0, 60000),
    nowLocal());
  return publicPaper(db.prepare('SELECT * FROM papers WHERE id = ?').get(info.lastInsertRowid));
}

/** 去重键：有 DOI 用 DOI，否则用规范化题名 */
function dupKey(it) {
  if (it.doi) return `doi:${String(it.doi).toLowerCase()}`;
  return `title:${String(it.title || '').replace(/[\s\p{P}]/gu, '').toLowerCase()}`;
}

function existingKeys(userId) {
  const rows = db.prepare('SELECT title, doi FROM papers WHERE user_id = ?').all(userId);
  return new Set(rows.map(dupKey));
}

// ---------- 检索（不调用大模型，人人可用） ----------

r.post('/papers/search', requireStudent, searchLimit, async (req, res) => {
  const out = await searchWorks({
    query: req.body?.query,
    limit: Number(req.body?.limit) || 10,
    yearFrom: req.body?.year_from || null,
    yearTo: req.body?.year_to || null,
    lang: req.body?.lang || '',
  });
  // 标出哪些已经在知识库里
  const keys = existingKeys(req.user.id);
  const rows = out.works.map((w) => ({ ...w, in_library: keys.has(dupKey(w)) }));
  res.json({ ...out, works: rows, mock_hint: '检索结果来自 OpenAlex，不是模型生成的。' });
});

r.get('/papers/work/:id', requireStudent, async (req, res) => {
  res.json({ work: await getWork(req.params.id) });
});

/** DOI 列表补全（导入前预览） */
r.post('/papers/doi-preview', requireStudent, searchLimit, async (req, res) => {
  const dois = Array.isArray(req.body?.dois) ? req.body.dois.slice(0, 20) : [];
  if (!dois.length) throw new AppError(400, 'EMPTY', '请提供 DOI 列表。');
  const out = [];
  for (const d of dois) {
    try {
      const got = await lookupDoi(d);
      out.push(got.found ? { ok: true, ...got } : { ok: false, doi: got.doi });
    } catch (e) {
      out.push({ ok: false, doi: d, error: e.message });
    }
  }
  res.json({ items: out });
});

// ---------- 核验 ----------

r.post('/papers/:id/verify', requireStudent, async (req, res) => {
  const p = ownPaper(req.user.id, req.params.id);
  if (!p) throw new AppError(404, 'NOT_FOUND', '知识库里没有这篇文献。');
  const out = await verifyWork({ doi: p.doi, title: p.title, authors: p.authors_json ? JSON.parse(p.authors_json) : [] });
  // 核验通过且拿得到元数据时，补全缺失字段（不覆盖学生已填的题名）
  const patch = { verify_status: out.status, verify_info: JSON.stringify(out) };
  const rec = out.record || null;
  if (rec) {
    if (!p.doi && rec.doi) patch.doi = rec.doi;
    if (!p.year && rec.year) patch.year = rec.year;
    if (!p.venue && rec.venue) patch.venue = rec.venue;
    if (!p.url && rec.url) patch.url = rec.url;
    if (!p.abstract && rec.abstract) patch.abstract = String(rec.abstract).slice(0, 5000);
  }
  const keys = Object.keys(patch);
  db.prepare(`UPDATE papers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), p.id);
  logAction(req.user.id, 'paper', p.id, 'verify');
  res.json({ paper: publicPaper(db.prepare('SELECT * FROM papers WHERE id = ?').get(p.id)), result: out });
});

r.post('/papers/verify-batch', requireStudent, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 20) : [];
  if (!ids.length) throw new AppError(400, 'EMPTY', '请选择要核验的文献。');
  const out = [];
  for (const id of ids) {
    const p = ownPaper(req.user.id, id);
    if (!p) { out.push({ id, status: 'not_found' }); continue; }
    try {
      const v = await verifyWork({ doi: p.doi, title: p.title, authors: p.authors_json ? JSON.parse(p.authors_json) : [] });
      db.prepare('UPDATE papers SET verify_status = ?, verify_info = ? WHERE id = ?').run(v.status, JSON.stringify(v), id);
      logAction(req.user.id, 'paper', id, 'verify');
      out.push({ id, status: v.status, reason: v.reason });
    } catch (e) {
      out.push({ id, status: 'error', reason: e.message });
    }
  }
  res.json({ results: out, papers: db.prepare('SELECT * FROM papers WHERE user_id = ? ORDER BY id DESC').all(req.user.id).map(publicPaper) });
});

// ---------- 文献增删改 ----------

r.get('/papers', requireStudent, (req, res) => {
  const rows = db.prepare('SELECT * FROM papers WHERE user_id = ? ORDER BY id DESC LIMIT 500').all(req.user.id);
  res.json({ papers: rows.map(publicPaper) });
});

/** 从检索结果加入知识库 */
r.post('/papers', requireStudent, (req, res) => {
  const b = req.body || {};
  const it = {
    title: b.title, authors: b.authors, year: b.year, venue: b.venue, doi: b.doi,
    url: b.url, abstract: b.abstract, lang: b.lang, source: b.source || 'manual', tags: b.tags,
  };
  if (!String(it.title || '').trim()) throw new AppError(400, 'NO_TITLE', '请填写文献题目。');
  const keys = existingKeys(req.user.id);
  if (keys.has(dupKey(it))) {
    const dup = db.prepare('SELECT * FROM papers WHERE user_id = ?').all(req.user.id).find((p) => dupKey({ title: p.title, doi: p.doi }) === dupKey(it));
    return res.json({ paper: publicPaper(dup), duplicated: true });
  }
  const paper = insertPaper(req.user.id, it, { verify_status: 'unverified', fulltext: b.fulltext });
  if (flowStatusOf(req.user.id, 7) === 'not_started') setFlowStatus(req.user.id, 7, 'in_progress');
  res.json({ paper, duplicated: false });
});

r.put('/papers/:id', requireStudent, (req, res) => {
  const p = ownPaper(req.user.id, req.params.id);
  if (!p) throw new AppError(404, 'NOT_FOUND', '知识库里没有这篇文献。');
  const b = req.body || {};
  const patch = {};
  if (b.title !== undefined) patch.title = String(b.title).slice(0, 400);
  if (b.authors !== undefined) patch.authors_json = JSON.stringify(Array.isArray(b.authors) ? b.authors.slice(0, 30) : []);
  if (b.year !== undefined) patch.year = b.year ? Number(b.year) : null;
  if (b.venue !== undefined) patch.venue = String(b.venue).slice(0, 200);
  if (b.doi !== undefined) patch.doi = String(b.doi).slice(0, 120);
  if (b.url !== undefined) patch.url = String(b.url).slice(0, 500);
  if (b.abstract !== undefined) patch.abstract = String(b.abstract).slice(0, 5000);
  if (b.tags !== undefined) patch.tags_json = JSON.stringify(Array.isArray(b.tags) ? b.tags.slice(0, 10) : []);
  if (b.topic_id !== undefined) patch.topic_id = b.topic_id ? Number(b.topic_id) : null;
  if (b.read_status !== undefined) patch.read_status = String(b.read_status).slice(0, 20);
  if (b.fulltext !== undefined) patch.fulltext = String(b.fulltext).slice(0, 60000);
  const keys = Object.keys(patch);
  if (keys.length) db.prepare(`UPDATE papers SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), p.id);
  res.json({ paper: publicPaper(db.prepare('SELECT * FROM papers WHERE id = ?').get(p.id)) });
});

r.delete('/papers/:id', requireStudent, (req, res) => {
  const info = db.prepare('DELETE FROM papers WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '知识库里没有这篇文献。');
  res.json({ ok: true });
});

// ---------- PDF 上传（只提取文字，不保存原件） ----------

r.post('/papers/pdf', requireStudent, rateLimit({ windowMs: 60 * 1000, max: 6, key: (req) => `pdf:${req.user?.id}` }),
  async (req, res) => {
    const b64 = String(req.body?.data || '');
    if (!b64) throw new AppError(400, 'NO_FILE', '没有收到文件。');
    const buf = Buffer.from(b64.replace(/^data:.*?;base64,/, ''), 'base64');
    const out = await extractPdfText(buf);
    // 提取完即丢弃原件：平台不留存 PDF
    res.json({
      ...out,
      suggested_title: guessTitle(out.text, String(req.body?.filename || '').replace(/\.pdf$/i, '')),
      note: out.note || '已提取正文，原件不会被保存。',
    });
  });

// ---------- 阅读卡 ----------

function publicCard(c) {
  if (!c) return null;
  return {
    id: c.id, paper_id: c.paper_id,
    question: c.question || '', method: c.method || '', evidence: c.evidence || '',
    conclusion: c.conclusion || '', limitation: c.limitation || '',
    my_judgment: c.my_judgment || '',
    doubts: c.doubts ? JSON.parse(c.doubts) : [],
    ai_note: c.ai_note || '', created_at: c.created_at, updated_at: c.updated_at,
  };
}

r.get('/cards', requireStudent, (req, res) => {
  const rows = db.prepare('SELECT * FROM reading_cards WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.user.id);
  const papers = new Map(db.prepare('SELECT id, title, year, verify_status FROM papers WHERE user_id = ?').all(req.user.id).map((p) => [p.id, p]));
  res.json({ cards: rows.map((c) => ({ ...publicCard(c), paper: papers.get(c.paper_id) || null })) });
});

r.post('/cards', requireStudent, (req, res) => {
  const b = req.body || {};
  const paperId = b.paper_id ? Number(b.paper_id) : null;
  if (paperId && !ownPaper(req.user.id, paperId)) throw new AppError(404, 'NO_PAPER', '知识库里没有这篇文献。');
  // 阅读卡的“我的判断”只能由学生自己写：AI 起草的字段单独放，不要混进这一栏
  const info = db.prepare(`INSERT INTO reading_cards(user_id, paper_id, question, method, evidence, conclusion,
    limitation, my_judgment, doubts, ai_note, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.user.id, paperId,
    String(b.question || '').slice(0, 2000), String(b.method || '').slice(0, 2000),
    String(b.evidence || '').slice(0, 2000), String(b.conclusion || '').slice(0, 2000),
    String(b.limitation || '').slice(0, 2000), String(b.my_judgment || '').slice(0, 2000),
    JSON.stringify(Array.isArray(b.doubts) ? b.doubts.slice(0, 10) : []),
    String(b.ai_note || '').slice(0, 300), nowLocal());
  const now = nowLocal();
  db.prepare('INSERT INTO reading_logs(user_id, date, paper_id, minutes, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(req.user.id, todayLocal(), paperId, Math.max(0, Math.min(600, Number(b.minutes) || 0)), now);
  if (paperId) db.prepare("UPDATE papers SET read_status = 'read' WHERE id = ?").run(paperId);
  res.json({ card: publicCard(db.prepare('SELECT * FROM reading_cards WHERE id = ?').get(info.lastInsertRowid)) });
});

r.put('/cards/:id', requireStudent, (req, res) => {
  const c = db.prepare('SELECT * FROM reading_cards WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!c) throw new AppError(404, 'NOT_FOUND', '没有这张阅读卡。');
  const b = req.body || {};
  const patch = {};
  for (const k of ['question', 'method', 'evidence', 'conclusion', 'limitation', 'my_judgment']) {
    if (b[k] !== undefined) patch[k] = String(b[k]).slice(0, 2000);
  }
  if (b.doubts !== undefined) patch.doubts = JSON.stringify(Array.isArray(b.doubts) ? b.doubts.slice(0, 10) : []);
  if (b.paper_id !== undefined) patch.paper_id = b.paper_id ? Number(b.paper_id) : null;
  patch.updated_at = nowLocal();
  const keys = Object.keys(patch);
  db.prepare(`UPDATE reading_cards SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), c.id);
  res.json({ card: publicCard(db.prepare('SELECT * FROM reading_cards WHERE id = ?').get(c.id)) });
});

r.delete('/cards/:id', requireStudent, (req, res) => {
  const info = db.prepare('DELETE FROM reading_cards WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '没有这张阅读卡。');
  res.json({ ok: true });
});

/** 阅读打卡（与学习打卡共用入口，单独统计） */
r.post('/reading-log', requireStudent, (req, res) => {
  const minutes = Math.max(0, Math.min(600, Number(req.body?.minutes) || 0));
  const paperId = req.body?.paper_id ? Number(req.body.paper_id) : null;
  db.prepare('INSERT INTO reading_logs(user_id, date, paper_id, minutes, created_at) VALUES(?, ?, ?, ?, ?)')
    .run(req.user.id, todayLocal(), paperId, minutes, nowLocal());
  res.json({ ok: true });
});

r.get('/reading-log', requireStudent, (req, res) => {
  const row = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(minutes),0) AS minutes FROM reading_logs
    WHERE user_id = ? AND date >= ?`).get(req.user.id, addDaysLocal(-6));
  const total = db.prepare('SELECT COUNT(*) AS n FROM reading_logs WHERE user_id = ?').get(req.user.id).n;
  res.json({ last7: { entries: row.n, minutes: row.minutes }, total });
});

function addDaysLocal(n) {
  const d = new Date(`${todayLocal()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------- 主题与选题卡 ----------

r.get('/topics', requireStudent, (req, res) => {
  const rows = db.prepare('SELECT * FROM topics WHERE user_id = ? ORDER BY id').all(req.user.id);
  const counts = db.prepare('SELECT topic_id, COUNT(*) AS n FROM papers WHERE user_id = ? AND topic_id IS NOT NULL GROUP BY topic_id').all(req.user.id);
  const map = new Map(counts.map((c) => [c.topic_id, c.n]));
  res.json({ topics: rows.map((t) => ({ id: t.id, name: t.name, parent_id: t.parent_id, description: t.description || '', paper_count: map.get(t.id) || 0 })) });
});

r.post('/topics', requireStudent, (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) throw new AppError(400, 'NO_NAME', '请填写主题名称。');
  const info = db.prepare('INSERT INTO topics(user_id, name, parent_id, description) VALUES(?, ?, ?, ?)')
    .run(req.user.id, name.slice(0, 100), req.body?.parent_id ? Number(req.body.parent_id) : null, String(req.body?.description || '').slice(0, 300));
  res.json({ topic: db.prepare('SELECT * FROM topics WHERE id = ?').get(info.lastInsertRowid) });
});

r.delete('/topics/:id', requireStudent, (req, res) => {
  const info = db.prepare('DELETE FROM topics WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '没有这个主题。');
  db.prepare('UPDATE papers SET topic_id = NULL WHERE user_id = ? AND topic_id = ?').run(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

/** 分类导师（M11）：读知识库里的文献与阅读卡，给出主题树、标签与研究空白。
 *  只给建议，不写库；学生确认后再调 /topics/apply 落库。 */
r.post('/topics/suggest', requireStudent, async (req, res) => {
  const u = req.user;
  const papers = db.prepare('SELECT * FROM papers WHERE user_id = ? ORDER BY id').all(u.id);
  if (!papers.length) throw new AppError(400, 'NO_PAPERS', '知识库里还没有文献，先检索或导入几篇再来分类。');
  const cards = db.prepare('SELECT * FROM reading_cards WHERE user_id = ?').all(u.id);
  const cardByPaper = new Map(cards.filter((c) => c.paper_id).map((c) => [c.paper_id, c]));

  // 清单里的编号就是 paper.id，模型只能填这里出现过的编号
  const list = papers.map((p) => {
    const c = cardByPaper.get(p.id);
    const bits = [`id=${p.id}`, `《${p.title}》`, p.year ? `（${p.year}）` : '', p.venue ? ` ${p.venue}` : ''];
    if (c) {
      const cardText = [c.question && `问题：${c.question}`, c.conclusion && `结论：${c.conclusion}`, c.my_judgment && `学生判断：${c.my_judgment}`]
        .filter(Boolean).join('；').slice(0, 300);
      if (cardText) bits.push(`\n    阅读卡：${cardText}`);
    }
    return `- ${bits.join('')}`;
  }).join('\n');

  const { key, source } = resolveKey(u, 'M11_research', req.get('X-User-Key'));
  const agent = getAgent('research_classify');
  const granularity = String(req.body?.granularity || '3层以内，宁少勿多').slice(0, 40);
  const basis = String(req.body?.basis || '研究主题').slice(0, 40);
  const prompt = {
    system: renderPrompt('research_classify', {
      ...userBrief(u),
      导师显示名: displayName(agent),
      共同规则: commonRules(),
      已核实资料: verifiedMaterials(),
      学术进阶边界: renderPrompt('research_bounds', { 知识库概况: `文献 ${papers.length} 篇` }),
      分类粒度: granularity,
      分类依据: basis,
      文献清单: list,
    }),
    user: '请为上面这批文献构建主题树并打标签，指出研究空白。只输出 JSON。',
  };
  const { data } = await generateJson({ user: u, moduleId: 'M11_research', purpose: '文献分类', prompt, key, source, maxTokens: 3000 });
  if (!data?.topics || !Array.isArray(data.topics)) throw new AppError(502, 'BAD_CLASSIFY', '这次分类没成功，请再点一次。');

  // 过滤掉模型编造的 paper_id，只留真实存在的编号
  const mine = new Set(papers.map((p) => p.id));
  const topics = data.topics.slice(0, 40).map((t) => ({
    name: String(t.name || '').slice(0, 100),
    parent: t.parent ? String(t.parent).slice(0, 100) : null,
    desc: String(t.desc || '').slice(0, 300),
    paper_ids: (Array.isArray(t.paper_ids) ? t.paper_ids : []).map(Number).filter((i) => mine.has(i)),
  })).filter((t) => t.name);
  const tags = (Array.isArray(data.tags) ? data.tags : []).map((t) => ({
    paper_id: Number(t.paper_id),
    tags: (Array.isArray(t.tags) ? t.tags : []).map((x) => String(x).slice(0, 30)).slice(0, 8),
  })).filter((t) => mine.has(t.paper_id));
  const gaps = (Array.isArray(data.gaps) ? data.gaps : []).slice(0, 10).map((g) => ({
    desc: String(g.desc || '').slice(0, 300),
    evidence_ids: (Array.isArray(g.evidence_ids) ? g.evidence_ids : []).map(Number).filter((i) => mine.has(i)),
  }));

  res.json({ topics, tags, gaps, papers_count: papers.length });
});

/** 分类：把整棵主题树一次性写入（AI 建议 + 学生确认后的结果） */r.post('/topics/apply', requireStudent, (req, res) => {
  const topics = Array.isArray(req.body?.topics) ? req.body.topics.slice(0, 40) : [];
  if (!topics.length) throw new AppError(400, 'EMPTY', '没有可应用的主题。');
  const mine = new Set(db.prepare('SELECT id FROM papers WHERE user_id = ?').all(req.user.id).map((p) => p.id));
  const byName = new Map();
  // 先建顶层，再建子层
  const created = [];
  for (const t of topics.filter((x) => !x.parent)) {
    const name = String(t.name || '').trim().slice(0, 100);
    if (!name) continue;
    const info = db.prepare('INSERT INTO topics(user_id, name, parent_id, description) VALUES(?, ?, NULL, ?)')
      .run(req.user.id, name, String(t.desc || '').slice(0, 300));
    byName.set(name, Number(info.lastInsertRowid));
    created.push({ name, id: Number(info.lastInsertRowid), paper_ids: (t.paper_ids || []).filter((i) => mine.has(Number(i))) });
  }
  for (const t of topics.filter((x) => x.parent)) {
    const name = String(t.name || '').trim().slice(0, 100);
    const parentId = byName.get(String(t.parent || '')) || null;
    if (!name) continue;
    const info = db.prepare('INSERT INTO topics(user_id, name, parent_id, description) VALUES(?, ?, ?, ?)')
      .run(req.user.id, name, parentId, String(t.desc || '').slice(0, 300));
    created.push({ name, id: Number(info.lastInsertRowid), paper_ids: (t.paper_ids || []).filter((i) => mine.has(Number(i))) });
  }
  let tagged = 0;
  const upd = db.prepare('UPDATE papers SET topic_id = ? WHERE id = ? AND user_id = ?');
  for (const t of created) {
    for (const pid of t.paper_ids) {
      const info = upd.run(t.id, Number(pid), req.user.id);
      tagged += info.changes;
    }
  }
  // 标签
  let tagCount = 0;
  for (const row of Array.isArray(req.body?.tags) ? req.body.tags.slice(0, 200) : []) {
    const pid = Number(row.paper_id);
    if (!mine.has(pid)) continue;
    const tags = Array.isArray(row.tags) ? row.tags.map((x) => String(x).slice(0, 30)).slice(0, 8) : [];
    if (!tags.length) continue;
    db.prepare('UPDATE papers SET tags_json = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(tags), pid, req.user.id);
    tagCount += 1;
  }
  res.json({ topics: created.length, tagged, tags: tagCount });
});

r.get('/ideas', requireStudent, (req, res) => {
  const rows = db.prepare('SELECT * FROM topic_ideas WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json({
    ideas: rows.map((x) => ({
      id: x.id, question: x.question || '', significance: x.significance || '', feasibility: x.feasibility || '',
      method: x.method || '', risks: x.risks || '',
      paper_ids: x.paper_ids_json ? JSON.parse(x.paper_ids_json) : [],
      status: x.status || 'candidate', drop_reason: x.drop_reason || '', created_at: x.created_at,
    })),
  });
});

r.post('/ideas', requireStudent, (req, res) => {
  const b = req.body || {};
  const question = String(b.question || '').trim();
  if (!question) throw new AppError(400, 'NO_QUESTION', '请填写研究问题。');
  const info = db.prepare(`INSERT INTO topic_ideas(user_id, question, significance, feasibility, method, risks, paper_ids_json, status, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, 'candidate', ?)`).run(
    req.user.id, question.slice(0, 500), String(b.significance || '').slice(0, 1000),
    String(b.feasibility || '').slice(0, 1000), String(b.method || '').slice(0, 1000),
    String(b.risks || '').slice(0, 1000),
    JSON.stringify(Array.isArray(b.paper_ids) ? b.paper_ids.slice(0, 30) : []), nowLocal());
  if (flowStatusOf(req.user.id, 8) === 'not_started') setFlowStatus(req.user.id, 8, 'in_progress');
  res.json({ idea: db.prepare('SELECT * FROM topic_ideas WHERE id = ?').get(info.lastInsertRowid) });
});

r.put('/ideas/:id', requireStudent, (req, res) => {
  const idea = db.prepare('SELECT * FROM topic_ideas WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!idea) throw new AppError(404, 'NOT_FOUND', '没有这张选题卡。');
  const b = req.body || {};
  const patch = {};
  for (const k of ['question', 'significance', 'feasibility', 'method', 'risks', 'drop_reason']) {
    if (b[k] !== undefined) patch[k] = String(b[k]).slice(0, 1000);
  }
  if (b.status !== undefined) patch.status = ['candidate', 'chosen', 'dropped'].includes(b.status) ? b.status : 'candidate';
  if (b.paper_ids !== undefined) patch.paper_ids_json = JSON.stringify(Array.isArray(b.paper_ids) ? b.paper_ids.slice(0, 30) : []);
  const keys = Object.keys(patch);
  if (keys.length) db.prepare(`UPDATE topic_ideas SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), idea.id);
  res.json({ idea: db.prepare('SELECT * FROM topic_ideas WHERE id = ?').get(idea.id) });
});

export default r;
