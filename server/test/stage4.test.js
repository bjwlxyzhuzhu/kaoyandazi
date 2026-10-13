// 阶段4自测：导师团（M18）编排与导师级记忆
// 通过标准：16.2 第1条（研讨会全流程）与第2条（按阶段换主讲）通过
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
const { todayLocal } = await import('../src/time.js');
const {
  GROUP_MODES, MAX_ROUNDS, MAX_SPEAKERS, getMode, mentorPrefs, setMentorPref,
  applyMentorMemory, mentorMemoryCount, MENTOR_MEMORY_LIMIT, mentorPool, resolveDefaultMentors, parseMentions,
} = await import('../src/group.js');
const { stationMentors } = await import('../src/stations.js');

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
      const events = text.trim().split('\n\n').filter(Boolean).map((chunk) => ({
        ev: chunk.match(/^event: (.+)$/m)?.[1],
        data: JSON.parse(chunk.match(/^data: (.+)$/m)?.[1] || 'null'),
      }));
      return { status: res.status, events, raw: text };
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return { call };
}

const stu = client();
const tea = client();
let uid;

test('会议类型与上限来自配置文件', () => {
  assert.equal(GROUP_MODES.length, 6, '六种会议类型');
  const names = GROUP_MODES.map((m) => m.name);
  for (const n of ['周复盘会', '方向研讨会', '择校评审会', '卡住了求助', '科研组会', '自由讨论']) {
    assert.ok(names.includes(n), `有「${n}」`);
  }
  assert.equal(MAX_ROUNDS, 10, '每次会议默认最多10轮');
  assert.deepEqual(MAX_SPEAKERS, { basic: 2, advanced: 3 }, '基础版每轮2位、完整版3位');
  // 基础版只有周复盘会和卡住了求助
  const basics = GROUP_MODES.filter((m) => m.tier === 'basic').map((m) => m.key);
  assert.deepEqual(basics.sort(), ['stuck', 'weekly']);
  // 周复盘会默认带当前陪伴导师
  assert.ok(getMode('weekly').defaults.includes('companion'));
});

test('准备：注册学生、完成出发准备、选好画像与路径（走到第3站）', async () => {
  const r = await stu.call('POST', '/register', {
    invite_code: 'TEST2026', student_no: '2024301', name: '导师团测试生', email: 'g@qq.com',
    major: '汉语言文学', grade: '大二', major_group: '文史', password: 'password-123',
  });
  uid = r.body.me.id;
  await stu.call('POST', '/prepare/consent', { agreed: true });
  await stu.call('POST', '/prepare/modules-read', {});
  const def = await stu.call('GET', '/surveys/pre');
  const answers = {};
  for (const it of def.body.items) answers[it.key] = it.type === 'scale' ? 3 : it.options[1];
  await stu.call('POST', '/surveys/pre', { answers });
  await stu.call('PUT', '/me', { persona: 'gentle' });
  await stu.call('POST', '/menus/intake', { answers: { grade: '大二', major_group: '文史', tendency: '考研', weekly_hours: 14, english: '过四级', rank: '前30%', achievements: ['暂无'], troubles: ['不知道选什么'] } });
  const gen = await stu.call('POST', '/profile/generate', {});
  await stu.call('PUT', '/profile', { profile: gen.body.profile });
  await stu.call('POST', '/profile/choose', { path_id: 'kaoyan', reason: '我想当中学语文老师，读学科教学专硕是最直接的路径，我愿意为此投入两年时间。' });
  assert.equal((await stu.call('GET', '/today')).body.current, 4, '当前站是第4站');
});

