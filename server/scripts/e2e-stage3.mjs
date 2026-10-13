// 端到端演练（阶段3）：跨对话记忆测试 + 立即执行巡检测试
// 运行：先启动 node server/src/index.js，再执行 node server/scripts/e2e-stage3.mjs
const B = process.env.BASE || 'http://localhost:3000/api';
const DB_FILE = process.env.DB_FILE_PATH || 'data/app.db';
let cookie = '';

async function call(method, path, body) {
  const res = await fetch(B + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/event-stream')) return { status: res.status, text: await res.text() };
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data?.error || ''}`);
  return data;
}

const step = (s) => console.log(`✔ ${s}`);
let teacherCookie = '';
async function teacherCall(method, path, body) {
  const hold = cookie;
  cookie = teacherCookie;
  try {
    const out = await call(method, path, body);
    teacherCookie = cookie;
    return out;
  } finally { cookie = hold; }
}

/** 从 SSE 文本里取出事件 */
function events(text) {
  return text.trim().split('\n\n').filter(Boolean).map((chunk) => ({
    ev: chunk.match(/^event: (.+)$/m)?.[1],
    data: JSON.parse(chunk.match(/^data: (.+)$/m)?.[1] || 'null'),
  }));
}

const sno = `mem${Date.now().toString().slice(-6)}`;
await call('POST', '/register', { invite_code: process.env.INVITE || 'SHANHAI2026', student_no: sno, name: '记忆测试生', email: process.env.TEST_MAIL || `${sno}@example.com`, major: '汉语言文学', grade: '大二', major_group: '文史', password: 'e2e-pass-001' });
await call('POST', '/prepare/consent', { agreed: true });
await call('POST', '/prepare/modules-read', {});
const survey = await call('GET', '/surveys/pre');
const ans = {};
for (const it of survey.items) ans[it.key] = it.type === 'scale' ? 3 : it.options[1];
await call('POST', '/surveys/pre', { answers: ans });
await call('PUT', '/me', { persona: 'gentle', email_remind: false });
step(`注册 ${sno} 并完成出发准备（先关掉邮件，避免演练打扰真实邮箱）`);

// ---------- 验收1：跨对话记忆测试（第16章第6步） ----------
console.log('\n== 跨对话记忆测试 ==');
// 关键：带上 conv_id，保持同一段对话（前端就是这么做的）
let convId = null;
async function say(text) {
  const r = call('POST', '/conv/companion/send', { conv_id: convId, text, agent_key: 'gentle' });
  const res = await r;
  const evs = events(res.text);
  const meta = evs.find((e) => e.ev === 'meta');
  if (meta) convId = meta.data.conv_id;
  return evs;
}

await say('我的目标是考上西北大学的学科教学（语文），每天能学6小时');
await say('我比较担心专业课背不下来，英语基础还行');
let mem = await call('GET', '/memories');
step(`两轮对话后整理出 ${mem.count} 条长期记忆：`);
for (const m of mem.memories) console.log(`   [${m.category}] ${m.content}`);

// 新开一段对话，问它还记不记得（这才是“跨对话”）
console.log('\n   —— 新开一段对话 ——');
const prevConv = convId;
convId = null;
await say('你还记得我的目标吗？');
const memoriesSeen = await call('GET', '/memories');
const hasGoal = memoriesSeen.memories.some((m) => m.content.includes('西北大学'));
step(`新开对话提问完成；长期记忆里${hasGoal ? '有' : '没有'}“西北大学”这条`);
void prevConv;

// 删除这条记忆，再问一次
const goal = memoriesSeen.memories.find((m) => m.content.includes('西北大学'));
if (goal) {
  await call('DELETE', `/memories/${goal.id}`);
  const after = await call('GET', '/memories');
  step(`删除“${goal.content.slice(0, 30)}”后剩 ${after.count} 条，再问一次它就不会提到这个目标了`);
} else {
  console.log('   ⚠ 没有整理出含“西北大学”的记忆条目，请人工确认模型输出');
}

// ---------- 验收2：立即执行巡检测试（第16章第10步） ----------
console.log('\n== 立即执行巡检测试 ==');
await call('POST', '/menus/plan', { answers: { weekly_hours: 14, slots: ['晚上', '周末'], focus: ['英语', '专业课'], research: '包含（推荐）', rhythm: '稳扎稳打' } });
const plan = await call('POST', '/plan/generate', {});
await call('POST', '/plan/save', { plan: plan.plan });
step(`采用方案，生成 ${plan.plan.week.flatMap((d) => d.tasks).length} 个任务`);

// 模拟“几天没打卡”：直接改数据库里的打卡日期（对应第16章第10步“用脚本把打卡日期往前调”）
const { DatabaseSync } = await import('node:sqlite');
const { addDays: back } = await import('../src/time.js');
const db = new DatabaseSync(DB_FILE);
const uid = db.prepare('SELECT id FROM users WHERE student_no = ?').get(sno).id;
const today = new Date().toISOString().slice(0, 10);
db.prepare("DELETE FROM checkins WHERE user_id = ?").run(uid);
// 4天前打过一次卡（满足 R2 的“曾打卡”），昨天和前天都没有
db.prepare('INSERT INTO checkins(user_id, date, minutes, done_count, total_count, reflection, mood) VALUES(?, ?, 40, 1, 3, ?, 3)')
  .run(uid, back(today, -4), '四天前打过卡，之后忙起来了');
step('把打卡日期往前调：4天前打过一次卡，昨天和前天都没打（应该触发 R2 断卡）');

await teacherCall('POST', '/login', { student_no: process.env.TEACHER_NO || 'teacher', password: process.env.TEACHER_PW || 'sh-63dcc37daddd' });
const run = await teacherCall('POST', '/teacher/run-checks', { force: true });
const mine = run.triggered.find((t) => t.student_no === sno);
step(`教师点“立即执行巡检”：检查了 ${run.students} 名学生`);
if (mine) {
  step(`触发 ${mine.created.length} 条：${mine.created.map((c) => c.rule).join('、')}`);
  for (const c of mine.created) console.log(`   ${c.rule} 邮件：${c.emailOnly ? '仅邮件' : c.emailed ? '已发送' : `未发送（${c.mailNote}）`}`);
} else {
  console.log('   ⚠ 没有触发任何提醒');
}

const ivs = await call('GET', '/interventions');
step(`学生首页出现 ${ivs.pending_count} 条待处理提醒`);
for (const c of ivs.pending) console.log(`   [${c.rule}] ${c.title}\n       ${c.message}\n       选项：${c.options.map((o) => o.label).join(' / ')}`);

const reduceCard = ivs.pending.find((c) => c.options.some((o) => o.effect === 'reduce'));
if (reduceCard) {
  const opt = reduceCard.options.find((o) => o.effect === 'reduce');
  const r = await call('POST', `/interventions/${reduceCard.id}/choose`, { choice: opt.key, note: '这周任务确实有点多' });
  step(`学生选择“${opt.label}” → 效果 ${r.effect}`);
  const plan2 = await call('GET', '/plan');
  step(`方案减量标记：${plan2.reduce_flag ? '已置位' : '未置位'}`);
  const again = await call('POST', '/plan/generate', {});
  const total = again.plan.week.flatMap((d) => d.tasks).reduce((n, t) => n + t.minutes, 0);
  const cap = again.daily_cap_minutes * 7;
  step(`减量后再生成：7天共 ${total} 分钟（上限 ${cap}）→ ${total < cap * 0.8 ? '任务确实减少了' : '⚠ 未明显减少'}`);
} else {
  console.log('   ⚠ 没有带“减量”选项的提醒卡片');
}

// 同一类干预3天内不重复
const run2 = await teacherCall('POST', '/teacher/run-checks', {});
const mine2 = run2.triggered.find((t) => t.student_no === sno);
step(`再巡检一次：${mine2 ? '⚠ 重复触发了 ' + mine2.created.map((c) => c.rule).join('、') : '同一类干预没有重复触发'}`);

const done = await call('GET', '/interventions');
console.log(`\n已处理 ${done.done.length} 条；测试学号（演练后请删除）：${sno}`);
