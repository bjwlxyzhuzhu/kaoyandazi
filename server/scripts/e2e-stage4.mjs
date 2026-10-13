// 端到端演练（阶段4）：导师团会议（真实模型）
// 运行：先启动 node server/src/index.js，再执行 node server/scripts/e2e-stage4.mjs
const B = process.env.BASE || 'http://localhost:3000/api';
let cookie = '';

async function call(method, path, body, headers = {}) {
  const res = await fetch(B + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const type = res.headers.get('content-type') || '';
  if (type.includes('text/event-stream')) return { status: res.status, text: await res.text() };
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}
const must = async (m, p, b, h) => {
  const r = await call(m, p, b, h);
  if (r.status >= 400) throw new Error(`${m} ${p} → ${r.status} ${r.data?.error || ''}`);
  return r;
};
function events(text) {
  return text.trim().split('\n\n').filter(Boolean).map((chunk) => ({
    ev: chunk.match(/^event: (.+)$/m)?.[1],
    data: JSON.parse(chunk.match(/^data: (.+)$/m)?.[1] || 'null'),
  }));
}
const step = (s) => console.log(`✔ ${s}`);

const sno = `grp${Date.now().toString().slice(-6)}`;
const K = process.env.USER_KEY || `sk-e2e${sno}`;
const HK = { 'X-User-Key': K };

await must('POST', '/register', { invite_code: process.env.INVITE || 'SHANHAI2026', student_no: sno, name: '导师团演练', email: `${sno}@example.com`, major: '汉语言文学', grade: '大二', major_group: '文史', password: 'e2e-pass-001' });
await must('POST', '/prepare/consent', { agreed: true });
await must('POST', '/prepare/modules-read', {});
const sv = (await must('GET', '/surveys/pre')).data;
const ans = {};
for (const it of sv.items) ans[it.key] = it.type === 'scale' ? 3 : it.options[1];
await must('POST', '/surveys/pre', { answers: ans });
await must('PUT', '/me', { persona: 'gentle', email_remind: false });
await must('POST', '/menus/intake', { answers: { grade: '大二', major_group: '文史', tendency: '考研', weekly_hours: 14, english: '过四级', rank: '前30%', achievements: ['暂无'], troubles: ['不知道选什么'] } });
const prof = await must('POST', '/profile/generate', {});
await must('PUT', '/profile', { profile: prof.data.profile });
await must('POST', '/profile/choose', { path_id: 'kaoyan', reason: '我想当中学语文老师，读学科教学专硕是最直接的路径，我愿意为此投入两年时间。' });
step(`注册 ${sno} 并走到第4站`);

// 开一场方向研讨会（完整版：用学生自己的 Key）
const created = await must('POST', '/group/sessions', { mode: 'direction' }, HK);
const sid = created.data.session.id;
step(`开会：${created.data.session.mode_name}，参会 ${created.data.session.mentors.join('、')}`);

console.log('\n== 第一轮 ==');
const r1 = events((await must('POST', `/group/sessions/${sid}/send`, { text: '考研、考公、就业我都在纠结，你们怎么看？' }, HK)).text);
const plan = r1.find((e) => e.ev === 'host_plan').data;
step(`司南安排：${plan.note}`);
for (const sp of plan.speakers) console.log(`   · ${sp.name}（焦点：${sp.focus}）`);

// 拼出每位导师的完整发言
const speeches = [];
for (const e of r1) {
  if (e.ev === 'speaker_start') speeches.push({ key: e.data.key, name: e.data.name, text: '' });
  else if (e.ev === 'delta') speeches[speeches.length - 1].text += e.data.text;
}
for (const s of speeches) {
  console.log(`\n   【${s.name}】${s.text.replace(/\n+/g, ' ').slice(0, 220)}`);
}
const sum = r1.find((e) => e.ev === 'host_summary').data;
console.log(`\n   共识：${sum.consensus}`);
console.log(`   分歧：${sum.divergence}`);
console.log(`   需要你决定：${sum.decide}`);
const opts = r1.find((e) => e.ev === 'options').data;
console.log(`   选项：${opts.options.map((o) => o.label).join(' / ')}`);
step(`发言顺序：${speeches.map((s) => s.name).join(' → ')}；每人发言 ${speeches.map((s) => s.text.length).join('/')} 字`);

// 后发言者是否回应了前一位
const second = speeches[1]?.text || '';
const responded = /(同意|赞同|补充|不同意|不过|但|不对|想补充|我同意|我理解)/.test(second);
step(`第二位（${speeches[1]?.name}）${responded ? '明确回应了前一位' : '⚠ 没看出明显回应'}`);

console.log('\n== 第二轮：@ 点名 ==');
const r2 = events((await must('POST', `/group/sessions/${sid}/send`, { text: '@明章 官方文件里对跨专业报考是怎么规定的？' }, HK)).text);
const plan2 = r2.find((e) => e.ev === 'host_plan').data;
const joined = r2.find((e) => e.ev === 'mentor_joined');
if (joined) step(`@ 的导师自动进场：${joined.data.names.join('、')}`);
const order2 = plan2.speakers.map((s) => s.name);
step(`本轮顺序：${order2.join(' → ')}；${order2[0].startsWith('明章') ? '被点名的明章第一个发言' : `⚠ 第一个是 ${order2[0]}`}`);
const mz = [];
for (const e of r2) {
  if (e.ev === 'speaker_start') mz.push({ name: e.data.name, text: '' });
  else if (e.ev === 'delta') mz[mz.length - 1].text += e.data.text;
}
const mzSpeech = mz.find((x) => x.name.startsWith('明章'));
if (mzSpeech) console.log(`   明章说：${mzSpeech.text.replace(/\n+/g, ' ').slice(0, 240)}`);

console.log('\n== 静音 ==');
await must('POST', `/group/sessions/${sid}/mute`, { mentor: 'senior', muted: true });
const r3 = events((await must('POST', `/group/sessions/${sid}/send`, { text: '再补充一点：我其实更想离家近一些。' }, HK)).text);
const plan3 = r3.find((e) => e.ev === 'host_plan').data;
step(`静音渡舟后本轮发言者：${plan3.speakers.map((s) => s.name).join('、')} ${plan3.speakers.some((s) => s.key === 'senior') ? '⚠ 渡舟仍在发言' : '（渡舟没有发言）'}`);

console.log('\n== 结束会议 → 纪要 → 行动项 ==');
const closed = (await must('POST', `/group/sessions/${sid}/close`, {}, HK)).data.session;
step(`纪要已生成：${closed.summary.points.length} 条要点；决定：${closed.summary.decision}`);
for (const p of closed.summary.points) console.log(`   · ${p}`);
console.log('   行动项：');
for (const a of closed.action_items) console.log(`   [${a.confirmed ? '✓' : ' '}] ${a.title}（${a.kind}，${a.minutes}分钟）`);

if (closed.action_items.length) {
  const pick = closed.action_items.slice(0, 2).map((a) => a.id);
  const conf = (await must('POST', `/group/sessions/${sid}/actions/confirm`, { ids: pick })).data;
  step(`勾选 ${pick.length} 条 → 写入学习方案 ${conf.added.length} 条：${conf.added.map((a) => a.title).join('；')}`);
  const planNow = (await must('GET', '/plan')).data;
  const titles = planNow.tasks.map((t) => t.title);
  const notPicked = closed.action_items.filter((a) => !pick.includes(a.id));
  step(`方案里现在有 ${titles.length} 条任务；未勾选的 ${notPicked.length} 条${notPicked.every((a) => !titles.includes(a.title)) ? '没有写入' : '⚠ 有写入'}`);
}

console.log(`\n测试学号（演练后请删除）：${sno}`);
