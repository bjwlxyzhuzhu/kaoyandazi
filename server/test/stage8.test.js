// 阶段8自测：导师工坊（M20）、教师后台（M16）、成效看板与赛事支持（M17）
// 通过标准：16.2 第4条（导师工坊）、第5条（反馈学习）、第7条（隐私回归）与第16章第12条（赛事）
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
const { nowLocal } = await import('../src/time.js');
const { chunkText, mentorRuntime } = await import('../src/workshop.js');
const { pointCovered } = await import('../src/routes/workshop.js');
const { readZip } = await import('../src/research/zip.js');

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
      return { status: res.status, raw: text, events: text.trim().split('\n\n').filter(Boolean).map((c) => ({ ev: c.match(/^event: (.+)$/m)?.[1], data: JSON.parse(c.match(/^data: (.+)$/m)?.[1] || 'null') })) };
    }
    if (type.includes('spreadsheetml') || type.includes('wordprocessingml')) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
    const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
    let data = null; try { data = JSON.parse(raw); } catch { /* 非 JSON */ }
    return { status: res.status, body: data, raw };
  }
  return { call };
}

async function register(c, no, name, invite = 'TEST2026') {
  const r = await c.call('POST', '/register', { invite_code: invite, student_no: no, name, email: `${no}@qq.com`, major: '汉语言文学', grade: '大三', major_group: '文史', password: 'password-123' });
  if (r.status !== 200) return r;
  await c.call('POST', '/prepare/consent', { agreed: true });
  await c.call('POST', '/prepare/modules-read', {});
  const def = await c.call('GET', '/surveys/pre');
  const answers = {};
  for (const it of def.body.items) answers[it.key] = it.type === 'scale' ? 3 : it.options[1];
  await c.call('POST', '/surveys/pre', { answers });
  await c.call('PUT', '/me', { persona: 'strict' });
  return r;
}

const stu = client();
const tea = client();
let uid;
const POLICY_DOC = [
  '2027年全国硕士研究生招生工作管理规定（节选，教学示例）',
  '',
  '第十二条 报考专业学位硕士研究生的考生，跨专业报考须符合招生单位规定的学历与学科要求，具体以招生单位当年公布的招生简章为准。',
  '第十三条 考生须在规定时间内完成网上报名与网上确认，逾期不再补报。网上确认包括上传身份证件照片与学历学位信息核验。',
  '第十四条 复试由招生单位自主组织，复试成绩不及格者不予录取。',
].join('\n');

test('切片与要点覆盖', () => {
  const chunks = chunkText(`${'第一段。'.repeat(80)}\n\n${'第二段。'.repeat(80)}`);
  assert.ok(chunks.length >= 2 && chunks.every((c) => c.length <= 500));
  assert.ok(pointCovered('跨专业报考要看招生简章，以当年公布为准', '以招生简章为准'));
  assert.ok(!pointCovered('多做真题', '以招生简章为准'));
});

test('准备：教师登录；学生注册', async () => {
  await tea.call('POST', '/login', { student_no: 'teacher', password: 'teacher-pass-123' });
  uid = (await register(stu, '2024801', '林小雨')).body.me.id;
  assert.equal((await stu.call('GET', '/teacher/mentors')).status, 403, '学生不能进导师工坊');
});

// ---------- 16.2 第4条：导师工坊 ----------

async function askPolicy(text) {
  const r = await stu.call('POST', '/conv/ask/send', { text, agent_key: 'policy' });
  assert.equal(r.status, 200);
  const done = r.events.find((e) => e.ev === 'done');
  assert.ok(done, JSON.stringify(r.events.find((e) => e.ev === 'error')));
  return done.data.message;
}

