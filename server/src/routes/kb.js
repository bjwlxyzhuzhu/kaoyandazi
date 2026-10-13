// M12 个人知识库：备考空间、导入导出、考核用知识库报告
import { Router } from 'express';
import { db } from '../db.js';
import { nowLocal, todayLocal } from '../time.js';
import { AppError } from '../errors.js';
import { requireStudent, rateLimit } from '../auth.js';
import { parseAuto, decodeText, toBibtex, toRis, toCsv, cardToMarkdown } from '../research/formats.js';
import { makeZip } from '../research/zip.js';
import { lookupDoi } from '../research/works.js';
import { setFlowStatus, flowStatusOf } from '../stations.js';

const r = Router();
const importLimit = rateLimit({ windowMs: 60 * 1000, max: 10, key: (req) => `kbi:${req.user?.id}` });

const SPACES = ['prep', 'research'];
const TYPES = ['knowledge', 'mistake', 'note'];
const MISTAKE_CAUSES = ['概念不清', '方法不会', '审题失误', '计算失误', '记忆遗忘', '其他'];

function publicItem(x) {
  return {
    id: x.id, space: x.space, type: x.type, title: x.title || '',
    content: x.content_json ? JSON.parse(x.content_json) : {},
    tags: x.tags_json ? JSON.parse(x.tags_json) : [],
    mastery: x.mastery, created_at: x.created_at, updated_at: x.updated_at,
  };
}

function ownItem(userId, id) {
  return db.prepare('SELECT * FROM kb_items WHERE id = ? AND user_id = ?').get(Number(id), userId);
}

// ---------- 条目 ----------

r.get('/kb/items', requireStudent, (req, res) => {
  const space = SPACES.includes(String(req.query.space)) ? String(req.query.space) : null;
  const type = TYPES.includes(String(req.query.type)) ? String(req.query.type) : null;
  const q = String(req.query.q || '').trim();
  let sql = 'SELECT * FROM kb_items WHERE user_id = ?';
  const args = [req.user.id];
  if (space) { sql += ' AND space = ?'; args.push(space); }
  if (type) { sql += ' AND type = ?'; args.push(type); }
  sql += ' ORDER BY id DESC LIMIT 300';
  let rows = db.prepare(sql).all(...args).map(publicItem);
  if (q) {
    const needle = q.toLowerCase();
    rows = rows.filter((x) => x.title.toLowerCase().includes(needle)
      || JSON.stringify(x.content).toLowerCase().includes(needle)
      || x.tags.join(' ').toLowerCase().includes(needle));
  }
  const stats = {
    total: db.prepare('SELECT COUNT(*) AS n FROM kb_items WHERE user_id = ?').get(req.user.id).n,
    prep: db.prepare("SELECT COUNT(*) AS n FROM kb_items WHERE user_id = ? AND space = 'prep'").get(req.user.id).n,
    research: db.prepare("SELECT COUNT(*) AS n FROM kb_items WHERE user_id = ? AND space = 'research'").get(req.user.id).n,
    mistakes: db.prepare("SELECT COUNT(*) AS n FROM kb_items WHERE user_id = ? AND type = 'mistake'").get(req.user.id).n,
  };
  res.json({ items: rows, stats, mistake_causes: MISTAKE_CAUSES });
});

function validateItem(space, type, content) {
  const c = content && typeof content === 'object' ? content : {};
  if (type === 'mistake') {
    const cause = String(c.cause || '').trim();
    if (cause && !MISTAKE_CAUSES.includes(cause)) throw new AppError(400, 'BAD_CAUSE', `错因要从这些里选：${MISTAKE_CAUSES.join(' / ')}`);
    return {
      summary: String(c.summary || '').slice(0, 1000),
      cause: cause,
      correction: String(c.correction || '').slice(0, 2000),
      review_count: Math.max(0, Math.min(999, Number(c.review_count) || 0)),
      source: String(c.source || '').slice(0, 200),
    };
  }
  if (type === 'knowledge') {
    return {
      outline: String(c.outline || '').slice(0, 200),
      detail: String(c.detail || '').slice(0, 3000),
      source: String(c.source || '').slice(0, 200),
    };
  }
  return { body: String(c.body || '').slice(0, 4000), source: String(c.source || '').slice(0, 200) };
}

