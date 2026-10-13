// 阶段2自测：完成标志——学生从注册走到第5站并完成一次打卡；以及 M1—M7 的关键验收点
// 运行：cd server && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
const { db } = await import('../src/db.js');
const { addDays, mondayOf, todayLocal } = await import('../src/time.js');
const { assertPublicUrl } = await import('../src/search/tools.js');
const { dailyCapMinutes } = await import('../src/routes/plan.js');

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
    if (type.includes('text/csv')) {
      // 按字节读：res.text() 会自动去掉开头的 BOM
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, text: new TextDecoder().decode(bytes) };
    }
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return { call };
}

const stu = client();
const tea = client();
const USER_KEY = 'sk-studentOwnKEY5678';

const flowOf = async (no) => (await stu.call('GET', '/flow')).body.stations.find((s) => s.station === no).status;

test('日期工具：跨时区不会错一天', () => {
  assert.equal(addDays('2026-10-12', 1), '2026-10-13');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(mondayOf('2026-10-12'), '2026-10-12', '2026-10-12 是周一');
  assert.equal(mondayOf('2026-10-18'), '2026-10-12', '周日归到本周一');
  assert.equal(dailyCapMinutes(21), 216, '21小时/周 → 每天上限 21÷7×1.2×60 = 216 分钟');
});