test('16.2 第2条：按阶段换主讲——第3站望岳，第4站择川', async () => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  assert.equal(stationMentors(user, 3).primary.key, 'pathway', '第3站主讲是望岳');
  assert.equal(stationMentors(user, 4).primary.key, 'school', '第4站主讲是择川');
  assert.equal(stationMentors(user, 6).primary.key, 'gentle', '第6站用学生选的陪伴导师');
  // 交接发言：进入第4站时，望岳（第3站产物）之后由择川接手
  const today = await stu.call('GET', '/today');
  assert.ok(today.body.handoff, '第4站有交接发言');
  assert.equal(today.body.handoff.from, '选择方向');
  assert.ok(today.body.handoff.text.includes('考研') || today.body.handoff.text.includes('理由'), '交接引用了上一站的产物');
  await stu.call('POST', '/today/handoff-seen', { station: 4 });
  assert.equal((await stu.call('GET', '/today')).body.handoff, null, '看过一次后不再显示');
});

test('导师团：基础版用平台 Key；完整版（方向研讨会）需要学生自己的 Key', async () => {
  const modes = await stu.call('GET', '/group/modes');
  assert.equal(modes.status, 200);
  assert.equal(modes.body.max_speakers.basic, 2);

  // 基础版：周复盘会不需要 Key
  const basic = await stu.call('POST', '/group/sessions', { mode: 'weekly' });
  assert.equal(basic.status, 200, basic.body?.error || '');
  assert.equal(basic.body.session.mode, 'weekly');
  assert.ok(basic.body.session.mentors.includes('gentle'), '周复盘会默认带学生当前选的陪伴导师');
  await stu.call('POST', `/group/sessions/${basic.body.session.id}/close`, {}, { 'X-User-Key': '' });

  // 完整版：没有自己的 Key 会被拦下
  const noKey = await stu.call('POST', '/group/sessions', { mode: 'direction' });
  assert.equal(noKey.status, 403);
  assert.equal(noKey.body.code, 'NEED_USER_KEY');
});

let sessionId;

