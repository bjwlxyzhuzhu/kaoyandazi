// 阶段3自测：长期记忆（跨对话记忆测试）与干预规则 R1—R8（立即执行巡检测试）
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
// 本文件不配置 SMTP：验收要求“没有配置 SMTP 时系统照常运行”
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const { createApp } = await import('../src/app.js');
const { db, setSetting } = await import('../src/db.js');
const { todayLocal, addDays, nowLocal } = await import('../src/time.js');
const { applyMemoryUpdate, isSensitive, MEMORY_LIMIT, memoryCount } = await import('../src/memory.js');
const { evaluate, runChecksForAll, runChecksFor, pendingInterventions, chooseIntervention, interventionStats } = await import('../src/interventions.js');
const { mailConfigured } = await import('../src/mail.js');

// 测试环境关掉邮件（等价于教师后台关闭邮件提醒）：验收要求“没有配置 SMTP 时系统照常运行”，
// 同时避免测试真的往外发邮件。
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
      return { status: res.status, events };
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return { call };
}

const stu = client();
const tea = client();
let uid;

async function register(no, name) {
  const r = await stu.call('POST', '/register', {
    invite_code: 'TEST2026', student_no: no, name, email: `${no}@qq.com`,
    major: '汉语言文学', grade: '大二', major_group: '文史', password: 'password-123',
  });
  return r.body.me;
}

test('准备：注册一个学生并完成出发准备', async () => {
  const me = await register('2024201', '干预测试生');
  uid = me.id;
  await stu.call('POST', '/prepare/consent', { agreed: true });
  await stu.call('POST', '/prepare/modules-read', {});
  const def = await stu.call('GET', '/surveys/pre');
  const answers = {};
  for (const it of def.body.items) answers[it.key] = it.type === 'scale' ? 3 : it.options[1];
  await stu.call('POST', '/surveys/pre', { answers });
  await stu.call('PUT', '/me', { persona: 'gentle' });
  assert.equal((await stu.call('GET', '/me')).body.me.prepare_done, true);
});

test('M9：记忆写入规则（整理器输出）——最多3条、去重、超上限删最旧', () => {
  applyMemoryUpdate(uid, { add: [
    { content: '目标是当中学语文老师', category: '目标' },
    { content: '每周能投入14小时', category: '偏好' },
    { content: '担心专业课背不下来', category: '困难' },
    { content: '第四条不该被写入', category: '其他' },
  ], remove_ids: [] });
  assert.equal(memoryCount(uid), 3, '一次最多新增3条');
  applyMemoryUpdate(uid, { add: [{ content: '目标是当中学语文老师', category: '目标' }], remove_ids: [] });
  assert.equal(memoryCount(uid), 3, '重复内容不重复写入');

  // 塞满到上限，再新增一条应删掉最旧的
  for (let i = 0; i < MEMORY_LIMIT + 5; i += 1) {
    applyMemoryUpdate(uid, { add: [{ content: `记忆条目${i}`, category: '其他' }], remove_ids: [] });
  }
  assert.equal(memoryCount(uid), MEMORY_LIMIT, `记忆上限为 ${MEMORY_LIMIT} 条`);
  const oldest = db.prepare('SELECT content FROM memories WHERE user_id = ? ORDER BY id ASC LIMIT 1').get(uid);
  assert.notEqual(oldest.content, '目标是当中学语文老师', '超上限时删掉的是最旧的条目');
});

test('M9：身份证号、住址、电话、家庭经济、健康信息都不记', () => {
  assert.equal(isSensitive('身份证号 110101200501011234').blocked, true);
  assert.equal(isSensitive('住在西安市雁塔区某某小区3号楼').blocked, true);
  assert.equal(isSensitive('手机 13800001111').blocked, true);
  assert.equal(isSensitive('家里月收入不高，经济压力大').blocked, true);
  assert.equal(isSensitive('医生说我确诊了抑郁症').blocked, true);
  assert.equal(isSensitive('想自杀，觉得活着没意思').blocked, true, '危机信号要拦住');
  assert.equal(isSensitive('决定报考学科教学（语文）专硕').blocked, false, '正常内容要能记');

  const n = memoryCount(uid);
  applyMemoryUpdate(uid, { add: [{ content: '身份证号 110101200501011234', category: '其他' }], remove_ids: [] });
  assert.equal(memoryCount(uid), n, '敏感内容不写入');
});

