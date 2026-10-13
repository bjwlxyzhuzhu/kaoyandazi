// 阶段1自测：注册 → 基础导师一轮带选项对话；两级 Key、额度、脱敏、选项解析、注册表兼容
// 运行：cd server && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.KEY_ENC_SECRET = 'test-key-enc-secret';
process.env.TEACHER_ACCOUNTS = 'teacher:teacher-pass-123';
process.env.DEFAULT_INVITE_CODE = 'TEST2026';
process.env.LLM_BASE_URL = '';
process.env.LLM_PLATFORM_KEY = '';

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');
const { splitReply } = await import('../src/llm/options.js');
const { resolvePersona, agents } = await import('../src/registry.js');

// 捕获全部日志，最后检查其中没有完整 Key
const logs = [];
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level];
  console[level] = (...args) => { logs.push(args.map(String).join(' ')); void orig; };
}

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
      const events = text.trim().split('\n\n').filter(Boolean).map((chunk) => {
        const ev = chunk.match(/^event: (.+)$/m)?.[1];
        const data = JSON.parse(chunk.match(/^data: (.+)$/m)?.[1] || 'null');
        return { ev, data };
      });
      return { status: res.status, events, raw: text };
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return { call };
}

const STUDENT = {
  invite_code: 'TEST2026', student_no: '2024001', name: '演示学生甲', email: 'demo@qq.com',
  major: '计算机科学与技术', grade: '大三', major_group: '理工', password: 'password-123',
};
const SECRET_KEY = 'sk-stage1secretKEY9876';

const stu = client();
const tea = client();

test('选项协议解析：代码块、裸 JSON、失败降级', () => {
  const ok = splitReply('你好\n\n```json\n{"options":[{"key":"A","label":"甲"},{"key":"B","label":"乙"}],"multi":false}\n```');
  assert.equal(ok.body, '你好');
  assert.equal(ok.block.options.length, 2);
  assert.equal(ok.block.free_text, true);

  const bare = splitReply('正文 {"options":[{"key":"A","label":"甲"},{"key":"B","label":"乙"}]}');
  assert.equal(bare.body, '正文');
  assert.equal(bare.block.options.length, 2);

  const broken = splitReply('正文\n```json\n{"options": [ 坏掉的 \n```');
  assert.equal(broken.body, '正文');
  assert.equal(broken.block, null, '解析失败时不返回选项');

  const tooFew = splitReply('正文\n```json\n{"options":[{"key":"A","label":"只有一个"}]}\n```');
  assert.equal(tooFew.block, null, '少于2个选项视为无效');
});

test('导师注册表：旧人设兼容映射', () => {
  assert.equal(resolvePersona('暖暖学姐'), 'gentle');
  assert.equal(resolvePersona('严老师'), 'strict');
  assert.equal(resolvePersona('军师'), 'strategist');
  assert.equal(resolvePersona('阿损'), 'playful');
  assert.equal(resolvePersona('栖云｜温和陪伴'), 'gentle');
  assert.equal(resolvePersona('不存在'), 'gentle');
  assert.ok(agents.length >= 26);
});

test('M1：邀请码错误无法注册；学号不能重复；密码哈希存储', async () => {
  const bad = await client().call('POST', '/register', { ...STUDENT, invite_code: 'WRONG' });
  assert.equal(bad.status, 400);

  const r = await stu.call('POST', '/register', STUDENT);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.me.persona, 'gentle');

  const dup = await client().call('POST', '/register', STUDENT);
  assert.equal(dup.status, 409);

  const row = db.prepare('SELECT pw_hash FROM users WHERE student_no = ?').get(STUDENT.student_no);
  assert.ok(row.pw_hash.startsWith('scrypt$'));
  assert.ok(!row.pw_hash.includes(STUDENT.password));
});

test('M1：学生访问教师接口返回403；教师可登录', async () => {
  const r = await stu.call('GET', '/teacher/llm');
  assert.equal(r.status, 403);
  const t = await tea.call('POST', '/login', { student_no: 'teacher', password: 'teacher-pass-123' });
  assert.equal(t.status, 200);
  assert.equal(t.body.me.role, 'teacher');
});

test('平台模型未配置时，基础模块给出中文提示', async () => {
  const r = await stu.call('POST', '/conv/companion/send', { text: '你好' });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /平台模型还没有配置好/);
});