r.post('/kb/items', requireStudent, (req, res) => {
  const b = req.body || {};
  const space = SPACES.includes(b.space) ? b.space : 'prep';
  const type = TYPES.includes(b.type) ? b.type : 'note';
  const title = String(b.title || '').trim();
  if (!title) throw new AppError(400, 'NO_TITLE', '请填写标题。');
  const content = validateItem(space, type, b.content);
  const mastery = type === 'knowledge' ? Math.max(1, Math.min(5, Number(b.mastery) || 1)) : null;
  const info = db.prepare(`INSERT INTO kb_items(user_id, space, type, title, content_json, tags_json, mastery, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
    req.user.id, space, type, title.slice(0, 200), JSON.stringify(content),
    JSON.stringify(Array.isArray(b.tags) ? b.tags.slice(0, 10) : []), mastery, nowLocal());
  if (flowStatusOf(req.user.id, 7) === 'not_started') setFlowStatus(req.user.id, 7, 'in_progress');
  res.json({ item: publicItem(db.prepare('SELECT * FROM kb_items WHERE id = ?').get(info.lastInsertRowid)) });
});

r.put('/kb/items/:id', requireStudent, (req, res) => {
  const x = ownItem(req.user.id, req.params.id);
  if (!x) throw new AppError(404, 'NOT_FOUND', '知识库里没有这条。');
  const b = req.body || {};
  const patch = { updated_at: nowLocal() };
  if (b.title !== undefined) patch.title = String(b.title).slice(0, 200);
  if (b.content !== undefined) patch.content_json = JSON.stringify(validateItem(x.space, x.type, b.content));
  if (b.tags !== undefined) patch.tags_json = JSON.stringify(Array.isArray(b.tags) ? b.tags.slice(0, 10) : []);
  if (b.mastery !== undefined) patch.mastery = Math.max(1, Math.min(5, Number(b.mastery) || 1));
  const keys = Object.keys(patch);
  db.prepare(`UPDATE kb_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), x.id);
  res.json({ item: publicItem(db.prepare('SELECT * FROM kb_items WHERE id = ?').get(x.id)) });
});