test('M1：注册后先走出发准备，未完成时 prepare_done 为 false', async () => {
  const r = await stu.call('POST', '/register', {
    invite_code: 'TEST2026', student_no: '2024101', name: '测试学生乙', email: 'b@qq.com',
    major: '汉语言文学', grade: '大二', major_group: '文史', password: 'password-123',
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.me.prepare_done, false);
  const p = await stu.call('GET', '/prepare');
  assert.deepEqual(p.body.steps.map((s) => s.key), ['consent', 'modules', 'survey', 'persona']);
  assert.equal(p.body.done, false);
});

test('M1：不勾选同意不能继续；四步走完后第1站完成', async () => {
  const no = await stu.call('POST', '/prepare/consent', { agreed: false });
  assert.equal(no.status, 400);
  assert.equal((await stu.call('POST', '/prepare/consent', { agreed: true })).status, 200);
  assert.equal((await stu.call('POST', '/prepare/modules-read', {})).status, 200);

  const def = await stu.call('GET', '/surveys/pre');
  assert.equal(def.body.items.length, 10, '附录F：8道能力自评 + 2道行为题');
  const bad = await stu.call('POST', '/surveys/pre', { answers: { ability_1: 3 } });
  assert.equal(bad.status, 400, '没填完不能提交');
  const answers = {};
  for (const it of def.body.items) answers[it.key] = it.type === 'scale' ? 3 : it.options[1];
  assert.equal((await stu.call('POST', '/surveys/pre', { answers })).status, 200);

  await stu.call('PUT', '/me', { persona: 'strategist' });
  const me = await stu.call('GET', '/me');
  assert.equal(me.body.me.prepare_done, true);
  assert.equal(await flowOf(1), 'done');
});

test('M2：测验答案不随页面下发，服务端判分；提交课堂任务不会把已完成的第1站改回进行中', async () => {
  const ch = await stu.call('GET', '/chapters/1');
  assert.equal(ch.status, 200);
  assert.equal(ch.body.courseware.pages.length, 16, '附录A：16页课件');
  assert.ok(ch.body.courseware.pages.every((p) => p.note === undefined), '学生端不含教师备注');
  const quiz = ch.body.tasks.find((t) => t.id === 't1');
  const raw = JSON.stringify(quiz);
  assert.ok(!raw.includes('"answer"') && !raw.includes('"why"'), '测验答案与解析不下发');

  const r = await stu.call('POST', '/chapters/1/tasks/t1', { content: { answers: { 1: '官方', 2: '院校', 3: '经验帖', 4: 'AI推断', 5: '经验帖', 6: '官方' } } });
  assert.equal(r.status, 200);
  assert.equal(r.body.correct, 5);
  assert.equal(r.body.score, 83);
  assert.equal((await stu.call('POST', '/chapters/1/tasks/t1', { content: { answers: { 1: '官方' } } })).status, 409, '测验只能提交一次');

  const poll = await stu.call('POST', '/chapters/1/tasks/t0', { content: { choice: 'A' } });
  assert.equal(poll.status, 200);
  const dist = await stu.call('GET', '/chapters/1/tasks/t0/distribution');
  assert.equal(dist.body.counts.A, 1);

  const t4 = await stu.call('POST', '/chapters/1/tasks/t4', { content: { rules: ['不提交AI代写的作业和材料'], own_rule: '自己写' } });
  assert.equal(t4.status, 400, '承诺至少勾3条');

  assert.equal(await flowOf(1), 'done');
});

test('M2：教师看提交名单、导出CSV（UTF-8 BOM）、解锁章节；学生不能访问', async () => {
  assert.equal((await stu.call('GET', '/teacher/submissions?chapter=1')).status, 403);
  await tea.call('POST', '/login', { student_no: 'teacher', password: 'teacher-pass-123' });
  const s = await tea.call('GET', '/teacher/submissions?chapter=1');
  const t1 = s.body.tasks.find((t) => t.id === 't1');
  assert.equal(t1.submitted, 1);
  assert.equal(t1.students[0].name, '测试学生乙');
  const csv = await tea.call('GET', '/teacher/submissions/export?chapter=1');
  assert.equal(csv.status, 200);
  assert.equal(csv.bom, true, 'CSV 带 BOM，Excel 打开不乱码');
  assert.ok(csv.text.includes('测试学生乙'));
  const cw = await tea.call('GET', '/teacher/chapters/1');
  assert.ok(cw.body.courseware.pages.some((p) => p.note), '教师版课件含备注');
});

test('M4：菜单题（不调用模型）→ 追问一轮 → 生成画像（至少1条非考研路径）→ 确认后第2站完成', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM ai_calls').get().n;
  const bad = await stu.call('POST', '/menus/intake', { answers: { grade: '大二' } });
  assert.equal(bad.status, 400);
  const menu = await stu.call('POST', '/menus/intake', { answers: {
    grade: '大二', major_group: '文史', tendency: '还没想好', weekly_hours: 21, english: '过四级',
    rank: '前30%', achievements: ['暂无'], troubles: ['不知道选什么', '家人意见'],
  } });
  assert.equal(menu.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ai_calls').get().n, before, '菜单阶段不调用大模型');

  const chat = await stu.call('POST', '/conv/intake/send', { text: '我其实挺想当老师的', agent_key: 'intake' });
  const done = chat.events.find((e) => e.ev === 'done');
  assert.ok(done, '访谈对话正常结束');
  assert.equal(done.data.message.agent_key, 'intake');
  assert.ok(done.data.message.options.options.length >= 2, '每轮带选项');

  const gen = await stu.call('POST', '/profile/generate', {});
  assert.equal(gen.status, 200);
  assert.ok(gen.body.profile.paths.some((p) => p.id !== 'kaoyan'), '至少一条不是考研');
  assert.equal(await flowOf(2), 'not_started', '生成≠确认，未确认前不算完成');

  const onlyKaoyan = { ...gen.body.profile, paths: gen.body.profile.paths.filter((p) => p.id === 'kaoyan') };
  assert.equal((await stu.call('PUT', '/profile', { profile: onlyKaoyan })).status, 400, '不能只保留考研');

  const edited = { ...gen.body.profile, summary: '我改过的画像摘要' };
  assert.equal((await stu.call('PUT', '/profile', { profile: edited })).status, 200);
  const p = await stu.call('GET', '/profile');
  assert.equal(p.body.profile.summary, '我改过的画像摘要', '学生修改的内容原样保存');
  assert.equal(await flowOf(2), 'done');
});

test('M5：理由不足30字不能确认；选定后第3站完成，可重选', async () => {
  const short = await stu.call('POST', '/profile/choose', { path_id: 'job', reason: '想早点工作' });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /30字/);
  const reason = '我更喜欢在真实工作中学习，家里也希望我早点独立；考研需要的长期投入我现在还没有把握，先就业积累经验更适合我。';
  const ok = await stu.call('POST', '/profile/choose', { path_id: 'job', reason });
  assert.equal(ok.status, 200);
  assert.equal(await flowOf(3), 'done');
  const again = await stu.call('POST', '/profile/choose', { path_id: 'kaoyan', reason });
  assert.equal(again.status, 200, '可以重新选择');
});

test('M6：高阶模块未绑定 Key 时提示；检索不可用时候选里没有编造的数字', async () => {
  await stu.call('POST', '/menus/school', { answers: {
    subject: '学科教学（语文）', region: ['陕西'], level: '看专业实力不看牌子', degree: '专硕', cross: '就是本专业', risk: '稳健：一次上岸最重要',
  } });
  const noKey = await stu.call('POST', '/schools/generate', {});
  assert.equal(noKey.status, 403);
  assert.equal(noKey.body.code, 'NEED_USER_KEY');

  const r = await stu.call('POST', '/schools/generate', {}, { 'X-User-Key': USER_KEY });
  assert.equal(r.status, 200);
  assert.equal(r.body.search_enabled, false);
  assert.ok(r.body.note.includes('待核实'));
  for (const c of r.body.candidates) {
    for (const f of c.facts) {
      assert.ok(!/\d/.test(f.value), `检索不可用时不应出现具体数字：${f.item}=${f.value}`);
      assert.equal(f.level, 'AI推断');
    }
  }
  assert.deepEqual([...new Set(r.body.candidates.map((c) => c.tier))].sort(), ['保底', '冲刺', '稳妥'].sort());
});