test('16.2-4：上传官方文件 → 未发布前学生回答不变 → 测试集新旧对照 → 发布后引用并显示来源 → 禁用后不再引用 → 回滚', async () => {
  const q = '跨专业报考专业学位硕士需要满足什么要求？网上确认要做什么？';
  const before0 = await askPolicy(q);
  assert.ok(!before0.options?.sources, '还没有资料，不显示来源');

  // 上传：缺授权说明、未确认规则、含个人信息都被拒
  assert.equal((await tea.call('POST', '/teacher/mentors/policy/docs', { title: '规定', text: POLICY_DOC, confirm_rules: true })).body.code, 'NO_LICENSE');
  assert.equal((await tea.call('POST', '/teacher/mentors/policy/docs', { title: '规定', text: POLICY_DOC, license_note: '公开文件' })).body.code, 'NEED_CONFIRM');
  assert.equal((await tea.call('POST', '/teacher/mentors/policy/docs', { title: '名单', text: '张三 手机13812345678', license_note: 'x', confirm_rules: true })).body.code, 'HAS_PII');
  const up = await tea.call('POST', '/teacher/mentors/policy/docs', { title: '研究生招生工作管理规定（节选）', source: '教育部公开文件', level: '官方', license_note: '教育部官网公开发布', text: POLICY_DOC, confirm_rules: true });
  assert.equal(up.status, 200, up.body?.error);
  const docId = up.body.doc_id;
  assert.ok(up.body.chunks >= 1);

  // 草稿未发布：学生端回答不引用新资料
  const draftView = await tea.call('GET', '/teacher/mentors/policy');
  assert.ok(draftView.body.draft.persona.doc_ids.includes(docId), '资料进了草稿');
  assert.ok(!draftView.body.published.persona.doc_ids.includes(docId), '发布版里还没有');
  const before1 = await askPolicy(q);
  assert.ok(!before1.options?.sources, '未发布前学生端回答不变（不引用新资料）');
  assert.ok(!before1.content.includes('[资料1]'));

  // 测试集：新旧版本对照与要点覆盖率
  assert.equal((await tea.call('POST', '/teacher/mentors/policy/eval', {})).body.code, 'NO_EVALSET');
  await tea.call('POST', '/teacher/mentors/policy/evalset', { question: q, points: ['研究生招生工作管理规定', '跨专业'] });
  const ev = await tea.call('POST', '/teacher/mentors/policy/eval', {});
  assert.equal(ev.status, 200, ev.body?.error);
  assert.equal(ev.body.rows.length, 1);
  assert.ok('before' in ev.body.rows[0] && 'after' in ev.body.rows[0], '有新旧回答对照');
  assert.ok(ev.body.coverage_after >= ev.body.coverage_before, `草稿覆盖率 ${ev.body.coverage_after}% ≥ 发布版 ${ev.body.coverage_before}%`);
  assert.ok(ev.body.rows[0].after.includes('[资料1]') && !ev.body.rows[0].before.includes('[资料1]'), '只有草稿引用了新资料');

  // 发布
  const pub = await tea.call('POST', '/teacher/mentors/policy/publish', { change_note: '加入招生管理规定' });
  assert.equal(pub.body.version, 'v1.1');
  const after1 = await askPolicy(q);
  assert.ok(after1.content.includes('[资料1]'), '发布后回答引用资料');
  assert.equal(after1.options.sources[0].title, '研究生招生工作管理规定（节选）', '显示来源');
  assert.equal(after1.options.sources[0].level, '官方', '显示证据等级');
  const card = (await stu.call('GET', '/mentors')).body.agents.find((a) => a.key === 'policy');
  assert.equal(card.version, 'v1.1');
  assert.ok(card.learning.note.includes('依据 1 份资料'), '学生端介绍卡显示版本与资料数');

  // 禁用资料：立即不再被检索
  await tea.call('PUT', `/teacher/mentors/policy/docs/${docId}`, { enabled: false });
  const after2 = await askPolicy(q);
  assert.ok(!after2.options?.sources && !after2.content.includes('[资料1]'), '禁用后不再引用');
  await tea.call('PUT', `/teacher/mentors/policy/docs/${docId}`, { enabled: true });
  assert.ok((await askPolicy(q)).options?.sources, '重新启用又能引用');

  // 回滚到 v1.0：资料不在那个版本里，于是不再引用
  const rb = await tea.call('POST', '/teacher/mentors/policy/rollback', { version: 'v1.0' });
  assert.equal(rb.body.version, 'v1.0');
  assert.ok(!(await askPolicy(q)).options?.sources, '回滚后恢复旧版本的回答');
  assert.equal((await stu.call('GET', '/mentors')).body.agents.find((a) => a.key === 'policy').version, 'v1.0');
  const versions = (await tea.call('GET', '/teacher/mentors/policy')).body.versions;
  assert.ok(versions.some((v) => v.version === 'v1.1' && v.change_note === '加入招生管理规定' && v.eval), '版本记录保留修改说明与测试结果');
  await tea.call('POST', '/teacher/mentors/policy/rollback', { version: 'v1.1' });
});