r.delete('/kb/items/:id', requireStudent, (req, res) => {
  const info = db.prepare('DELETE FROM kb_items WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!info.changes) throw new AppError(404, 'NOT_FOUND', '知识库里没有这条。');
  res.json({ ok: true });
});

// ---------- 导入 ----------

function dedupeImport(userId, items) {
  const rows = db.prepare('SELECT title, doi FROM papers WHERE user_id = ?').all(userId);
  const key = (it) => (it.doi ? `doi:${String(it.doi).toLowerCase()}` : `title:${String(it.title || '').replace(/[\s\p{P}]/gu, '').toLowerCase()}`);
  const have = new Set(rows.map(key));
  const ok = [];
  const dup = [];
  for (const it of items) {
    const k = key(it);
    if (have.has(k)) { dup.push(it); continue; }
    have.add(k);
    ok.push(it);
  }
  return { ok, dup };
}

function insertImported(userId, it, verifyStatus = 'unverified') {
  const info = db.prepare(`INSERT INTO papers(user_id, title, authors_json, year, venue, doi, url, abstract, lang, source,
    verify_status, read_status, tags_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', '[]', ?)`).run(
    userId, String(it.title || '').slice(0, 400),
    JSON.stringify(Array.isArray(it.authors) ? it.authors.slice(0, 30) : []),
    it.year || null, String(it.venue || '').slice(0, 200),
    String(it.doi || '').slice(0, 120), String(it.url || '').slice(0, 500),
    String(it.abstract || '').slice(0, 5000), String(it.lang || '').slice(0, 20),
    String(it.source || 'import').slice(0, 20), verifyStatus, nowLocal());
  return Number(info.lastInsertRowid);
}

/**
 * 导入。支持 BibTeX / RIS / EndNote / NoteExpress / RefWorks / CSV / DOI 列表 / 平台 JSON 备份。
 * body: { data: base64 或纯文本, filename, text }
 * 返回成功、重复、失败的报告（PRD M12）。
 */
r.post('/kb/import', requireStudent, importLimit, async (req, res) => {
  const b = req.body || {};
  let text = '';
  if (b.data) {
    const buf = Buffer.from(String(b.data).replace(/^data:.*?;base64,/, ''), 'base64');
    text = decodeText(buf);           // 知网导出的 GBK 在这里自动转成 UTF-8
  } else if (b.text) {
    text = String(b.text);
  } else {
    throw new AppError(400, 'NO_DATA', '没有收到要导入的内容。');
  }
  if (text.length > 5_000_000) throw new AppError(413, 'TOO_LARGE', '文件太大了，请分几次导入。');

  // 平台 JSON 备份
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.includes('"papers"')) {
    let backup;
    try { backup = JSON.parse(trimmed); } catch { throw new AppError(400, 'BAD_JSON', '这个备份文件读不出来，可能已经损坏。'); }
    return res.json(importBackup(req.user.id, backup));
  }
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return res.json(importBackup(req.user.id, { papers: arr }));
    } catch { /* 不是 JSON，继续按文本格式处理 */ }
  }

  const parsed = parseAuto(text, b.filename || '');
  let items = parsed.items;

  // DOI 列表：用 Crossref 补全元数据
  let doiFilled = 0;
  if (parsed.format === 'doi_list') {
    const filled = [];
    for (const it of items) {
      try {
        const got = await lookupDoi(it.doi);
        if (got.found) { filled.push(got); doiFilled += 1; } else filled.push(it);
      } catch { filled.push(it); }
    }
    items = filled;
  }

  const { ok, dup } = dedupeImport(req.user.id, items);
  const ids = ok.map((it) => insertImported(req.user.id, it, parsed.format === 'doi_list' && doiFilled ? 'verified' : 'unverified'));
  if (ids.length && flowStatusOf(req.user.id, 7) === 'not_started') setFlowStatus(req.user.id, 7, 'in_progress');

  res.json({
    format: parsed.format,
    imported: ids.length,
    duplicated: dup.length,
    failed: 0,
    doi_filled: doiFilled,
    report: {
      ok: ok.slice(0, 20).map((it) => it.title || it.doi || '(无题名)'),
      dup: dup.slice(0, 20).map((it) => it.title || it.doi || '(无题名)'),
    },
  });
});

