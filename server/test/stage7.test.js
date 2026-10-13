// 阶段7自测：复试模拟（M13）、结课考核中心（M14）、互评（M2）、问卷（附录F）
// 通过标准：第16章第11条（结课全流程）与 16.2 第6条（复试模拟）
// 运行：cd server && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.KEY_ENC_SECRET = 'test-key-enc-secret';
process.env.TEACHER_ACCOUNTS = 'teacher:teacher-pass-123';
process.env.DEFAULT_INVITE_CODE = 'TEST2026';
process.env.LLM_BASE_URL = 'mock';
process.env.LLM_PLATFORM_KEY = 'sk-platformKEY1234';
process.env.SEARCH_PROVIDER = 'none';

const { createApp } = await import('../src/app.js');
const { db, setSetting } = await import('../src/db.js');
const { todayLocal, addDays, nowLocal } = await import('../src/time.js');
const { oneQuestion, normalizeReview } = await import('../src/routes/interview.js');
const { readZip } = await import('../src/research/zip.js');
const { ITEMS } = await import('../src/assess.js');

setSetting('mail.enabled', '0');

let server;
let base;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server?.close());

function client() {
  let cookie = '';
  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      return { status: res.status, events: text.trim().split('\n\n').filter(Boolean).map((c) => ({ ev: c.match(/^event: (.+)$/m)?.[1], data: JSON.parse(c.match(/^data: (.+)$/m)?.[1] || 'null') })) };
    }
    if (type.includes('wordprocessingml')) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
    const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
    let data = null; try { data = JSON.parse(raw); } catch { /* 非 JSON */ }
    return { status: res.status, body: data, raw };
  }
  return { call };
}

async function register(c, no, name) {
  const r = await c.call('POST', '/register', { invite_code: 'TEST2026', student_no: no, name, email: `${no}@qq.com`, major: '汉语言文学', grade: '大三', major_group: '文史', password: 'password-123' });
  await c.call('POST', '/prepare/consent', { agreed: true });
  await c.call('POST', '/prepare/modules-read', {});
  const def = await c.call('GET', '/surveys/pre');
  const answers = {};
  for (const it of def.body.items) answers[it.key] = it.type === 'scale' ? 3 : it.options[1];
  await c.call('POST', '/surveys/pre', { answers });
  await c.call('PUT', '/me', { persona: 'gentle' });
  return r.body.me.id;
}

const KEY = { 'X-User-Key': 'sk-studentOwnKEY5678' };
const stu = client();
const tea = client();
let uid;

// ---------- 纯函数 ----------

test('考官一次只出一个问题：多问被截成第一个', () => {
  assert.equal(oneQuestion('请介绍一下你的研究兴趣？另外，你为什么选这个专业？'), '请介绍一下你的研究兴趣？');
  assert.equal(oneQuestion('问题：What is your plan?\nAnd why?'), 'What is your plan?');
  assert.equal(oneQuestion('"你读过哪些专业书？"'), '你读过哪些专业书？');
});

test('复盘规范化：每个分数都必须有理由，没理由的分数不计；只保留在场考官', () => {
  const tr = [{ type: 'q', text: '你为什么考研？', examiner: 'interview' }, { type: 'a', text: '想换平台' }];
  const r = normalizeReview({
    examiners: [
      { key: 'interview', scores: { 观点: 4, 依据: 3, 例证: 2, 回应: 6 }, reasons: { 观点: '观点明确', 依据: '', 例证: '没举例', 回应: '能接住' } },
      { key: 'someone_else', scores: { 观点: 5 }, reasons: { 观点: 'x' } },
    ],
    retry_questions: ['你为什么考研？', '一个根本没问过的问题'],
  }, ['interview'], tr, false);
  assert.equal(r.examiners.length, 1, '不在场的考官被去掉');
  const e = r.examiners[0];
  assert.equal(e.scores.观点, 4);
  assert.equal(e.scores.依据, null, '没有理由的分数不计');
  assert.equal(e.scores.回应, null, '超出1—5的分数不计');
  for (const k of ['观点', '依据', '例证', '回应']) assert.ok(e.reasons[k], `${k} 有理由或说明`);
  assert.deepEqual(r.retry_questions, ['你为什么考研？'], '只收真正问过的问题');
  assert.equal(r.english, null);
});