test('导师团会议里同样引用资料并显示来源', async () => {
  const s = await stu.call('POST', '/group/sessions', { mode: 'stuck' });
  const r = await stu.call('POST', `/group/sessions/${s.body.session.id}/send`, { text: '@明章 跨专业报考专业学位硕士有什么要求？' });
  const end = r.events.find((e) => e.ev === 'speaker_end' && e.data.key === 'policy');
  assert.ok(end, '明章发言了');
  assert.equal(end.data.sources[0]?.title, '研究生招生工作管理规定（节选）');
});

// ---------- 16.2 第5条：反馈学习 ----------

test('16.2-5：对砺行连续5次“没帮助：太严厉” → 生成改进建议 → 教师看不到整段私聊', async () => {
  for (let i = 0; i < 5; i += 1) {
    const r = await stu.call('POST', '/conv/companion/send', { text: `第${i + 1}次：我今天又没完成计划，任务清单上还有三项英语和两项专业课没有动。（以下是只给导师看的话）私密细节是我和室友吵架了`, agent_key: 'strict' });
    const msg = r.events.find((e) => e.ev === 'done').data.message;
    const fb = await stu.call('POST', '/mentors/strict/feedback', { helpful: false, reasons: ['太严厉'], message_ref: `msg:${msg.id}` });
    assert.equal(fb.status, 200);
  }
  assert.equal((await stu.call('POST', '/mentors/strict/feedback', { helpful: false, reasons: ['太严厉'], message_ref: 'msg:999999' })).status, 404, '不能引用别人的或不存在的回复');

  const fb = await tea.call('GET', '/teacher/mentors/strict/feedback');
  assert.equal(fb.body.summary.unhelpful, 5);
  assert.equal(fb.body.summary.tags['太严厉'], 5);
  const dump = JSON.stringify(fb.body);
  assert.ok(!dump.includes('和室友吵架'), '看不到学生发的原话（整段私聊）——只有被评价的那条导师回复');
  assert.ok(!dump.includes('林小雨') && !dump.includes('2024801'), '看不到是谁评的');
  assert.ok(fb.body.items.every((x) => x.reply), '只看到被评价的那条导师回复');

  const d = await tea.call('POST', '/teacher/mentors/strict/distill', {});
  assert.equal(d.status, 200, d.body?.error);
  assert.ok(d.body.patterns.some((p) => p.issue.includes('太严厉') && p.evidence_count === 5), '找出“太严厉”这个反复出现的问题');
  const prop = d.body.items.find((p) => p.status === 'pending');
  assert.ok(prop && prop.change && prop.reason && prop.risk, '有具体修改建议、理由与副作用');
  assert.ok(!JSON.stringify(d.body).includes('和室友吵架'), '蒸馏结果里没有私聊原话');
  const list = await tea.call('GET', '/teacher/mentors');
  assert.ok(list.body.mentors.find((m) => m.key === 'strict').pending_proposals >= 1);

  // 采纳 → 进草稿；发布前学生端不变，发布后生效；学生的记忆不被清空
  const memBefore = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').get(uid).n;
  const ad = await tea.call('POST', `/teacher/mentors/strict/proposals/${prop.id}`, { action: 'adopt' });
  assert.ok(ad.body.draft.persona.negatives.length >= 1);
  assert.ok(!mentorRuntime('strict', 'x').block.includes(prop.change.slice(0, 10)), '发布前不影响学生');
  await tea.call('POST', '/teacher/mentors/strict/publish', { change_note: '根据反馈减少严厉措辞' });
  assert.ok(mentorRuntime('strict', 'x').block.includes('不要这样做'), '发布后进入砺行的提示词');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').get(uid).n, memBefore, '版本更新不清空学生记忆');
  assert.ok((await stu.call('GET', '/mentors')).body.agents.find((a) => a.key === 'strict').learning.updated_this_week >= 1, '学生端看到本周更新了几处');
});