test('教师配置平台模型（模拟模型）并测试连通；平台 Key 加密保存、只显示末4位', async () => {
  const r = await tea.call('PUT', '/teacher/llm', { base_url: 'mock', chat_model: 'mock-chat', platform_key: 'sk-platformKEY1234', basic_daily_limit: 60 });
  assert.equal(r.status, 200);
  assert.equal(r.body.platform_key_mask, 'sk-****1234');
  const stored = db.prepare("SELECT value FROM settings WHERE key = 'llm.platform_key_enc'").get().value;
  assert.ok(!stored.includes('platformKEY1234'), '平台 Key 不能明文入库');
  const t = await tea.call('POST', '/teacher/test-llm');
  assert.equal(t.status, 200);
  assert.ok(t.body.models.includes('mock-chat'));
});

test('未绑定 Key：基础模块可用，高阶模块显示需要绑定', async () => {
  const r = await stu.call('GET', '/me/modules');
  assert.equal(r.status, 200);
  const m = Object.fromEntries(r.body.modules.map((x) => [x.id, x.status]));
  assert.equal(m.M9_companion, 'available');
  assert.equal(m.M4_intake, 'available');
  assert.equal(m.M6_school, 'need_key');
  assert.equal(m.M15_lab, 'need_key');
});

let convId;
test('完成标志：学生注册后与基础导师完成一轮带选项的对话（SSE）', async () => {
  const r = await stu.call('POST', '/conv/companion/send', { text: '你好，我想聊聊最近的学习状态', agent_key: 'strict' });
  assert.equal(r.status, 200);
  const evs = r.events.map((e) => e.ev);
  assert.equal(evs[0], 'meta');
  assert.ok(evs.includes('delta'));
  assert.equal(evs.at(-1), 'done');
  const done = r.events.at(-1).data.message;
  assert.equal(done.agent_key, 'strict', '本次请求冻结所选导师');
  assert.ok(done.options.options.length >= 2 && done.options.options.length <= 5);
  assert.equal(done.options.free_text, true);
  assert.ok(!done.content.includes('```json'), '正文中不包含 JSON 代码块');
  convId = r.events[0].data.conv_id;

  // 点选选项作为下一条用户消息
  const pick = done.options.options[0];
  const r2 = await stu.call('POST', '/conv/companion/send', { conv_id: convId, text: `【选择】${pick.key}：${pick.label}` });
  assert.equal(r2.events.at(-1).ev, 'done');

  const g = await stu.call('GET', `/conv/companion?id=${convId}`);
  assert.equal(g.body.messages.length, 4);
  assert.equal(g.body.messages[1].role, 'assistant');

  const calls = db.prepare("SELECT * FROM ai_calls WHERE kind = 'M9_companion' AND ok = 1").all();
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.key_source === 'platform' && c.prompt_tokens > 0));
});

test('额度：教师把该生每日基础额度调为1次后，提示文案正确且输入不丢失', async () => {
  const q = await tea.call('PUT', `/teacher/quota/${STUDENT.student_no}`, { limit: 1 });
  assert.equal(q.status, 200);
  const before = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?').get(convId).n;
  const r = await stu.call('POST', '/conv/companion/send', { conv_id: convId, text: '今天还想再聊一句' });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, '今天的基础额度用完了，明天恢复；你也可以绑定自己的 Key 继续使用。');
  const afterN = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conv_id = ?').get(convId).n;
  assert.equal(afterN, before, '额度不足时不写入半截消息');
  const m = await stu.call('GET', '/me/modules');
  assert.equal(m.body.modules.find((x) => x.id === 'M9_companion').status, 'quota_exhausted');
});

test('学生自带 Key：测试连通、仅本机保存时不入库；高阶模块解锁；“基础也用我的 Key”', async () => {
  const t = await stu.call('POST', '/me/key/test', { key: SECRET_KEY });
  assert.equal(t.status, 200);
  const del = await stu.call('DELETE', '/me/key');
  assert.equal(del.body.me.key_saved_on_server, false);
  const row = db.prepare('SELECT key_enc FROM users WHERE student_no = ?').get(STUDENT.student_no);
  assert.equal(row.key_enc, null, '默认不入库');

  const m = await stu.call('GET', '/me/modules', null, { 'X-User-Key': SECRET_KEY });
  assert.equal(m.body.modules.find((x) => x.id === 'M6_school').status, 'available');

  await stu.call('PUT', '/me/key-preference', { use_own_key_basic: true });
  const r = await stu.call('POST', '/conv/companion/send', { conv_id: convId, text: '用我自己的 Key 继续' }, { 'X-User-Key': SECRET_KEY });
  assert.equal(r.events.at(-1).ev, 'done');
  const last = db.prepare('SELECT key_source FROM ai_calls ORDER BY id DESC LIMIT 1').get();
  assert.equal(last.key_source, 'user');
  await stu.call('PUT', '/me/key-preference', { use_own_key_basic: false });
});