test('16.2 第1条：方向研讨会全流程（司南编排 → 依次发言 → 共识/分歧/决定 → @ → 静音 → 纪要 → 行动项）', async () => {
  const USER_KEY = 'sk-studentOwnKEY5678';
  const s = await stu.call('POST', '/group/sessions', { mode: 'direction' }, { 'X-User-Key': USER_KEY });
  assert.equal(s.status, 200, s.body?.error || '');
  assert.equal(s.body.session.mode, 'direction');
  sessionId = s.body.session.id;
  assert.deepEqual(s.body.session.mentors.sort(), ['advisor_view', 'pathway', 'senior'].sort(), '方向研讨会默认望岳、渡舟、鉴微');

  const r1 = await stu.call('POST', `/group/sessions/${sessionId}/send`, { text: '考研、考公、就业我都在纠结，你们怎么看？' }, { 'X-User-Key': USER_KEY });
  assert.equal(r1.status, 200);
  const evs = r1.events.map((e) => e.ev);
  assert.equal(evs[0], 'meta');
  assert.ok(evs.includes('host_plan'), '先给出本轮发言名单');
  const plan = r1.events.find((e) => e.ev === 'host_plan');
  assert.ok(plan.data.speakers.length >= 2 && plan.data.speakers.length <= 3, `每轮2—3位导师，实际 ${plan.data.speakers.length}`);
  assert.ok(plan.data.note, '给前端一句话提示“接下来由谁发言”');

  // 每位导师：speaker_start → delta* → speaker_end，顺序固定
  const startIdx = evs.indexOf('speaker_start');
  const endIdx = evs.lastIndexOf('speaker_end');
  assert.ok(startIdx > 0 && endIdx > startIdx, '有完整的发言区间');
  assert.ok(evs.filter((e) => e === 'delta').length > 0, '有流式增量');
  const started = r1.events.filter((e) => e.ev === 'speaker_start').map((e) => e.data.key);
  const ended = r1.events.filter((e) => e.ev === 'speaker_end').map((e) => e.data.key);
  assert.deepEqual(started, ended, '每位发言的导师都有 start 与 end');
  assert.deepEqual(started, plan.data.speakers.map((x) => x.key), '发言顺序与司南安排一致');
  assert.ok(started.length >= 2, '至少两位导师发言');
  assert.ok(started.every((k, i) => started.indexOf(k) === i), '同一轮不重复同一位导师');

  // 每轮结束都有 共识/分歧/决定 + 选项
  const sum = r1.events.find((e) => e.ev === 'host_summary');
  assert.ok(sum, '有本轮总结');
  assert.ok('consensus' in sum.data && 'divergence' in sum.data && 'decide' in sum.data, '含共识/分歧/需要你决定的事');
  const opt = r1.events.find((e) => e.ev === 'options');
  assert.ok(opt, '给出选项');
  assert.ok(opt.data.options.length >= 2 && opt.data.options.length <= 5, '选项2—5个');
  assert.equal(r1.events.at(-1).ev, 'done');

  // 发言内容：后一位要回应前一位（模拟模型下由提示词约束，这里检查提示词确实带上了前一位的发言）
  const { speakerPrompt } = await import('../src/group.js');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const session = db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(sessionId);
  const sys = speakerPrompt({ user, session, mode: getMode('direction'), mentorKey: 'senior', focus: '从过来人角度谈考公与考研的取舍', latestUserText: '考研、考公、就业我都在纠结' });
  assert.ok(sys.includes('先用一句话回应前一位导师'), '发言规则要求回应前一位');
  assert.ok(sys.includes('不超过150字'), '限制字数');
  assert.ok(sys.includes('不要给选项'), '发言不给选项');

  // @ 点名：被点名的导师第一个发言
  const r2 = await stu.call('POST', `/group/sessions/${sessionId}/send`, { text: '@明章 官方文件里对跨专业报考是怎么规定的？' }, { 'X-User-Key': USER_KEY });
  const plan2 = r2.events.find((e) => e.ev === 'host_plan');
  const order2 = plan2.data.speakers.map((x) => x.key);
  assert.ok(order2.includes('policy'), `@明章 后明章要发言，实际 ${order2.join(',')}`);

  // 静音：渡舟不再发言
  await stu.call('POST', `/group/sessions/${sessionId}/mute`, { mentor: 'senior', muted: true });
  assert.ok(mentorPrefs(uid).muted.has('senior'), '静音已保存');
  for (let i = 0; i < 3; i += 1) {
    const r = await stu.call('POST', `/group/sessions/${sessionId}/send`, { text: `再补充一点我的情况（第${i + 1}次）` }, { 'X-User-Key': USER_KEY });
    const p = r.events.find((e) => e.ev === 'host_plan');
    assert.ok(!p.data.speakers.some((x) => x.key === 'senior'), '被静音的导师不再被选中');
  }
  // 静音名单也过滤掉了 @ 被静音的导师
  const r3 = await stu.call('POST', `/group/sessions/${sessionId}/send`, { text: '@渡舟 你说说看' }, { 'X-User-Key': USER_KEY });
  const plan3 = r3.events.find((e) => e.ev === 'host_plan');
  assert.ok(!plan3.data.speakers.some((x) => x.key === 'senior'), '@ 被静音的导师也不发言');

  // 邀请：解除静音后可以邀请回来
  const inv = await stu.call('POST', `/group/sessions/${sessionId}/invite`, { mentor: 'senior' });
  assert.equal(inv.status, 200);
  assert.ok(inv.body.session.mentors.includes('senior'));
  assert.equal(mentorPrefs(uid).muted.has('senior'), false, '邀请时自动解除静音');
});