test('学生个人偏好只影响本人', async () => {
  const other = client();
  await register(other, '2024802', '周晓');
  await stu.call('PUT', '/me/mentor-prefs/strict', { style_pref: '多举例子' });
  const mine = db.prepare('SELECT style_pref FROM mentor_prefs WHERE user_id = ? AND mentor_key = ?').get(uid, 'strict');
  assert.equal(mine.style_pref, '多举例子');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mentor_prefs WHERE user_id != ? AND style_pref = ?').get(uid, '多举例子').n, 0);
});

// ---------- 经验库 ----------

test('经验库：至少3名同学才提炼；教师批准才生效；含个人信息不能批准；经验案例须匿名并有同意说明', async () => {
  const cs = [stu];
  for (let i = 3; i <= 4; i += 1) { const c = client(); await register(c, `202480${i}`, `同学${i}`); cs.push(c); }
  const ids = db.prepare("SELECT id FROM users WHERE role = 'student'").all().map((x) => x.id);
  for (const id of ids) db.prepare("INSERT INTO weekly_reviews(user_id, week_start, rate, blockers_json, adjust_json, summary, created_at) VALUES(?, '2026-10-05', 0.5, '[\"时间不够\"]', '[]', '这周有点乱', ?)").run(id, nowLocal());
  const g = await tea.call('POST', '/teacher/insights/generate', {});
  const it = g.body.created.find((x) => x.mentor_key === 'planner');
  assert.ok(it && it.insight.includes('时间不够'), '提炼出共性卡点');
  assert.ok(!/林小雨|周晓|同学3|2024801/.test(JSON.stringify(g.body)), '不含可识别个人的信息');
  assert.equal((await tea.call('POST', '/teacher/insights/generate', {})).body.created.length, 0, '不重复生成');
  const row = db.prepare("SELECT * FROM mentor_insights WHERE mentor_key = 'planner'").get();
  assert.ok(!mentorRuntime('planner', 'x').block.includes('时间不够'), '待审时不生效');
  assert.equal((await tea.call('PUT', '/teacher/insights', { id: row.id, status: 'approved', insight: '林小雨总是说时间不够' })).body.code, 'HAS_PII', '含学生姓名不能批准');
  await tea.call('PUT', '/teacher/insights', { id: row.id, status: 'approved' });
  assert.ok(mentorRuntime('planner', 'x').block.includes('时间不够'), '批准后进入知序的上下文');

  await tea.call('POST', '/teacher/experience-cases', { title: '跨考上岸', content: '本科文学，跨考学科教学，最难的是教育学综合，靠每天默写框架。' });
  const c = db.prepare('SELECT id FROM experience_cases').get();
  assert.equal((await tea.call('PUT', '/teacher/experience-cases', { id: c.id, approve: true })).body.code, 'NOT_ANON');
  assert.equal((await tea.call('PUT', '/teacher/experience-cases', { id: c.id, anonymized: true, approve: true })).body.code, 'NO_CONSENT');
  assert.equal((await tea.call('PUT', '/teacher/experience-cases', { id: c.id, anonymized: true, consent_note: '经本人书面同意', approve: true })).status, 200);
  assert.ok(mentorRuntime('senior', '跨考学科教学的教育学综合怎么准备').block.includes('教育学综合'), '渡舟引用审批过的经验');
});

// ---------- M16 教师后台 ----------

test('M16 概览、学生列表与详情；群发通知；重置密码；机构信息', async () => {
  const ov = await tea.call('GET', '/teacher/overview');
  assert.equal(ov.status, 200);
  assert.equal(ov.body.cards.find((c) => c.id === 'registered').value, 4);
  assert.equal(ov.body.funnel.length, 11);
  const list = await tea.call('GET', '/teacher/students');
  assert.equal(list.body.students.length, 4);
  const b = await tea.call('POST', '/teacher/broadcast', { title: '第3周提醒', text: '周日前完成周复盘。' });
  assert.equal(b.status, 200);
  assert.equal((await stu.call('GET', '/notices')).body.notices[0].title, '第3周提醒');
  const rp = await tea.call('POST', '/teacher/reset-password', { student_no: '2024802' });
  const c = client();
  assert.equal((await c.call('POST', '/login', { student_no: '2024802', password: rp.body.temp_password })).status, 200, '临时密码能登录');
  await tea.call('PUT', '/teacher/verified-materials', { text: '2027年研考网上报名时间以研招网公告为准。' });
  assert.ok((await tea.call('GET', '/teacher/verified-materials')).body.custom);
});