test('M6：fetch_url 拒绝本机与内网地址（防 SSRF）', async () => {
  for (const url of ['http://127.0.0.1/', 'http://localhost:3000/api/health', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.8/', 'http://192.168.1.1/', 'file:///etc/passwd']) {
    assert.throws(() => assertPublicUrl(url), /内网|http/, url);
  }
  const r = await stu.call('POST', '/schools/fetch', { url: 'http://127.0.0.1:1/' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'SSRF_BLOCKED');
  assert.doesNotThrow(() => assertPublicUrl('https://yz.chsi.com.cn/'));
});

test('M6：比较表逐条核验；写齐依据与不确定之处后第4站完成；导出 CSV', async () => {
  const add = await stu.call('POST', '/schools', {
    school: '陕西师范大学', major: '学科教学（语文）（045103）', tier: '稳妥',
    facts: [{ item: '考试科目', value: '待核实', source: '研究生院官网', url: 'https://yjsy.snnu.edu.cn/', level: '院校' }],
  });
  assert.equal(add.status, 200);
  assert.equal(await flowOf(4), 'in_progress', '缺依据时只算进行中');
  const id = add.body.school.id;

  const v = await stu.call('POST', `/schools/${id}/verify`, { index: 0 });
  assert.equal(v.body.school.facts[0].verified, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ai_actions WHERE action = 'verify'").get().n, 1, '核验动作留痕');

  await stu.call('PUT', `/schools/${id}`, { basis: '离家近，学科教学方向是我想当语文老师的直接路径。', uncertainty: '今年的招生人数还没公布。' });
  assert.equal(await flowOf(4), 'done');

  const csv = await stu.call('GET', '/schools/export');
  assert.equal(csv.status, 200);
  assert.equal(csv.bom, true);
  assert.ok(csv.text.includes('陕西师范大学') && csv.text.includes('已核验') && csv.text.includes('选择依据'));
});

let planDraft;
test('M7：生成方案（每天总时长不超过上限）；采用前不保存，采用后生成任务、第5站完成', async () => {
  await stu.call('POST', '/menus/plan', { answers: { weekly_hours: 3, slots: ['晚上'], focus: ['英语', '成果铺垫'], research: '包含（推荐）', rhythm: '稳扎稳打' } });
  const low = await stu.call('POST', '/plan/generate', {});
  assert.equal(low.status, 200, '每周只有3小时也能生成不超上限的方案');
  for (const d of low.body.plan.week) assert.ok(d.tasks.reduce((n, t) => n + t.minutes, 0) <= dailyCapMinutes(3));

  await stu.call('POST', '/menus/plan', { answers: { weekly_hours: 21, slots: ['晚上', '周末'], focus: ['英语', '专业课'], research: '包含（推荐）', rhythm: '稳扎稳打' } });
  const g = await stu.call('POST', '/plan/generate', {});
  assert.equal(g.status, 200);
  planDraft = g.body.plan;
  assert.equal(planDraft.week.length, 7);
  assert.equal(planDraft.week[0].date, todayLocal(), '从今天开始');
  const kinds = planDraft.week.flatMap((d) => d.tasks.map((t) => t.kind));
  for (const k of ['复盘', '成果', 'AI技能', '阅读']) assert.ok(kinds.includes(k), `每周至少包含：${k}`);
  for (const d of planDraft.week) assert.ok(d.tasks.reduce((n, t) => n + t.minutes, 0) <= 216);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plans').get().n, 0, '生成后未采用，不入库');

  const over = structuredClone(planDraft);
  over.week[0].tasks.push({ title: '超量任务', kind: '英语', minutes: 300 });
  const ov = await stu.call('POST', '/plan/save', { plan: over });
  assert.equal(ov.status, 400);
  assert.equal(ov.body.code, 'OVER_CAP');

  const s = await stu.call('POST', '/plan/save', { plan: planDraft });
  assert.equal(s.status, 200);
  assert.ok(s.body.task_count >= 14);
  assert.equal(await flowOf(5), 'done');
  assert.equal(await flowOf(6), 'in_progress');
});

test('完成标志：走到第5站后完成一次打卡；复盘太短或与前一天相同会被拦下', async () => {
  const t = await stu.call('GET', '/checkin/today');
  assert.ok(t.body.tasks.length >= 2);
  const ids = t.body.tasks.map((x) => x.id);

  const short = await stu.call('POST', '/checkin', { done_task_ids: ids, minutes: 60, mood: 4, reflection: '还行' });
  assert.equal(short.status, 400);
  assert.equal(short.body.code, 'SHORT_REFLECTION');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkins').get().n, 0, '失败时不留下打卡记录');

  // 构造“昨天”的打卡，检查重复复盘提示
  const uid = db.prepare("SELECT id FROM users WHERE student_no = '2024101'").get().id;
  const reflection = '今天背了单词，专业课整理了一半，晚上有点困。';
  db.prepare('INSERT INTO checkins(user_id, date, minutes, done_count, total_count, reflection, mood) VALUES(?, ?, 30, 1, 2, ?, 3)')
    .run(uid, addDays(todayLocal(), -1), reflection);
  const dup = await stu.call('POST', '/checkin', { done_task_ids: ids, minutes: 60, mood: 4, reflection });
  assert.equal(dup.body.code, 'SAME_REFLECTION');

  const ok = await stu.call('POST', '/checkin', { done_task_ids: [ids[0]], minutes: 75, accuracy: 80, mood: 4, reflection: '英语按计划完成，专业课只看了目录，明天补上。' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.stamped_at, '服务端确认后才返回盖章时间');
  assert.equal(ok.body.done_count, 1);
  assert.equal(ok.body.streak, 2);

  const again = await stu.call('POST', '/checkin', { done_task_ids: ids, minutes: 90, mood: 5, reflection: '晚上又补完了专业课，今天全部完成。' });
  assert.equal(again.body.updated, true, '当天可以修改');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ? AND date = ?').get(uid, todayLocal()).n, 1);

  const flow = await stu.call('GET', '/flow');
  assert.deepEqual(flow.body.stations.slice(0, 5).map((s) => s.status), ['done', 'done', 'done', 'done', 'done']);
  assert.equal(flow.body.current, 6);
});

test('M7：周复盘（菜单式），完成率自动计算', async () => {
  const bad = await stu.call('POST', '/weekly-review', { blockers: [], adjust: ['保持'], summary: '这一周总体还可以吧' });
  assert.equal(bad.status, 400);
  const r = await stu.call('POST', '/weekly-review', { blockers: ['时间不够'], adjust: ['拆小任务'], summary: '这一周开头不错，后面两天被作业挤掉了。' });
  assert.equal(r.status, 200);
  assert.ok(r.body.rate > 0 && r.body.rate <= 1);
  const w = await stu.call('GET', '/weekly-review');
  assert.equal(w.body.current.reviewed, true);
});

test('M3：首页数据来自真实流程；待处理提醒在阶段3前为0', async () => {
  const t = await stu.call('GET', '/today');
  assert.equal(t.status, 200);
  assert.equal(t.body.current, 6);
  assert.equal(t.body.stats.done_stations, 5);
  assert.equal(t.body.stats.today_checked, true);
  assert.equal(t.body.stats.pending_interventions, 0);
  assert.equal(t.body.mentors.primary.key, 'strategist', '第6站主讲是学生自己选的陪伴导师');
  const f = await stu.call('GET', '/flow');
  // 未到实现阶段的站不开放入口（随 CURRENT_STAGE 推进而变化，所以按 stages.json 的 stage 判断，不写死站号）
  const { CURRENT_STAGE } = await import('../src/stage.js');
  const { SHARED_DIR } = await import('../src/config.js');
  const stations = JSON.parse(readFileSync(path.join(SHARED_DIR, 'stations.json'), 'utf8')).stations;
  const later = stations.filter((s) => s.stage > CURRENT_STAGE);
  for (const s of later) {
    assert.equal(f.body.stations.find((x) => x.station === s.no).open, false, `第${s.no}站（阶段${s.stage}）不开放入口`);
  }
  for (const s of stations.filter((x) => x.stage <= CURRENT_STAGE)) {
    assert.equal(f.body.stations.find((x) => x.station === s.no).open, true, `第${s.no}站（阶段${s.stage}）已开放`);
  }
});

test('所有 AI 调用都有记录（AI使用与核验说明的基础）', () => {
  const rows = db.prepare("SELECT kind, key_source FROM ai_calls WHERE ok = 1").all();
  const kinds = new Set(rows.map((r) => r.kind));
  for (const k of ['M4_intake', 'M6_school', 'M7_plan']) assert.ok(kinds.has(k), `有 ${k} 的调用记录`);
  assert.ok(rows.some((r) => r.kind === 'M6_school' && r.key_source === 'user'), '择校用的是学生自己的 Key');
  assert.ok(rows.some((r) => r.kind === 'M7_plan' && r.key_source === 'platform'), '方案用平台 Key');
});