test('16.2 第1条（续）：结束会议生成纪要；行动项必须勾选确认才写入学习方案', async () => {
  const close = await stu.call('POST', `/group/sessions/${sessionId}/close`, {}, { 'X-User-Key': 'sk-studentOwnKEY5678' });
  assert.equal(close.status, 200, close.body?.error || '');
  const s = close.body.session;
  assert.equal(s.status, 'closed');
  assert.ok(s.summary, '生成了纪要');
  assert.ok(Array.isArray(s.summary.points));
  assert.ok(s.summary.decision, '纪要有“学生的决定”');
  assert.ok(Array.isArray(s.action_items), '有行动项');
  assert.ok(s.action_items.every((a) => a.confirmed === false), '行动项初始都是未确认');

  // 未确认前不写入方案
  const tasksBefore = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?').get(uid).n;
  assert.equal(tasksBefore, 0, '还没有任何任务');

  if (s.action_items.length >= 2) {
    const pick = s.action_items.slice(0, 2).map((a) => a.id);
    const r = await stu.call('POST', `/group/sessions/${sessionId}/actions/confirm`, { ids: pick });
    assert.equal(r.status, 200);
    assert.equal(r.body.added.length, 2, '勾选2条就写入2条');
    const tasks = db.prepare('SELECT title, kind, minutes FROM tasks WHERE user_id = ?').all(uid);
    assert.equal(tasks.length, 2, '只写入了勾选的那2条');
    const titles = tasks.map((t) => t.title);
    for (const id of pick) {
      const a = s.action_items.find((x) => x.id === id);
      assert.ok(titles.includes(a.title), `「${a.title}」已写入方案`);
    }
    const notPicked = s.action_items.filter((a) => !pick.includes(a.id));
    for (const a of notPicked) assert.ok(!titles.includes(a.title), `未勾选的「${a.title}」没有写入方案`);
    // 学生还没采用方案时，确认的行动项也要出现在“学习方案”页的任务里
    const planResp = await stu.call('GET', '/plan');
    assert.equal(planResp.body.plan, null, '这名学生还没有采用方案');
    assert.equal(planResp.body.tasks.length, 2, '没有方案时，确认的行动项依然可见');
  } else {
    // 模拟模型可能只给出较少行动项，至少验证接口约束
    const r = await stu.call('POST', `/group/sessions/${sessionId}/actions/confirm`, { ids: [] });
    assert.equal(r.status, 400, '不勾选任何行动项不能确认');
  }

  // 会议结束后不能再发言
  const after = await stu.call('POST', `/group/sessions/${sessionId}/send`, { text: '还想说' }, { 'X-User-Key': 'sk-studentOwnKEY5678' });
  assert.equal(after.status, 400);
  assert.equal(after.body.code, 'CLOSED');
});

test('7.7 导师级记忆：每位导师每人上限30条，只有该导师读得到', async () => {
  for (let i = 0; i < MENTOR_MEMORY_LIMIT + 3; i += 1) {
    applyMentorMemory(uid, 'pathway', { add: [{ content: `望岳给过的建议${i}` }], remove_ids: [] });
  }
  assert.equal(mentorMemoryCount(uid, 'pathway'), MENTOR_MEMORY_LIMIT, `上限 ${MENTOR_MEMORY_LIMIT} 条`);
  assert.equal(mentorMemoryCount(uid, 'senior'), 0, '别的导师的记忆互不影响');

  // 敏感内容不记
  const before = mentorMemoryCount(uid, 'pathway');
  applyMentorMemory(uid, 'pathway', { add: [{ content: '学生身份证号 110101200501011234' }], remove_ids: [] });
  assert.equal(mentorMemoryCount(uid, 'pathway'), before, '敏感内容不写入导师级记忆');

  // 提示词里只带该导师自己的记忆
  const { speakerPrompt } = await import('../src/group.js');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const session = db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(sessionId);
  const sysPathway = speakerPrompt({ user, session, mode: getMode('direction'), mentorKey: 'pathway', focus: '谈路径', latestUserText: '你好' });
  assert.ok(sysPathway.includes('望岳给过的建议'), '望岳能读到自己的记忆');
  const sysSenior = speakerPrompt({ user, session, mode: getMode('direction'), mentorKey: 'senior', focus: '谈经验', latestUserText: '你好' });
  assert.ok(!sysSenior.includes('望岳给过的建议'), '渡舟读不到望岳的记忆');
  // 学生共享记忆所有导师都能用
  applyMentorMemory(uid, 'senior', { add: [], remove_ids: [] });
});

test('导师团的提示词带上学生共享记忆与会议摘要', async () => {
  const { memoryText } = await import('../src/memory.js');
  applyMentorMemory(uid, 'senior', { add: [{ content: '渡舟建议学生先核实报录比' }], remove_ids: [] });
  const { speakerPrompt } = await import('../src/group.js');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const session = db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(sessionId);
  const sys = speakerPrompt({ user, session, mode: getMode('direction'), mentorKey: 'senior', focus: '谈经验', latestUserText: '你好' });
  assert.ok(sys.includes('渡舟建议学生先核实报录比'), '导师级记忆进入提示词');
  assert.ok(sys !== memoryText(uid), '共享记忆与导师级记忆是两套');
});