test('16.2-7：教师查看学生详情，看不到1:1对话、会议原文、分身档案与上传文件', async () => {
  await stu.call('POST', '/twin/consent', { agreed: true });
  await stu.call('POST', '/twin/uploads', { text: '我的自我介绍：喜欢古典诗词，秘密口令青铜鼎', filename: '介绍.txt', kind: '自我介绍' });
  const d = await tea.call('GET', `/teacher/students/${uid}`);
  assert.equal(d.status, 200);
  const dump = d.raw;
  assert.ok(!dump.includes('和室友吵架'), '看不到1:1对话');
  assert.ok(!dump.includes('跨专业报考专业学位硕士有什么要求'), '看不到会议原文');
  assert.ok(!dump.includes('青铜鼎') && !dump.includes('twin'), '看不到分身与上传文件');
  assert.ok(d.body.privacy.includes('看不到'));
  for (const p of ['/twin', '/twin/talks', '/memories', '/conv/companion', '/group/sessions']) {
    assert.equal((await tea.call('GET', p)).status, 403, `教师访问 ${p} 被拒`);
  }
});

// ---------- 第16章第12条：赛事 ----------

let judge;
test('16-12①：开启匿名模式后，全站搜不到真实校名和教师名', async () => {
  await tea.call('PUT', '/teacher/org', { school_name: '宝鸡文理学院', college_name: '文学与新闻传播学院', teacher_names: '王建国', extra_terms: '宝鸡' });
  // 让真实名字出现在各种地方：学生的输入、班级名、课程内容
  await stu.call('POST', '/kb/items', { space: 'prep', type: 'note', title: '王建国老师的课堂笔记', content: { body: '宝鸡文理学院文学与新闻传播学院，第3周' } });
  db.prepare("UPDATE classes SET name = '宝鸡文理学院2024级班' WHERE is_sandbox = 0").run();
  const leak = (s) => /宝鸡文理学院|宝鸡|文学与新闻传播学院|王建国|林小雨|周晓/.test(s);
  const before = await stu.call('GET', '/kb/items');
  assert.ok(leak(before.raw), '关闭时能看到真实名称（对照）');

  assert.equal((await tea.call('PUT', '/teacher/anonymous-mode', { enabled: true })).body.enabled, true);
  const pages = [
    [stu, '/me'], [stu, '/kb/items'], [stu, '/kb/report'], [stu, '/kb/report/print'], [stu, '/group/sessions'], [stu, '/twin'],
    [stu, '/assess/portfolio'], [stu, '/kb/export?format=csv'], [stu, '/conv/companion'],
    [tea, '/teacher/students'], [tea, `/teacher/students/${uid}`], [tea, '/teacher/overview'], [tea, '/teacher/grades'],
    [tea, '/teacher/grades/export'], [tea, '/teacher/impact'], [tea, '/teacher/impact/drill/registered'], [tea, '/teacher/org'], [tea, '/teacher/submissions?chapter=1'],
  ];
  for (const [c, p] of pages) {
    const r = await c.call('GET', p);
    assert.ok(r.status < 500, `${p} → ${r.status}`);
    assert.ok(!leak(r.raw || ''), `${p} 里还有真实名称：${(r.raw || '').match(/宝鸡文理学院|宝鸡|文学与新闻传播学院|王建国|林小雨|周晓/)?.[0]}`);
  }
  const me = await stu.call('GET', '/me');
  assert.match(me.body.me.name, /^学生\d{3}$/, '学生姓名替换成“学生001”');
  const kb = await stu.call('GET', '/kb/items');
  assert.ok(kb.raw.includes('教师A') && kb.raw.includes('某地方本科院校'), '替换成中性占位');
  // 流式对话（SSE）里也替换
  const sse = await stu.call('POST', '/conv/companion/send', { text: '王建国老师说宝鸡文理学院今年扩招', agent_key: 'strict' });
  assert.ok(!leak(sse.raw), 'SSE 流里也没有真实名称');
  // 导出文件
  const xlsx = await tea.call('GET', '/teacher/impact/export');
  const files = readZip(xlsx.buffer);
  assert.ok(files.every((f) => !leak(String(f.data))), 'Excel 导出里没有真实名称');
});