// ---------- 16.2 第6条：复试模拟 ----------

test('准备：注册学生，留一张阅读卡（考官可以引用）', async () => {
  uid = await register(stu, '2024701', '复试测试生');
  await stu.call('POST', '/cards', { question: '多智能体评估是否更可靠', my_judgment: '关键在评估维度是否拆得足够细。' });
  const st = await stu.call('GET', '/interview/status');
  assert.ok(st.body.disclaimer.includes('不代表真实院校考官') && st.body.disclaimer.includes('非真题'), '明确提示 AI 模拟、非真题');
  assert.equal(st.body.basic.left, 2);
});

let basicId;
test('16.2-6①：不绑定 Key 完成一次基础版（衡言单考官，10分钟）', async () => {
  const s = await stu.call('POST', '/interview/sessions', { tier: 'basic', target: '西北大学 学科教学（语文）', difficulty: '标准' });
  assert.equal(s.status, 200, s.body?.error);
  basicId = s.body.session.id;
  assert.deepEqual(s.body.session.config.examiners, ['interview'], '基础版只有衡言');
  assert.equal(s.body.session.config.duration, 10);
  assert.ok(!s.body.session.stages.includes('英文自我介绍与问答'), '没有英语考官就没有英文环节');

  const answers = ['我是汉语言文学专业的学生，想读学科教学。', '我读过《语文教育学》。', '嗯……这个我不太清楚。', '我会先做文献综述再定题。', '我想问导师组的研究方向。', '谢谢老师。'];
  let r = await stu.call('POST', `/interview/sessions/${basicId}/next`, {});
  for (let i = 0; i < answers.length; i += 1) {
    const evs = r.events.map((e) => e.ev);
    if (evs.includes('ended')) break;
    assert.equal(r.events.filter((e) => e.ev === 'question').length, 1, '每轮只出现一个问题');
    const ex = r.events.find((e) => e.ev === 'examiner');
    assert.equal(ex.data.key, 'interview');
    assert.ok(ex.data.name && ex.data.duty, '显示考官名与职责');
    assert.ok(r.events.find((e) => e.ev === 'meta').data.stage, '显示当前环节');
    r = await stu.call('POST', `/interview/sessions/${basicId}/next`, { text: answers[i] });
  }
  // 没回答就要下一题 → 拒绝
  const cur = await stu.call('GET', `/interview/sessions/${basicId}`);
  if (cur.body.session.status === 'running') {
    assert.equal((await stu.call('POST', `/interview/sessions/${basicId}/next`, {})).status, 400, '必须先回答当前问题');
  }
  const qs = cur.body.session.transcript.filter((x) => x.type === 'q');
  assert.equal(qs[0].stage, '中文自我介绍', '第一个环节是中文自我介绍');
  assert.ok(qs[0].text.includes('自我介绍'), '开场就请考生做自我介绍');
  assert.ok(qs.length >= 4);
  // 平台 Key：调用记录里是 platform
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ? AND kind = 'M13_basic' AND key_source = 'platform'").get(uid).n > 0);
});