test('可选：服务器加密保存学生 Key，只显示末4位', async () => {
  const r = await stu.call('PUT', '/me/key', { key: SECRET_KEY, save_on_server: true });
  assert.equal(r.body.me.key_saved_on_server, true);
  assert.equal(r.body.me.key_mask, 'sk-****9876');
  const row = db.prepare('SELECT key_enc FROM users WHERE student_no = ?').get(STUDENT.student_no);
  assert.ok(row.key_enc && !row.key_enc.includes('9876KEY') && !row.key_enc.includes(SECRET_KEY));
  const me = await stu.call('GET', '/me');
  assert.ok(!JSON.stringify(me.body).includes(SECRET_KEY));
  await stu.call('DELETE', '/me/key');
});

test('Key 无效、余额不足时给出明确提示，并保留输入', async () => {
  await stu.call('PUT', '/me/key-preference', { use_own_key_basic: true });
  const bad = await stu.call('POST', '/conv/companion/send', { conv_id: convId, text: '测试无效 Key' }, { 'X-User-Key': 'sk-invalid-0000' });
  const e1 = bad.events.at(-1);
  assert.equal(e1.ev, 'error');
  assert.equal(e1.data.code, 'USER_KEY_INVALID');
  assert.equal(e1.data.restore_text, '测试无效 Key');

  const poor = await stu.call('POST', '/conv/companion/send', { conv_id: convId, text: '测试余额' }, { 'X-User-Key': 'sk-nobalance-0000' });
  assert.equal(poor.events.at(-1).data.message, '你的 API 余额可能不足，请到中转站充值后再试');
  await stu.call('PUT', '/me/key-preference', { use_own_key_basic: false });

  const n = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content IN ('测试无效 Key', '测试余额')").get().n;
  assert.equal(n, 0, '失败的一轮不留下半截消息');
});

test('班级月度预算用完：基础模块暂停并提示', async () => {
  await tea.call('PUT', `/teacher/quota/${STUDENT.student_no}`, { limit: null });
  await tea.call('PUT', '/teacher/llm', { monthly_token_budget: 1 });
  const v = await tea.call('GET', '/teacher/llm');
  assert.equal(v.body.month.blocked, true);
  const r = await stu.call('POST', '/conv/companion/send', { conv_id: convId, text: '预算测试' });
  assert.equal(r.status, 429);
  assert.match(r.body.error, /本月班级的基础模块额度已经用完/);
  await tea.call('PUT', '/teacher/llm', { monthly_token_budget: 0 });
});

test('GET /mentors 返回注册表与版本', async () => {
  const r = await stu.call('GET', '/mentors');
  assert.equal(r.status, 200);
  const gentle = r.body.agents.find((a) => a.key === 'gentle');
  assert.equal(gentle.name, '栖云');
  assert.equal(gentle.duty, '温和陪伴');
  assert.equal(gentle.version, 'v1.0');
});

test('全部数据表已建立（第8章）', () => {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table')").all().map((r) => r.name));
  const expected = ['users', 'classes', 'settings', 'flow_status', 'menu_answers', 'profiles', 'profile_history', 'conversations', 'messages',
    'ai_calls', 'ai_actions', 'memories', 'schools', 'plans', 'tasks', 'checkins', 'weekly_reviews', 'submissions', 'peer_reviews',
    'achievements', 'interventions', 'mail_log', 'kb_items', 'papers', 'reading_cards', 'topics', 'topic_ideas', 'reading_logs',
    'mock_interviews', 'interview_qbank', 'action_plans', 'grades', 'surveys', 'mentors', 'mentor_versions', 'mentor_docs',
    'mentor_chunks', 'mentor_chunks_fts', 'mentor_evalsets', 'mentor_feedback', 'mentor_insights', 'mentor_student_memory', 'mentor_prefs',
    'experience_cases', 'group_sessions', 'group_messages', 'twins', 'twin_uploads', 'twin_corrections', 'twin_conversations'];
  const missing = expected.filter((n) => !names.has(n));
  assert.deepEqual(missing, []);
});

test('日志中看不到完整 Key', () => {
  const all = logs.join('\n');
  for (const k of [SECRET_KEY, 'sk-platformKEY1234', 'sk-invalid-0000', 'sk-nobalance-0000']) {
    assert.ok(!all.includes(k), `日志中出现了完整 Key：${k.slice(0, 6)}…`);
  }
});