test('16-12②：评委测试账号体验沙箱；过期失效；沙箱邀请码不能自助注册', async () => {
  const sandbox = db.prepare('SELECT invite_code FROM classes WHERE is_sandbox = 1').get();
  assert.equal((await register(client(), 'selfjudge', '冒充评委', sandbox.invite_code)).body.code, 'SANDBOX');
  const g = await tea.call('POST', '/teacher/demo-accounts', { count: 2, days: 7, note: '评审组' });
  assert.equal(g.body.accounts.length, 2);
  judge = client();
  const acc = g.body.accounts[0];
  const lg = await judge.call('POST', '/login', { student_no: acc.student_no, password: acc.password });
  assert.equal(lg.status, 200);
  assert.equal(lg.body.me.is_demo, true);
  assert.ok(lg.body.me.expires_at);
  // 评委完整体验一段流程：出发准备 → 搭子对话 → 课堂任务
  await judge.call('POST', '/prepare/consent', { agreed: true });
  await judge.call('POST', '/prepare/modules-read', {});
  const def = await judge.call('GET', '/surveys/pre');
  const answers = {};
  for (const it of def.body.items) answers[it.key] = it.type === 'scale' ? 5 : it.options[4];
  await judge.call('POST', '/surveys/pre', { answers });
  await judge.call('PUT', '/me', { persona: 'gentle' });
  const chat = await judge.call('POST', '/conv/companion/send', { text: '你好，我是来体验的评委' });
  assert.equal(chat.status, 200);
  await judge.call('POST', '/chapters/1/tasks/t0', { content: { choice: 'A' } });
  // 调用上限：评委单独的每日上限
  setSetting('demo.daily_limit', '1');
  const over = await judge.call('POST', '/conv/companion/send', { text: '再聊一句' });
  assert.equal(over.status, 429, '超出评委每日上限');
  setSetting('demo.daily_limit', '40');
  // 过期
  db.prepare('UPDATE users SET expires_at = ? WHERE student_no = ?').run('2020-01-01 00:00:00', g.body.accounts[1].student_no);
  assert.equal((await client().call('POST', '/login', { student_no: g.body.accounts[1].student_no, password: g.body.accounts[1].password })).body.code, 'DEMO_EXPIRED');
});

test('16-12③：成效看板不包含演示数据；每个指标都能下钻；导出看板', async () => {
  await tea.call('PUT', '/teacher/anonymous-mode', { enabled: false });
  const imp = await tea.call('GET', '/teacher/impact');
  const m = Object.fromEntries(imp.body.metrics.map((x) => [x.id, x]));
  assert.equal(m.registered.value, 4, '评委账号不计入注册人数');
  const realCalls = db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE ok = 1 AND user_id IN (SELECT id FROM users WHERE role = 'student' AND is_demo = 0)").get().n;
  assert.equal(m.ai_calls.value, realCalls, 'AI 调用只算真实学生');
  const judgeId = db.prepare('SELECT id FROM users WHERE is_demo = 1 LIMIT 1').get().id;
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ?').get(judgeId).n > 0, '评委确实产生了调用（对照）');
  const sub = imp.body.metrics.find((x) => x.id === 'submissions');
  assert.ok(sub.formula, '每个指标都有计算口径');
  for (const x of imp.body.metrics) {
    assert.ok(x.formula, `${x.label} 有口径`);
    const d = await tea.call('GET', `/teacher/impact/drill/${x.id}`);
    assert.equal(d.status, 200, `${x.id} 可以下钻`);
    assert.ok(!JSON.stringify(d.body).includes('judge-'), `${x.id} 的原始记录里没有评委账号`);
  }
  const reg = await tea.call('GET', '/teacher/impact/drill/registered');
  assert.equal(reg.body.count, m.registered.value, '下钻记录数与指标一致');
  const xlsx = await tea.call('GET', '/teacher/impact/export');
  const files = readZip(xlsx.buffer);
  assert.ok(files.some((f) => f.name === 'xl/workbook.xml'), '合法的 xlsx');
  const sheet1 = files.find((f) => f.name === 'xl/worksheets/sheet1.xml').data;
  assert.ok(sheet1.includes('计算口径') && sheet1.includes('注册人数'));
  const log = await tea.call('GET', '/teacher/runlog');
  assert.ok(log.body.days.length >= 1 && log.body.days[0].total > 0, '运行日志有每日请求统计');
});