test('16.2-6②：复盘每个分数都有理由；自评少于50字不能关闭；差的问题进入题库', async () => {
  assert.equal((await stu.call('POST', `/interview/sessions/${basicId}/self-review`, { text: '还行' })).status, 400, '没有复盘不能写自评');
  const f = await stu.call('POST', `/interview/sessions/${basicId}/finish`, {});
  assert.equal(f.status, 200, f.body?.error);
  const rv = f.body.session.review;
  assert.ok(rv.examiners.length >= 1);
  for (const e of rv.examiners) for (const k of ['观点', '依据', '例证', '回应']) assert.ok(e.reasons[k], `${e.name}的“${k}”有理由`);
  assert.ok(rv.note.includes('不代表真实院校考官'));
  assert.ok(rv.qbank_added >= 1, '答得不好的问题进了题库');

  const short = await stu.call('POST', `/interview/sessions/${basicId}/self-review`, { text: '这次答得一般，下次努力。' });
  assert.equal(short.status, 400);
  assert.equal(short.body.code, 'SELF_REVIEW_SHORT');
  assert.equal((await stu.call('GET', `/interview/sessions/${basicId}`)).body.session.status, 'reviewed', '自评不够时复盘没有关闭');
  const ok = await stu.call('POST', `/interview/sessions/${basicId}/self-review`, { text: '这次专业问题答得很空，被问到读过什么书时只报了书名，说不出书里的观点和自己的判断。下次每本书准备一句“它解决了什么问题、我同意哪一点、我怀疑哪一点”，并练习先给结论再展开。' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.session.status, 'closed');
  const flow = await stu.call('GET', '/flow');
  assert.equal(flow.body.stations.find((s) => s.station === 10).status, 'done', '第10站完成');

  const exp = await stu.call('GET', `/interview/sessions/${basicId}/export`);
  assert.ok(exp.raw.includes('考官复盘') && exp.raw.includes('我的自评'), '可以导出复盘记录');
});

test('16.2-6③：绑定 Key 后选四位考官完成一次20分钟模拟；题库里的问题被优先抽到', async () => {
  const qb = await stu.call('GET', '/interview/qbank');
  const pending = qb.body.items.filter((x) => x.status === '待重练');
  assert.ok(pending.length >= 1);
  assert.equal((await stu.call('POST', '/interview/sessions', { tier: 'full' })).status, 403, '完整考官组需要自己的 Key');

  const s = await stu.call('POST', '/interview/sessions', {
    tier: 'full', target: '西北大学 学科教学（语文）', duration: 20, difficulty: '压力',
    examiners: ['格物｜专业考官', '远帆｜英语考官', '守正｜综合考官', '鉴微｜导师视角'],
  }, KEY);
  assert.equal(s.status, 200, s.body?.error);
  const sid = s.body.session.id;
  assert.equal(s.body.session.config.examiners.length, 5, '衡言 + 四位考官');
  assert.equal(s.body.session.config.duration, 20);
  assert.deepEqual(s.body.session.stages, ['中文自我介绍', '英文自我介绍与问答', '专业问题', '综合与情境问题', '你有什么想问我们的']);

  let r = await stu.call('POST', `/interview/sessions/${sid}/next`, {}, KEY);
  const seen = [];
  for (let i = 0; i < 14; i += 1) {
    if (r.events.some((e) => e.ev === 'ended')) break;
    assert.equal(r.events.filter((e) => e.ev === 'question').length, 1, '每轮只出现一个问题');
    const q = r.events.find((e) => e.ev === 'question').data;
    const stage = r.events.find((e) => e.ev === 'meta').data.stage;
    seen.push({ stage, examiner: q.examiner, text: q.text, from_qbank: q.from_qbank });
    r = await stu.call('POST', `/interview/sessions/${sid}/next`, { text: `这是我的第${i + 1}个回答，我会先说结论再举例。` }, KEY);
  }
  assert.ok(seen.filter((x) => x.stage.includes('英文')).every((x) => x.examiner === 'examiner_english'), '英文环节由远帆提问');
  assert.equal(seen[seen.length - 1].stage, '你有什么想问我们的', '最后一个环节是反问');
  const firstMajor = seen.find((x) => x.stage === '专业问题');
  assert.ok(firstMajor.from_qbank, '专业环节第一题来自题库');
  const oldest = pending.slice().sort((a, b) => a.id - b.id)[0];
  assert.equal(firstMajor.text, oldest.question, '下一次模拟优先抽到最早进题库、还没重练的问题（原文）');
  // 压力难度：提问提示词里写明措辞尊重
  const { renderPrompt } = await import('../src/prompts.js');
  const p = renderPrompt('interview_ask', { 考官名: '守正', 考官职责: '综合考官', 考官语气: '', 姓名: 'x', 问题方向: 'x', 环节: '综合', 难度: '压力', 考生材料: '', 最近对话: '' });
  assert.ok(p.includes('不羞辱') && p.includes('不人身攻击'));
  const f = await stu.call('POST', `/interview/sessions/${sid}/finish`, {}, KEY);
  assert.equal(f.status, 200);
  assert.ok(f.body.session.review.examiners.length >= 4, '每位在场考官分别复盘');
});

test('基础版每周2次；题库可以标记已重练', async () => {
  const s2 = await stu.call('POST', '/interview/sessions', { tier: 'basic' });
  assert.equal(s2.status, 200);
  const s3 = await stu.call('POST', '/interview/sessions', { tier: 'basic' });
  assert.equal(s3.status, 429);
  assert.equal(s3.body.code, 'WEEKLY_LIMIT');
  const qb = await stu.call('GET', '/interview/qbank');
  const id = qb.body.items[0].id;
  await stu.call('PUT', `/interview/qbank/${id}`, { status: '已重练', my_notes: '先说结论' });
  assert.equal((await stu.call('GET', '/interview/qbank')).body.items.find((x) => x.id === id).status, '已重练');
});

// ---------- M2 互评 ----------

const peers = [];
test('M2 互评：每份作业分给2位同学，不分给作者本人，双向匿名，被评者看到汇总', async () => {
  const t2 = { exam_year: '2027年12月', nodes: ['网上报名', '初试', '复试'], start_time: '这学期内', start_reason: '想早点打基础，留出复习时间', achievement: '大创' };
  const others = [];
  for (let i = 0; i < 3; i += 1) {
    const c = client();
    const id = await register(c, `202479${i}`, `互评同学${i}`);
    others.push({ c, id });
    assert.equal((await c.call('POST', '/chapters/1/tasks/t2', { content: { ...t2, start_reason: `${t2.start_reason}（同学${i}）` } })).status, 200);
  }
  assert.equal((await stu.call('POST', '/chapters/1/tasks/t2', { content: t2 })).status, 200);
  peers.push(...others);

  assert.equal((await stu.call('POST', '/teacher/peer/open', { chapter: 1, task_id: 't2' })).status, 403, '学生不能开互评');
  await tea.call('POST', '/login', { student_no: 'teacher', password: 'teacher-pass-123' });
  assert.equal((await tea.call('POST', '/teacher/peer/open', { chapter: 1, task_id: 't1' })).status, 400, '测验不能互评');
  const open = await tea.call('POST', '/teacher/peer/open', { chapter: 1, task_id: 't2' });
  assert.equal(open.status, 200, open.body?.error);
  assert.equal(open.body.created, 8, '4份作业 × 2位评价者');

  const rows = db.prepare(`SELECT p.reviewer_id, s.user_id, s.id FROM peer_reviews p JOIN submissions s ON s.id = p.submission_id WHERE s.task_id = 't2'`).all();
  assert.ok(rows.every((x) => x.reviewer_id !== x.user_id), '没有作业分给作者本人');
  const perSub = {};
  for (const x of rows) perSub[x.id] = (perSub[x.id] || 0) + 1;
  assert.ok(Object.values(perSub).every((n) => n === 2), '每份作业2位评价者');

  // 再开一次不会重复分配
  assert.equal((await tea.call('POST', '/teacher/peer/open', { chapter: 1, task_id: 't2' })).body.created, 0);

  const mine = await stu.call('GET', '/peer/assigned');
  assert.equal(mine.body.items.length, 2);
  const raw = JSON.stringify(mine.body);
  assert.ok(!/互评同学|2024790|2024791|2024792/.test(raw), '看不到作者姓名和学号');
  assert.equal((await stu.call('POST', `/peer/${mine.body.items[0].id}`, { rubric: { reliable: 4, logic: 4, executable: 9 }, comment: '很好' })).status, 400, '分数要在1—5');
  assert.equal((await stu.call('POST', `/peer/${mine.body.items[0].id}`, { rubric: { reliable: 4, logic: 4, executable: 3 }, comment: '好' })).status, 400, '要写一句具体建议');
  for (const it of mine.body.items) {
    assert.equal((await stu.call('POST', `/peer/${it.id}`, { rubric: { reliable: 4, logic: 3, executable: 3 }, comment: '时间节点写得清楚，可以再写每个阶段的具体任务。' })).status, 200);
  }
  // 别人的互评任务不能代填
  const otherTask = db.prepare('SELECT id FROM peer_reviews WHERE reviewer_id = ?').get(others[0].id).id;
  assert.equal((await stu.call('POST', `/peer/${otherTask}`, { rubric: { reliable: 3, logic: 3, executable: 3 }, comment: '这是代别人填的评价' })).status, 404);

  for (const o of others) {
    const a = await o.c.call('GET', '/peer/assigned');
    for (const it of a.body.items) await o.c.call('POST', `/peer/${it.id}`, { rubric: { reliable: 5, logic: 4, executable: 4 }, comment: '节点完整，理由具体，建议补上调剂预案。' });
  }
  const rec = await stu.call('GET', '/peer/received');
  const item = rec.body.items.find((x) => x.task_title === '倒推我的时间轴');
  assert.equal(item.received, 2);
  assert.equal(item.averages['信息可靠'], 5);
  assert.ok(!JSON.stringify(rec.body).includes('互评同学'), '看不到评价者是谁');
  const tp = await tea.call('GET', '/teacher/peer');
  assert.equal(tp.body.open[0].done, 8);
});

// ---------- 第16章第11条：结课 ----------

test('16-11①：档案袋一键看出缺哪一项', async () => {
  const pf = await stu.call('GET', '/assess/portfolio');
  assert.equal(pf.status, 200);
  assert.equal(pf.body.items.length, 5);
  assert.deepEqual(pf.body.items.map((i) => i.weight), [15, 15, 20, 10, 40]);
  assert.equal(ITEMS.reduce((s, i) => s + i.weight, 0), 100);
  for (const it of pf.body.items) {
    assert.ok(['done', 'partial', 'missing'].includes(it.status));
    assert.ok(it.levels && it.indicators, '带量规与平台指标');
    if (it.status !== 'done') assert.ok(it.missing.length >= 1, `${it.name} 有缺项提示`);
  }
  assert.equal(pf.body.items.find((i) => i.key === 'schools').status, 'missing');
  assert.ok(pf.body.summary.some((s) => s.includes('目标院校')), '摘要里能看到缺目标院校表');
  assert.ok(pf.body.missing_count >= 3);
});

test('16-11②：汇编行动方案 → 写反思（AI 不能写入）→ AI使用说明统计与日志一致 → 提交', async () => {
  assert.equal((await stu.call('POST', '/assess/submit', {})).status, 400, '没汇编不能提交');
  assert.equal((await stu.call('PUT', '/assess/plan/reflections', { section: 'profile', text: '我觉得画像基本准确，但它低估了我的英语基础，下次要补上真实的成绩数据。' })).status, 400, '没汇编不能写反思');
  const c = await stu.call('POST', '/assess/plan/compile', {});
  assert.equal(c.status, 200);
  assert.equal(c.body.draft.sections.length, 7);
  assert.ok(c.body.draft.sections.find((s) => s.key === 'interview').content.includes('复试模拟练习'), '复试准备部分汇入了模拟记录');
  assert.deepEqual(c.body.reflections, {}, '汇编不会写入任何反思');

  assert.equal((await stu.call('PUT', '/assess/plan/reflections', { section: 'profile', text: '还行' })).body.code, 'TOO_SHORT');
  const copy = c.body.draft.sections.find((s) => s.key === 'path').content;
  const cp = await stu.call('PUT', '/assess/plan/reflections', { section: 'path', text: `${copy}。` });
  if (copy.length >= 30) assert.equal(cp.body.code, 'COPIED', '把汇编内容抄进反思会被拦下');

  for (const s of c.body.draft.sections) {
    const r = await stu.call('PUT', '/assess/plan/reflections', { section: s.key, text: `关于“${s.title}”，我回头看自己的记录，发现计划和实际之间差距不小，下一步要把目标拆成每周能检查的小任务，并找同学互相监督。` });
    assert.equal(r.status, 200, r.body?.error);
  }
  // 再汇编一次：反思原样保留
  const c2 = await stu.call('POST', '/assess/plan/compile', {});
  assert.equal(Object.keys(c2.body.reflections).length, 7, '重新汇编不覆盖反思');

  // AI 使用说明：统计与原始日志一致
  const st = await stu.call('GET', '/assess/ai-statement');
  const raw = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t FROM ai_calls WHERE user_id = ? AND ok = 1').get(uid);
  assert.equal(st.body.stats.total_calls, raw.n, '调用次数与日志一致');
  assert.equal(st.body.stats.total_tokens, raw.t, 'token 数与日志一致');
  const catSum = st.body.stats.categories.reduce((s, x) => s + x.calls, 0);
  assert.equal(catSum, raw.n, '分类加总与日志一致');
  const mock = st.body.stats.categories.find((x) => x.category === '复试模拟');
  assert.equal(mock.calls, db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ? AND ok = 1 AND kind IN ('M13_basic','M13_full')").get(uid).n);
  assert.ok(st.body.draft.includes(`共调用 AI ${raw.n} 次`), '草稿里的数字与日志一致');

  assert.equal((await stu.call('PUT', '/assess/ai-statement', { note: '我用了AI' })).body.code, 'TOO_SHORT');
  assert.equal((await stu.call('POST', '/assess/submit', {})).body.code, 'NEED_AI_NOTE');
  await stu.call('PUT', '/assess/ai-statement', { note: '复试模拟里 AI 提的问题我都自己作答，复盘给的建议我挑了两条去练；画像是 AI 起草的，我改了英语基础那一栏；院校数据我逐条去官网核对过。' });

  const sub = await stu.call('POST', '/assess/submit', {});
  assert.equal(sub.status, 200, sub.body?.error);
  assert.ok(sub.body.submitted_at);
  assert.equal(sub.body.ai_statement.stats.total_calls, raw.n, '提交时定格的统计与日志一致');
  assert.equal((await stu.call('PUT', '/assess/plan/reflections', { section: 'profile', text: '提交以后还想再改一下这一段的反思内容可以吗' })).status, 400, '提交后不能再改');
  assert.equal((await stu.call('GET', '/flow')).body.stations.find((s) => s.station === 11).status, 'done', '第11站完成');

  const docx = await stu.call('GET', '/assess/plan/export?format=docx');
  const files = readZip(docx.buffer);
  const doc = files.find((f) => f.name === 'word/document.xml').data;
  assert.ok(doc.includes('我的反思') && doc.includes('AI使用与核验说明'), 'Word 文档里有反思与AI说明');
  assert.ok(files.some((f) => f.name === '[Content_Types].xml'), '是合法的 .docx 结构');
});

test('16-11③：教师评分 → 导出成绩表，列与考核结构一致、加权正确；学生只看到自己的分数', async () => {
  assert.equal((await stu.call('GET', '/teacher/grades')).status, 403);
  const list = await tea.call('GET', '/teacher/grades');
  const me = list.body.students.find((s) => s.id === uid);
  assert.ok(me.submitted_at);
  const detail = await tea.call('GET', `/teacher/grades/${uid}`);
  assert.ok(detail.body.action_plan.reflections.profile, '教师能看到提交的反思');
  const dump = JSON.stringify(detail.body);
  assert.ok(!dump.includes('messages') && !dump.includes('transcript'), '看不到私聊与模拟原文');

  assert.equal((await tea.call('PUT', `/teacher/grades/${uid}`, { item: 'schools', score: 120 })).status, 400);
  const scores = { schools: 80, plan: 90, kb: 70, classroom: 100, final: 85 };
  let last;
  for (const [item, score] of Object.entries(scores)) last = await tea.call('PUT', `/teacher/grades/${uid}`, { item, score, comment: '有依据' });
  const expected = Math.round((80 * 15 + 90 * 15 + 70 * 20 + 100 * 10 + 85 * 40) / 100 * 10) / 10;
  assert.equal(last.body.total, expected, `加权总评 ${expected}`);

  const csv = await tea.call('GET', '/teacher/grades/export');
  assert.equal(csv.raw.charCodeAt(0), 0xfeff, 'UTF-8 BOM');
  const lines = csv.raw.slice(1).trim().split('\r\n');
  const head = lines[0].split(',').map((x) => x.replace(/"/g, ''));
  assert.deepEqual(head, ['学号', '姓名', '目标院校信息分析表（15%）', '阶段学习计划与复盘（15%）', '个人备考知识库（20%）', '课堂任务与互评（10%）', '行动方案 + AI使用与核验说明 + 复试情境展示（40%）', '总评（加权）', '备注']);
  const row = lines.find((l) => l.includes('2024701')).split(',').map((x) => x.replace(/"/g, ''));
  assert.deepEqual(row.slice(2, 8).map(Number), [80, 90, 70, 100, 85, expected]);
  const other = lines.find((l) => l.includes('2024790'));
  assert.ok(other.includes('未评'), '没评完的学生总评留空并注明');

  const mine = await stu.call('GET', '/assess/portfolio');
  assert.equal(mine.body.grades.length, 5, '学生看得到自己的分数');
  const peerView = await peers[0].c.call('GET', '/assess/portfolio');
  assert.equal(peerView.body.grades.length, 0, '看不到别人的分数');
});

test('公平性：完全不用自己 Key 的学生也能让档案袋五项全部完成', async () => {
  const c = client();
  const id = await register(c, '2024799', '不绑Key同学');
  // 课堂任务全部提交
  for (const t of ['t0', 't1', 't2', 't3', 't4']) {
    db.prepare('INSERT OR IGNORE INTO submissions(user_id, chapter, task_id, content_json, created_at) VALUES(?, 1, ?, ?, ?)').run(id, t, '{}', nowLocal());
  }
  // 院校表（手动录入 + 核验）
  for (const [school, tier] of [['甲大学', '冲刺'], ['乙大学', '稳妥'], ['丙大学', '保底']]) {
    const s = await c.call('POST', '/schools', { school, tier, major: '学科教学', basis: '地域与专业都合适', uncertainty: '复试线每年有波动', facts: [{ item: '复试线', value: '360', source: '研招网', url: 'https://yz.chsi.com.cn', level: '官方' }] });
    await c.call('POST', `/schools/${s.body.school.id}/verify`, { index: 0, verified: true });
  }
  // 方案、打卡、周复盘
  db.prepare("INSERT INTO plans(user_id, plan_json, active, created_at) VALUES(?, '{}', 1, ?)").run(id, nowLocal());
  db.prepare('INSERT INTO checkins(user_id, date, minutes, done_count, total_count, reflection, mood) VALUES(?, ?, 60, 1, 2, ?, 3)').run(id, addDays(todayLocal(), -1), '今天把单词复习完了');
  db.prepare("INSERT INTO weekly_reviews(user_id, week_start, rate, blockers_json, adjust_json, summary, created_at) VALUES(?, ?, 0.6, '[]', '[]', '这周节奏还可以', ?)").run(id, todayLocal(), nowLocal());
  // 知识库（全部手动）
  await c.call('POST', '/kb/items', { space: 'prep', type: 'knowledge', title: '教育学原理第一章', content: { outline: '教育的本质' }, mastery: 3 });
  const p = await c.call('POST', '/papers', { title: '一篇手动录入的文献', authors: ['张三'], year: 2024 });
  for (let i = 0; i < 3; i += 1) await c.call('POST', '/cards', { paper_id: p.body.paper.id, question: `问题${i}`, my_judgment: '我自己的判断' });
  await c.call('POST', '/ideas', { question: '一个可做的研究问题' });
  // 终结性材料
  const comp = await c.call('POST', '/assess/plan/compile', {});
  for (const s of comp.body.draft.sections) await c.call('PUT', '/assess/plan/reflections', { section: s.key, text: `${s.title}这部分我自己回顾后认为还要加强，具体是把每周目标写得更可检查一些，再请同学监督我完成。` });
  await c.call('PUT', '/assess/ai-statement', { note: '我没有绑定自己的 Key，只用了平台的基础功能。AI 起草的画像和方案我都逐条看过，院校数据去研招网核对过。' });
  assert.equal((await c.call('POST', '/assess/submit', {})).status, 200);

  const pf = await c.call('GET', '/assess/portfolio');
  for (const it of pf.body.items) assert.equal(it.status, 'done', `${it.name}：${it.missing.join('；')}`);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ? AND key_source = 'user'").get(id).n, 0, '全程没有用自己的 Key');
});

// ---------- 附录F 问卷 ----------

test('附录F：中测、后测（同一组能力题）与满意度问卷', async () => {
  const pre = await stu.call('GET', '/surveys/pre');
  for (const kind of ['mid', 'post']) {
    const def = await stu.call('GET', `/surveys/${kind}`);
    assert.equal(def.status, 200);
    const abilityKeys = def.body.items.filter((x) => x.key.startsWith('ability')).map((x) => x.key);
    assert.deepEqual(abilityKeys, pre.body.items.filter((x) => x.key.startsWith('ability')).map((x) => x.key), `${kind} 与前测同题`);
    const answers = {};
    for (const it of def.body.items) answers[it.key] = it.type === 'scale' ? 4 : it.options?.[2];
    assert.equal((await stu.call('POST', `/surveys/${kind}`, { answers })).status, 200);
  }
  const sat = await stu.call('GET', '/surveys/satisfaction');
  assert.ok(sat.body.items.some((x) => x.key === 'recommend'));
  assert.equal((await stu.call('POST', '/surveys/satisfaction', { answers: { overall: 5, helpful: ['复试模拟'], stick: 4, recommend: 11 } })).status, 400, '推荐度在0—10之间');
  assert.equal((await stu.call('POST', '/surveys/satisfaction', { answers: { overall: 5, helpful: ['知识库'], stick: 4, recommend: 9 } })).status, 200);
  const cmp = await stu.call('GET', '/surveys/compare');
  assert.equal(cmp.status, 200);
  assert.ok(cmp.body.items.length === 8 && cmp.body.items.every((x) => x.pre === 3 && x.post === 4), '能看到自己前后测的变化');
});

test('回归：注销参与过互评的同学后，相关互评记录一并清除（互评表没有 user_id 列）', async () => {
  const victim = peers[0];
  const before = db.prepare('SELECT COUNT(*) AS n FROM peer_reviews WHERE reviewer_id = ?').get(victim.id).n;
  assert.ok(before > 0);
  assert.equal((await victim.c.call('DELETE', '/me', { password: 'password-123', confirm: '注销账号' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_reviews WHERE reviewer_id = ?').get(victim.id).n, 0, '他评别人的记录删了');
  const orphan = db.prepare('SELECT COUNT(*) AS n FROM peer_reviews WHERE submission_id NOT IN (SELECT id FROM submissions)').get().n;
  assert.equal(orphan, 0, '别人评他的记录也删了，没有孤儿');
});