test('M9：学生可以查看、手动添加、删除；教师看不到内容只看到条数', async () => {
  const list = await stu.call('GET', '/memories');
  assert.equal(list.status, 200);
  assert.ok(list.body.count > 0);
  assert.equal(list.body.limit, MEMORY_LIMIT);

  const chk = await stu.call('POST', '/memories/check', { content: '身份证号 110101200501011234' });
  assert.equal(chk.body.blocked, true);

  // 先腾出空间：上一条测试把记忆塞到了上限
  db.prepare('DELETE FROM memories WHERE user_id = ? AND content LIKE ?').run(uid, '记忆条目%');
  const room = memoryCount(uid);
  assert.ok(room < MEMORY_LIMIT);

  const add = await stu.call('POST', '/memories', { content: '想在大三下学期开始准备复试', category: '目标' });
  assert.equal(add.status, 200, add.body?.error || '');
  const id = add.body.memory.id;
  const del = await stu.call('DELETE', `/memories/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.body.count, room);

  // 满员时再添加会被拦下
  for (let i = room; i < MEMORY_LIMIT; i += 1) applyMemoryUpdate(uid, { add: [{ content: `占位${i}`, category: '其他' }], remove_ids: [] });
  const full = await stu.call('POST', '/memories', { content: '再多一条' });
  assert.equal(full.status, 400);
  assert.equal(full.body.code, 'FULL');
  db.prepare('DELETE FROM memories WHERE user_id = ? AND content LIKE ?').run(uid, '占位%');

  // 学生不能访问教师端接口
  assert.equal((await stu.call('GET', '/teacher/students/memory-stats')).status, 403);

  await tea.call('POST', '/login', { student_no: 'teacher', password: 'teacher-pass-123' });
  const stats = await tea.call('GET', '/teacher/students/memory-stats');
  const row = stats.body.students.find((s) => s.student_no === '2024201');
  assert.equal(row.memory_count, memoryCount(uid), '教师能看到记忆条数');
  assert.ok('last_message_at' in row);
  const raw = JSON.stringify(stats.body);
  assert.ok(!raw.includes('目标是当中学语文老师'), '教师端拿不到记忆内容');
});

test('M9 跨对话记忆测试（第16章第6步）：说出目标 → 新开对话还能记得', async () => {
  // 第一段对话：告诉搭子目标
  const first = await stu.call('POST', '/conv/companion/send', { text: '我的目标是考上西北大学的学科教学（语文）', agent_key: 'gentle' });
  assert.ok(first.events.some((e) => e.ev === 'done'));
  // 跨对话测试靠的是长期记忆，这里直接把整理结果写入（模拟整理器工作）
  applyMemoryUpdate(uid, { add: [{ content: '目标是考上西北大学的学科教学（语文）', category: '目标' }], remove_ids: [] });

  // 新开一段对话，问它记得什么
  const fresh = await stu.call('POST', '/conv/companion/send', { text: '你还记得我的目标吗', agent_key: 'gentle' });
  const done = fresh.events.find((e) => e.ev === 'done');
  assert.ok(done, '新对话正常返回');

  // 记忆确实进了这次请求的 system prompt
  const { companionPrompt } = await import('../src/prompts.js');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const sys = companionPrompt(user, 'gentle');
  assert.ok(sys.includes('目标是考上西北大学的学科教学（语文）'), '长期记忆进入系统提示词');
  assert.ok(sys.includes('长期记忆') || sys.includes('你记得他的事'));

  // 删除这条记忆后，再问一次就不再出现
  const mem = db.prepare("SELECT id FROM memories WHERE user_id = ? AND content LIKE '%西北大学%'").get(uid);
  await stu.call('DELETE', `/memories/${mem.id}`);
  const after = companionPrompt(db.prepare('SELECT * FROM users WHERE id = ?').get(uid), 'gentle');
  assert.ok(!after.includes('西北大学'), '删除后不再出现在上下文里');
});

test('M8：规则引擎按数据判断（R2 断卡 / R3 过载 / R6 周复盘）', async () => {
  const user = () => db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  // 先造一份方案和任务
  await stu.call('POST', '/menus/plan', { answers: { weekly_hours: 14, slots: ['晚上'], focus: ['英语'], research: '包含（推荐）', rhythm: '稳扎稳打' } });
  const g = await stu.call('POST', '/plan/generate', { body: {}, withKey: true });
  void g;
  const plan = await stu.call('POST', '/plan/generate', {});
  await stu.call('POST', '/plan/save', { plan: plan.body.plan });

  // 昨天和前天都没打卡 → R2
  db.prepare('DELETE FROM checkins WHERE user_id = ?').run(uid);
  let hits = evaluate(user(), new Date());
  assert.ok(!hits.some((h) => h.rule === 'R2'), '从没打过卡不触发 R2');
  db.prepare('INSERT INTO checkins(user_id, date, minutes, done_count, total_count, reflection, mood) VALUES(?, ?, 30, 1, 2, ?, 3)')
    .run(uid, addDays(todayLocal(), -3), '三天前打过一次卡');
  hits = evaluate(user(), new Date());
  assert.ok(hits.some((h) => h.rule === 'R2'), '有方案、曾打卡且昨前天都没打 → 触发 R2');

  // 近7天打卡≥3次且完成率<50% → R3
  db.prepare('DELETE FROM checkins WHERE user_id = ?').run(uid);
  for (const d of [0, 1, 2, 3]) {
    db.prepare('INSERT INTO checkins(user_id, date, minutes, done_count, total_count, reflection, mood) VALUES(?, ?, 10, 1, 4, ?, 3)')
      .run(uid, addDays(todayLocal(), -d), `第${d}天的复盘内容`);
  }
  hits = evaluate(user(), new Date());
  assert.ok(hits.some((h) => h.rule === 'R3'), '打卡4次、完成率25% → 触发 R3');
});

test('M8：同一类干预3天内不重复；没有 SMTP 时照常运行', async () => {
  assert.equal(mailConfigured(), false, '测试环境未配置 SMTP');
  const first = await runChecksForAll({ force: false });
  const mine = first.triggered.find((t) => t.user_id === uid);
  assert.ok(mine && mine.created.length > 0, '第一次巡检触发了干预');
  assert.ok(mine.created.every((c) => c.emailOnly || c.emailed === false), '没有 SMTP 时邮件未发送');
  assert.ok(mine.created.some((c) => /未配置 SMTP|邮件未发送|邮件提醒已关闭/.test(String(c.mailNote))), `邮件未发送且留下原因：${JSON.stringify(mine.created)}`);

  const second = await runChecksForAll({ force: false });
  const again = second.triggered.find((t) => t.user_id === uid);
  assert.equal(again, undefined, '3天内同类干预不重复触发');

  const forced = await runChecksForAll({ force: true });
  assert.ok(forced.triggered.some((t) => t.user_id === uid), '教师手动巡检可以强制触发');
});

test('M8：学生首页看到干预卡片，必须选一项；部分选项要求写原因', async () => {
  const list = await stu.call('GET', '/interventions');
  assert.ok(list.body.pending.length > 0);
  const card = list.body.pending[0];
  assert.ok(card.options.length >= 3 && card.options.length <= 4, '3—4个选项');
  assert.equal(card.chosen, null);

  // 错的选择
  assert.equal((await stu.call('POST', `/interventions/${card.id}/choose`, { choice: 'nope' })).status, 400);

  // 需要写原因的选项
  const needNote = card.options.find((o) => o.requireNote);
  if (needNote) {
    const bad = await stu.call('POST', `/interventions/${card.id}/choose`, { choice: needNote.key, note: '短' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'NEED_NOTE');
  }

  const ok = await stu.call('POST', `/interventions/${card.id}/choose`, { choice: card.options[0].key, note: '想先调整一下节奏' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.intervention.chosen, card.options[0].key);

  const after = await stu.call('GET', '/interventions');
  assert.ok(!after.body.pending.some((x) => x.id === card.id), '选过的不再出现在待处理里');
  assert.ok(after.body.done.some((x) => x.id === card.id), '进入历史记录');
});

test('M8：选“减量”会给下次方案生成加标记', async () => {
  // 造一张带减量选项的干预
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  const rows = await runChecksFor(user, { now: new Date(), force: true });
  assert.ok(rows.length > 0);
  const pending = pendingInterventions(uid);
  const reduceCard = pending.find((c) => c.options.some((o) => o.effect === 'reduce'));
  assert.ok(reduceCard, '有带“减量”选项的干预卡片');
  const reduceOption = reduceCard.options.find((o) => o.effect === 'reduce');
  const chosen = chooseIntervention(user, reduceCard.id, reduceOption.key, '任务确实多了');
  assert.equal(chosen.effect, 'reduce');
  const plan = db.prepare('SELECT reduce_flag FROM plans WHERE user_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(uid);
  assert.equal(plan.reduce_flag, 1, '方案被标记减量');

  // 减量后生成的方案，任务量比不减时少
  const { dailyCapMinutes } = await import('../src/routes/plan.js');
  const gen = await stu.call('POST', '/plan/generate', {});
  assert.equal(gen.status, 200);
  const total = gen.body.plan.week.flatMap((d) => d.tasks).reduce((n, t) => n + t.minutes, 0);
  const cap = dailyCapMinutes(14) * 7;
  assert.ok(total < cap, `减量后总时长 ${total} 应明显低于上限 ${cap}`);
});

test('M8：干预响应率可统计（成效看板指标）', () => {
  const stats = interventionStats();
  assert.ok(stats.total > 0);
  assert.ok(stats.chosen > 0);
  assert.ok(stats.rate > 0 && stats.rate <= 1);
  assert.ok(stats.byRule.length > 0);
});

test('M8：教师端“立即执行巡检”与邮件记录接口', async () => {
  assert.equal((await stu.call('POST', '/teacher/run-checks', {})).status, 403);
  const run = await tea.call('POST', '/teacher/run-checks', { force: true });
  assert.equal(run.status, 200);
  assert.ok(typeof run.body.students === 'number');
  const log = await tea.call('GET', '/teacher/mail-log');
  assert.equal(log.status, 200);
  assert.equal(log.body.configured, false);
  assert.ok(log.body.rows.length > 0, '未配置 SMTP 时也留下“未发送”的记录');
  assert.ok(log.body.rows.every((x) => x.ok === 0), '这些记录都是未发送');
  const bad = await tea.call('POST', '/teacher/test-mail', { to: '不是邮箱' });
  assert.equal(bad.status, 400);
});

test('7.6：首页“今天谁陪你”随当前站变化（第4站主讲是择川）', async () => {
  // 完成第2、3站：画像 → 选路径
  await stu.call('POST', '/menus/intake', { answers: { grade: '大二', major_group: '文史', tendency: '考研', weekly_hours: 14, english: '过四级', rank: '中等', achievements: ['暂无'], troubles: ['信息太乱'] } });
  const gen = await stu.call('POST', '/profile/generate', {});
  assert.equal(gen.status, 200);
  await stu.call('PUT', '/profile', { profile: gen.body.profile });
  await stu.call('POST', '/profile/choose', { path_id: 'kaoyan', reason: '我想当中学语文老师，读学科教学专硕是最直接的路径，我愿意为此投入两年时间。' });

  // 第1—3站已完成 → 当前站是第4站（选定目标），主讲导师是择川
  const today = await stu.call('GET', '/today');
  assert.equal(today.body.current, 4);
  assert.equal(today.body.station.name, '选定目标');
  assert.equal(today.body.mentors.primary.key, 'school', '第4站主讲是择川');
  assert.equal(today.body.mentors.co.key, 'policy', '协同导师是明章');

  // 第6站的主讲是学生自己选的陪伴导师
  const f = await stu.call('GET', '/flow');
  const st6 = f.body.stations.find((s) => s.station === 6);
  assert.equal(st6.name, '坚持执行');
  const { stationMentors } = await import('../src/stations.js');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
  assert.equal(stationMentors(user, 6).primary.key, 'gentle', '第6站用学生选的陪伴导师');
});