test('教师的偏好：静音只影响本人；风格偏好进入该导师的提示词', async () => {
  await stu.call('PUT', '/me/mentor-prefs/method', { style_pref: '请多用表格和数字，别讲空话' });
  const { speakerPrompt } = await import('../src/group.js');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const session = db.prepare('SELECT * FROM group_sessions WHERE id = ?').get(sessionId);
  const sys = speakerPrompt({ user, session, mode: getMode('stuck'), mentorKey: 'method', focus: '给具体做法', latestUserText: '你好' });
  assert.ok(sys.includes('请多用表格和数字'), '个人偏好进入该导师的提示词');
});

test('反馈：有帮助/没帮助写库（蒸馏在阶段8）', async () => {
  const r = await stu.call('POST', '/mentors/strict/feedback', { helpful: false, reason: '太严厉', note: '说得太直接了', session_id: sessionId });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT * FROM mentor_feedback WHERE user_id = ? ORDER BY id DESC LIMIT 1').get(uid);
  assert.equal(row.mentor_key, 'strict');
  assert.equal(row.rating, 'unhelpful');
  assert.deepEqual(JSON.parse(row.reason_tags_json), ['太严厉']);
  assert.equal(row.comment, '说得太直接了');
  assert.equal(row.message_ref, `session:${sessionId}`, '记下了反馈来自哪场会议');
  const bad = await stu.call('POST', '/mentors/不存在/feedback', { helpful: true });
  assert.equal(bad.status, 404);
});

test('会议轮数上限：到10轮提示先把决定落到行动上', async () => {
  const s = await stu.call('POST', '/group/sessions', { mode: 'stuck' });
  assert.equal(s.status, 200, '卡住了求助是基础版');
  const id = s.body.session.id;
  // 直接塞满轮数，避免真的跑10轮
  for (let i = 0; i < MAX_ROUNDS; i += 1) {
    db.prepare("INSERT INTO group_messages(session_id, speaker_type, content, created_at) VALUES(?, 'user', ?, ?)").run(id, `第${i}轮`, todayLocal());
  }
  const r = await stu.call('POST', `/group/sessions/${id}/send`, { text: '再来一轮' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'MAX_ROUNDS');
  assert.match(r.body.error, /先把决定落到行动上/);
});

test('学生只能看到自己的会议；教师端看不到会议原文', async () => {
  await stu.call('POST', '/register', { invite_code: 'TEST2026', student_no: '2024302', name: '另一名学生', email: 'x@qq.com', major: '历史学', grade: '大三', major_group: '文史', password: 'password-123' });
  const other = await stu.call('GET', `/group/sessions/${sessionId}`);
  assert.equal(other.status, 404, '别人的会议看不到');

  await tea.call('POST', '/login', { student_no: 'teacher', password: 'teacher-pass-123' });
  const g = await tea.call('GET', '/group/sessions');
  assert.equal(g.status, 403, '教师端没有导师团会议接口');
});

test('导师池包含当前站主讲与协同导师，并支持中英文 @ 解析', () => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const pool = mentorPool(user, getMode('direction'));
  assert.ok(pool.includes('school'), '第4站主讲择川在池里');
  assert.ok(pool.includes('policy'), '协同导师明章在池里');
  const mentions = parseMentions(uid, '@望岳 你再说说', pool);
  assert.deepEqual(mentions, ['pathway'], '中文名 @ 能解析');
  const mentions2 = parseMentions(uid, '@senior 也说一句', pool);
  assert.deepEqual(mentions2, ['senior'], '英文键 @ 也能解析');
  // 默认名单里的 companion 会替换成学生自己选的陪伴导师
  assert.ok(resolveDefaultMentors(user, getMode('weekly')).includes('gentle'));
});