/** 恢复平台 JSON 备份（PRD：JSON 备份能在新账号上完整恢复） */
function importBackup(userId, backup) {
  const papers = Array.isArray(backup.papers) ? backup.papers : [];
  const cards = Array.isArray(backup.cards) ? backup.cards : [];
  const items = Array.isArray(backup.kb_items) ? backup.kb_items : [];
  const ideas = Array.isArray(backup.topic_ideas) ? backup.topic_ideas : [];
  const topics = Array.isArray(backup.topics) ? backup.topics : [];

  // 主题先建，才能把文献挂上去
  const topicMap = new Map();
  for (const t of topics) {
    const info = db.prepare('INSERT INTO topics(user_id, name, parent_id, description) VALUES(?, ?, NULL, ?)')
      .run(userId, String(t.name || '').slice(0, 100), String(t.description || '').slice(0, 300));
    topicMap.set(t.name, Number(info.lastInsertRowid));
  }

  const { ok, dup } = dedupeImport(userId, papers);
  const idMap = new Map();
  for (const p of ok) {
    const newId = insertImported(userId, { ...p, source: 'backup' }, p.verify_status || 'unverified');
    if (p.id) idMap.set(Number(p.id), newId);
    if (p.topic && topicMap.get(p.topic)) db.prepare('UPDATE papers SET topic_id = ? WHERE id = ?').run(topicMap.get(p.topic), newId);
  }

  let cardCount = 0;
  for (const c of cards) {
    const paperId = idMap.get(Number(c.paper_id)) || null;
    db.prepare(`INSERT INTO reading_cards(user_id, paper_id, question, method, evidence, conclusion, limitation,
      my_judgment, doubts, ai_note, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      userId, paperId, String(c.question || '').slice(0, 2000), String(c.method || '').slice(0, 2000),
      String(c.evidence || '').slice(0, 2000), String(c.conclusion || '').slice(0, 2000),
      String(c.limitation || '').slice(0, 2000), String(c.my_judgment || '').slice(0, 2000),
      JSON.stringify(Array.isArray(c.doubts) ? c.doubts.slice(0, 10) : []),
      String(c.ai_note || '').slice(0, 300), c.created_at || nowLocal());
    cardCount += 1;
  }

  let itemCount = 0;
  for (const x of items) {
    db.prepare(`INSERT INTO kb_items(user_id, space, type, title, content_json, tags_json, mastery, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(
      userId, SPACES.includes(x.space) ? x.space : 'prep', TYPES.includes(x.type) ? x.type : 'note',
      String(x.title || '').slice(0, 200), JSON.stringify(x.content || {}),
      JSON.stringify(Array.isArray(x.tags) ? x.tags.slice(0, 10) : []),
      x.mastery ?? null, x.created_at || nowLocal());
    itemCount += 1;
  }

  let ideaCount = 0;
  for (const i of ideas) {
    db.prepare(`INSERT INTO topic_ideas(user_id, question, significance, feasibility, method, risks, paper_ids_json, status, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      userId, String(i.question || '').slice(0, 500), String(i.significance || '').slice(0, 1000),
      String(i.feasibility || '').slice(0, 1000), String(i.method || '').slice(0, 1000),
      String(i.risks || '').slice(0, 1000),
      JSON.stringify((Array.isArray(i.paper_ids) ? i.paper_ids : []).map((x) => idMap.get(Number(x))).filter(Boolean)),
      ['candidate', 'chosen', 'dropped'].includes(i.status) ? i.status : 'candidate', i.created_at || nowLocal());
    ideaCount += 1;
  }

  return {
    format: 'backup',
    imported: ok.length,
    duplicated: dup.length,
    failed: 0,
    report: {
      papers: ok.length, cards: cardCount, kb_items: itemCount, topics: topics.length, topic_ideas: ideaCount,
      dup: dup.slice(0, 20).map((it) => it.title || '(无题名)'),
    },
  };
}

// ---------- 导出 ----------

function collectPapers(userId) {
  return db.prepare('SELECT * FROM papers WHERE user_id = ? ORDER BY id').all(userId).map((p) => ({
    id: p.id, title: p.title,
    authors: p.authors_json ? JSON.parse(p.authors_json) : [],
    year: p.year, venue: p.venue || '', doi: p.doi || '', url: p.url || '',
    abstract: p.abstract || '', lang: p.lang || '', verify_status: p.verify_status || 'unverified',
    tags: p.tags_json ? JSON.parse(p.tags_json) : [],
    topic: p.topic_id ? (db.prepare('SELECT name FROM topics WHERE id = ?').get(p.topic_id)?.name || '') : '',
  }));
}

r.get('/kb/export', requireStudent, (req, res) => {
  const format = String(req.query.format || 'bib').toLowerCase();
  const papers = collectPapers(req.user.id);
  const stamp = todayLocal();
  const send = (filename, type, body, ext) => {
    res.set({
      'Content-Type': type,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.${ext}`,
    });
    res.send(body);
  };

  if (format === 'bib') return send(`${stamp}-文献库`, 'application/x-bibtex; charset=utf-8', toBibtex(papers), 'bib');
  if (format === 'ris') return send(`${stamp}-文献库`, 'text/plain; charset=utf-8', toRis(papers), 'ris');
  if (format === 'csv') return send(`${stamp}-文献库`, 'text/csv; charset=utf-8', toCsv(papers), 'csv');

  if (format === 'md') {
    const cards = db.prepare('SELECT * FROM reading_cards WHERE user_id = ? ORDER BY id').all(req.user.id);
    const paperById = new Map(db.prepare('SELECT * FROM papers WHERE user_id = ?').all(req.user.id).map((p) => [p.id, {
      title: p.title, authors: p.authors_json ? JSON.parse(p.authors_json) : [], year: p.year,
      doi: p.doi, venue: p.venue, verify_status: p.verify_status,
    }]));
    const files = cards.map((c, i) => {
      const paper = c.paper_id ? paperById.get(c.paper_id) : null;
      const card = { ...c, doubts: c.doubts ? JSON.parse(c.doubts) : [] };
      const safe = String(paper?.title || `阅读卡${c.id}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
      return { name: `阅读卡/${String(i + 1).padStart(2, '0')}-${safe}.md`, data: cardToMarkdown(card, paper) };
    });
    if (!files.length) files.push({ name: '阅读卡/README.md', data: '# 还没有阅读卡\n\n去“书房 → 学术进阶”，和阅读导师精读一篇文献就有第一张了。\n' });
    // 附一份文献清单
    files.push({ name: '文献清单.md', data: `# 文献清单（${stamp}）\n\n${papers.map((p, i) => `${i + 1}. ${p.title}${p.year ? `（${p.year}）` : ''}${p.doi ? ` DOI: ${p.doi}` : ''}`).join('\n')}\n` });
    const zip = makeZip(files);
    res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${stamp}-阅读卡`)}.zip` });
    return res.send(zip);
  }

  if (format === 'json') {
    const backup = {
      exported_at: nowLocal(),
      app: '山海问知',
      version: 1,
      papers: collectPapers(req.user.id),
      topics: db.prepare('SELECT * FROM topics WHERE user_id = ?').all(req.user.id).map((t) => ({ name: t.name, description: t.description })),
      cards: db.prepare('SELECT * FROM reading_cards WHERE user_id = ?').all(req.user.id),
      kb_items: db.prepare('SELECT * FROM kb_items WHERE user_id = ?').all(req.user.id).map(publicItem),
      topic_ideas: db.prepare('SELECT * FROM topic_ideas WHERE user_id = ?').all(req.user.id).map((x) => ({
        question: x.question, significance: x.significance, feasibility: x.feasibility,
        method: x.method, risks: x.risks, status: x.status,
        paper_ids: x.paper_ids_json ? JSON.parse(x.paper_ids_json) : [], created_at: x.created_at,
      })),
    };
    return send(`${stamp}-知识库备份`, 'application/json; charset=utf-8', JSON.stringify(backup, null, 1), 'json');
  }

  throw new AppError(400, 'BAD_FORMAT', '支持的导出格式：bib、ris、csv、md、json。');
});

// ---------- 考核用知识库报告（M12 验收：统计 + 精选条目） ----------

r.get('/kb/report', requireStudent, (req, res) => {
  const u = req.user;
  const papers = collectPapers(u.id);
  const cards = db.prepare('SELECT * FROM reading_cards WHERE user_id = ?').all(u.id);
  const items = db.prepare('SELECT * FROM kb_items WHERE user_id = ?').all(u.id).map(publicItem);
  const mistakes = items.filter((x) => x.type === 'mistake');
  const causeCount = {};
  for (const m of mistakes) {
    const c = m.content.cause || '未填';
    causeCount[c] = (causeCount[c] || 0) + 1;
  }
  const verified = papers.filter((p) => p.verify_status === 'verified').length;
  const readingMinutes = db.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM reading_logs WHERE user_id = ?').get(u.id).m;
  const picked = db.prepare('SELECT * FROM knowledge_report_picks WHERE user_id = ? ORDER BY id').all(u.id);

  res.json({
    generated_at: nowLocal(),
    student: { name: u.name, student_no: u.student_no, major: u.major, grade: u.grade },
    counts: {
      papers: papers.length,
      papers_verified: verified,
      papers_unverified: papers.length - verified,
      cards: cards.length,
      topics: db.prepare('SELECT COUNT(*) AS n FROM topics WHERE user_id = ?').get(u.id).n,
      ideas: db.prepare('SELECT COUNT(*) AS n FROM topic_ideas WHERE user_id = ?').get(u.id).n,
      kb_items: items.length,
      mistakes: mistakes.length,
      knowledge: items.filter((x) => x.type === 'knowledge').length,
      notes: items.filter((x) => x.type === 'note').length,
      reading_minutes: readingMinutes,
    },
    mistake_causes: Object.entries(causeCount).map(([name, n]) => ({ name, count: n })).sort((a, b) => b.count - a.count),
    topics: db.prepare('SELECT * FROM topics WHERE user_id = ? ORDER BY id').all(u.id).map((t) => ({
      name: t.name, description: t.description || '',
      papers: papers.filter((p) => p.topic === t.name).map((p) => p.title),
    })),
    picks: picked.map((p) => ({ kind: p.kind, ref_id: p.ref_id, title: p.title, note: p.note || '' })),
    note: '这份报告只统计你自己的数据。精选条目由你自己挑选，用来放进结课考核档案袋。',
  });
});

/** 精选条目：学生自己挑5条 */
r.put('/kb/report/picks', requireStudent, (req, res) => {
  const picks = Array.isArray(req.body?.picks) ? req.body.picks.slice(0, 5) : [];
  const mine = {
    paper: new Set(db.prepare('SELECT id FROM papers WHERE user_id = ?').all(req.user.id).map((x) => x.id)),
    card: new Set(db.prepare('SELECT id FROM reading_cards WHERE user_id = ?').all(req.user.id).map((x) => x.id)),
    item: new Set(db.prepare('SELECT id FROM kb_items WHERE user_id = ?').all(req.user.id).map((x) => x.id)),
    idea: new Set(db.prepare('SELECT id FROM topic_ideas WHERE user_id = ?').all(req.user.id).map((x) => x.id)),
  };
  db.prepare('DELETE FROM knowledge_report_picks WHERE user_id = ?').run(req.user.id);
  let n = 0;
  for (const p of picks) {
    const kind = String(p.kind || '');
    if (!mine[kind] || !mine[kind].has(Number(p.ref_id))) continue;
    db.prepare('INSERT INTO knowledge_report_picks(user_id, kind, ref_id, title, note, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(req.user.id, kind, Number(p.ref_id), String(p.title || '').slice(0, 300), String(p.note || '').slice(0, 300), nowLocal());
    n += 1;
  }
  res.json({ picks: n });
});

/** 打印版报告（HTML，浏览器直接打印或存 PDF） */
r.get('/kb/report/print', requireStudent, async (req, res) => {
  const u = req.user;
  const papers = collectPapers(u.id);
  const cards = db.prepare('SELECT * FROM reading_cards WHERE user_id = ? ORDER BY id').all(u.id);
  const items = db.prepare('SELECT * FROM kb_items WHERE user_id = ?').all(u.id).map(publicItem);
  const topics = db.prepare('SELECT * FROM topics WHERE user_id = ? ORDER BY id').all(u.id);
  const ideas = db.prepare('SELECT * FROM topic_ideas WHERE user_id = ? ORDER BY id').all(u.id);
  const picks = db.prepare('SELECT * FROM knowledge_report_picks WHERE user_id = ? ORDER BY id').all(u.id);
  const causeCount = {};
  for (const m of items.filter((x) => x.type === 'mistake')) {
    const c = m.content.cause || '未填';
    causeCount[c] = (causeCount[c] || 0) + 1;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const verified = papers.filter((p) => p.verify_status === 'verified').length;

  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>知识库报告-${esc(u.name)}</title>
<style>
 body{font-family:"Songti SC",SimSun,serif;max-width:820px;margin:32px auto;padding:0 20px;color:#1C2430;line-height:1.7}
 h1{font-size:26px;border-bottom:3px double #2F6F62;padding-bottom:8px}
 h2{font-size:19px;margin-top:28px;color:#255a4f;border-left:4px solid #2F6F62;padding-left:8px}
 table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0}
 th,td{border:1px solid #DADFD8;padding:6px 10px;text-align:left}
 th{background:#e7efeb}
 .muted{color:#59665f;font-size:13px}
 ol,ul{padding-left:22px}
 @media print{body{margin:0} h2{page-break-after:avoid}}
</style></head><body>
<h1>个人知识库报告</h1>
<p class="muted">${esc(u.name)} · 学号 ${esc(u.student_no)} · ${esc(u.major || '')} ${esc(u.grade || '')} · 生成于 ${esc(nowLocal())}</p>

<h2>一、条目统计</h2>
<table>
<tr><th>文献</th><td>${papers.length} 篇（已核验 ${verified} 篇，待核验 ${papers.length - verified} 篇）</td></tr>
<tr><th>阅读卡</th><td>${cards.length} 张</td></tr>
<tr><th>主题</th><td>${topics.length} 个</td></tr>
<tr><th>选题卡</th><td>${ideas.length} 张</td></tr>
<tr><th>备考条目</th><td>知识清单 ${items.filter((x) => x.type === 'knowledge').length} 条 · 错题 ${items.filter((x) => x.type === 'mistake').length} 条 · 笔记 ${items.filter((x) => x.type === 'note').length} 条</td></tr>
</table>

<h2>二、错因分布</h2>
${Object.keys(causeCount).length
    ? `<table><tr><th>错因</th><th>数量</th></tr>${Object.entries(causeCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>`
    : '<p class="muted">还没有登记错题。</p>'}

<h2>三、主题地图</h2>
${topics.length ? `<ul>${topics.map((t) => `<li><strong>${esc(t.name)}</strong>${t.description ? `——${esc(t.description)}` : ''}<br><span class="muted">${papers.filter((p) => p.topic === t.name).map((p) => esc(p.title)).join('；') || '暂无文献'}</span></li>`).join('')}</ul>` : '<p class="muted">还没有建立主题。</p>'}

<h2>四、选题卡</h2>
${ideas.length ? ideas.map((i) => `<p><strong>${esc(i.question)}</strong><br><span class="muted">意义：${esc(i.significance || '')}｜可行性：${esc(i.feasibility || '')}｜状态：${esc(i.status || '')}</span></p>`).join('') : '<p class="muted">还没有选题卡。</p>'}

<h2>五、我挑选的 ${picks.length} 条</h2>
${picks.length ? `<ol>${picks.map((p) => `<li><strong>${esc(p.title)}</strong>${p.note ? `<br><span class="muted">${esc(p.note)}</span>` : ''}</li>`).join('')}</ol>` : '<p class="muted">还没有挑选。去“书房 → 知识库报告”里勾选 5 条最能代表你学习过程的条目。</p>'}

<p class="muted" style="margin-top:32px">本报告由山海问知自动生成，只包含该学生本人的数据。平台不代替学生写作，所有条目均为学生自己录入或确认。</p>
</body></html>`;
  res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.send(html);
});

export default r;
export { MISTAKE_CAUSES };
