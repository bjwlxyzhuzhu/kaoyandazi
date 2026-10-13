// 端到端演练（阶段7）：复试模拟（真实模型）+ 结课考核 + 互评
// 运行：先启动 node server/src/index.js，再执行 USER_KEY=sk-... node server/scripts/e2e-stage7.mjs
const B = process.env.BASE || 'http://localhost:3000/api';
const K = process.env.USER_KEY;
if (!K) { console.error('请设置 USER_KEY'); process.exit(1); }
const HK = { 'X-User-Key': K };
function client() {
  let cookie = '';
  return async (method, path, body, headers = {}) => {
    const res = await fetch(B + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream')) {
      const text = await res.text();
      return { status: res.status, events: text.trim().split('\n\n').filter(Boolean).map((c) => ({ ev: c.match(/^event: (.+)$/m)?.[1], data: JSON.parse(c.match(/^data: (.+)$/m)?.[1] || 'null') })) };
    }
    const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
    let data = null; try { data = JSON.parse(raw); } catch { /* */ }
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${data?.error || raw.slice(0, 100)}`);
    return { status: res.status, data, raw };
  };
}
const step = (s) => console.log(`✔ ${s}`);
const tag = Date.now().toString().slice(-5);
async function register(call, no, name) {
  await call('POST', '/register', { invite_code: process.env.INVITE || 'SHANHAI2026', student_no: no, name, email: `${no}@example.com`, major: '汉语言文学', grade: '大三', major_group: '文史', password: 'e2e-pass-001' });
  await call('POST', '/prepare/consent', { agreed: true });
  await call('POST', '/prepare/modules-read', {});
  const sv = (await call('GET', '/surveys/pre')).data;
  const ans = {}; for (const it of sv.items) ans[it.key] = it.type === 'scale' ? 3 : it.options[1];
  await call('POST', '/surveys/pre', { answers: ans });
  await call('PUT', '/me', { persona: 'gentle', email_remind: false });
}

const stu = client();
const sno = `e2e7${tag}`;
await register(stu, sno, '复试演练');
await stu('POST', '/menus/intake', { answers: { grade: '大三', major_group: '文史', tendency: '考研', weekly_hours: 20, english: '过六级', rank: '前30%', achievements: ['大创'], troubles: ['基础薄弱'] } });
const prof = await stu('POST', '/profile/generate', {});
await stu('PUT', '/profile', { profile: { ...prof.data.profile, summary: `${prof.data.profile.summary}（本人补充：英语过了六级）` } });
await stu('POST', '/profile/choose', { path_id: prof.data.profile.paths[0].id, reason: '我想当中学语文老师，读学科教学专硕是最直接的路径，我愿意为此投入两年时间。' });
await stu('POST', '/schools', { school: '西北大学', major: '学科教学（语文）', tier: '冲刺', basis: '离家近、专业对口', uncertainty: '复试线波动大' });
const p = await stu('POST', '/papers', { title: '谁更懂教学设计？——大语言模型与多智能体文本评估模式比较研究', authors: ['夏娅娜'], year: 2025 });
await stu('POST', '/cards', { paper_id: p.data.paper.id, question: '多智能体评估比单一模型更可靠吗？', my_judgment: '关键在评估维度拆得够不够细，文中没讨论。' });
step(`注册 ${sno}：画像（改过一处）、路径、院校、阅读卡`);

console.log('\n== 基础版复试（真实模型，平台 Key）==');
let s = (await stu('POST', '/interview/sessions', { tier: 'basic', target: '西北大学 学科教学（语文）', difficulty: '压力' })).data.session;
const answers = [
  '各位老师好，我是汉语言文学专业大三学生，想读学科教学（语文），以后当中学语文老师。',
  '我读过一篇比较大模型和多智能体评估教学设计的论文，我觉得关键在评估维度拆得够不够细。',
  '嗯……这个我没想过，可能是因为家里希望我稳定吧。',
  '我会先把教育学综合的框架过一遍，再刷真题。',
  '我想问一下，导师组目前在做哪些语文教学方向的课题？',
  '谢谢老师。',
];
let r = await stu('POST', `/interview/sessions/${s.id}/next`, {});
for (const a of answers) {
  if (r.events.some((e) => e.ev === 'ended')) { console.log(`   （${r.events.find((e) => e.ev === 'ended').data.message}）`); break; }
  const ex = r.events.find((e) => e.ev === 'examiner')?.data;
  const q = r.events.find((e) => e.ev === 'question')?.data;
  const meta = r.events.find((e) => e.ev === 'meta')?.data;
  if (!q) { console.log('   ⚠', JSON.stringify(r.events.find((e) => e.ev === 'error'))); break; }
  console.log(`   [${meta.stage}] ${ex.name}｜${ex.duty}：${q.text}`);
  console.log(`      答：${a}`);
  r = await stu('POST', `/interview/sessions/${s.id}/next`, { text: a });
}
s = (await stu('POST', `/interview/sessions/${s.id}/finish`, {})).data.session;
for (const e of s.review.examiners) {
  console.log(`   ${e.name}：${Object.entries(e.scores).map(([k, v]) => `${k}${v ?? '—'}`).join(' ')}`);
  for (const [k, v] of Object.entries(e.reasons)) console.log(`      ${k}：${v}`);
}
console.log(`   三条改进：${s.review.top3.join('；')}`);
step(`进入题库 ${s.review.qbank_added} 道：${s.review.retry_questions.join('｜')}`);
try { await stu('POST', `/interview/sessions/${s.id}/self-review`, { text: '答得一般' }); } catch (e) { step(`自评太短被拦下：${e.message.split('→')[1]}`); }
await stu('POST', `/interview/sessions/${s.id}/self-review`, { text: '被问到为什么考研时我只说了家里希望稳定，没讲清自己的动机；专业问题里我能引用读过的论文，这是进步。下次要先把“为什么是语文教学研究”想成三句话，并准备一个具体的课堂例子。' });
step('自评通过，复盘关闭');

console.log('\n== 完整考官组（真实模型，学生 Key）：题库优先 ==');
const pending = (await stu('GET', '/interview/qbank')).data.items.filter((x) => x.status === '待重练');
const full = (await stu('POST', '/interview/sessions', { tier: 'full', target: '西北大学 学科教学（语文）', duration: 20, difficulty: '标准', examiners: ['格物｜专业考官', '远帆｜英语考官', '守正｜综合考官', '鉴微｜导师视角'] }, HK)).data.session;
let r2 = await stu('POST', `/interview/sessions/${full.id}/next`, {}, HK);
for (let i = 0; i < 6; i += 1) {
  const q = r2.events.find((e) => e.ev === 'question')?.data;
  const meta = r2.events.find((e) => e.ev === 'meta')?.data;
  const ex = r2.events.find((e) => e.ev === 'examiner')?.data;
  if (!q) break;
  console.log(`   [${meta.stage}] ${ex.name}：${q.text}${q.from_qbank ? '  ← 来自题库' : ''}`);
  if (meta.stage === '专业问题') { step(q.from_qbank ? `专业环节第一题来自题库（最早的待重练题：${pending.sort((a, b) => a.id - b.id)[0]?.question}）` : '⚠ 专业环节第一题没有来自题库'); break; }
  r2 = await stu('POST', `/interview/sessions/${full.id}/next`, { text: meta.stage.includes('英文') ? 'I want to study Chinese language teaching because I enjoy helping students read better.' : '我先说结论：我想研究中学语文阅读教学。' }, HK);
}

console.log('\n== 结课：档案袋 → 汇编 → 反思 → AI使用说明 → 提交 ==');
let pf = (await stu('GET', '/assess/portfolio')).data;
step(`档案袋缺 ${pf.missing_count} 项：${pf.summary.join('｜')}`);
const draft = (await stu('POST', '/assess/plan/compile', {})).data;
step(`汇编 ${draft.draft.sections.length} 个部分；“复试准备”：${draft.draft.sections.find((x) => x.key === 'interview').content.split('\n')[0]}`);
for (const sec of draft.draft.sections) await stu('PUT', '/assess/plan/reflections', { section: sec.key, text: `${sec.title.slice(2)}：回头看，我在这部分最大的问题是想得多、落地少，下一步要把它拆成每周能检查的一件小事，并在周复盘里核对。` });
const st = (await stu('GET', '/assess/ai-statement')).data;
console.log(st.draft.split('\n').map((l) => `   ${l}`).join('\n'));
await stu('PUT', '/assess/ai-statement', { note: '画像是AI起草的，我把英语一栏改成了六级；复试模拟的问题我都自己作答，复盘的三条建议里我挑了“先给结论”去练；院校数据我还要去官网核对。' });
const sub = (await stu('POST', '/assess/submit', {})).data;
step(`提交于 ${sub.submitted_at}；定格统计：调用 ${sub.ai_statement.stats.total_calls} 次，修改率 ${sub.ai_statement.stats.adoption.modify_rate}%`);
pf = (await stu('GET', '/assess/portfolio')).data;
step(`提交后档案袋：${pf.items.map((i) => `${i.name.slice(0, 6)}=${i.status}`).join('，')}`);

console.log('\n== 互评（3位同学）==');
const t2 = { exam_year: '2027年12月', nodes: ['网上报名', '初试', '复试'], start_time: '这学期内', start_reason: '想早点打基础', achievement: '大创' };
await stu('POST', '/chapters/1/tasks/t2', { content: t2 });
const others = [];
for (let i = 0; i < 2; i += 1) {
  const c = client();
  await register(c, `e2e7${tag}${i}`, `互评演练${i}`);
  await c('POST', '/chapters/1/tasks/t2', { content: { ...t2, start_reason: `第${i}位同学：想先把专业课过一遍` } });
  others.push(c);
}
const tea = client();
await tea('POST', '/login', { student_no: process.env.TEACHER_NO || 'teacher', password: process.env.TEACHER_PW || 'sh-63dcc37daddd' });
const open = (await tea('POST', '/teacher/peer/open', { chapter: 1, task_id: 't2' })).data;
step(`教师开启互评：${open.submissions} 份作业，分配 ${open.created} 份评价任务`);
for (const c of [stu, ...others]) {
  const a = (await c('GET', '/peer/assigned')).data;
  for (const it of a.items) await c('POST', `/peer/${it.id}`, { rubric: { reliable: 4, logic: 4, executable: 3 }, comment: '节点完整，建议补上调剂预案。' });
}
const rec = (await stu('GET', '/peer/received')).data.items[0];
step(`我收到 ${rec.received} 份互评：${JSON.stringify(rec.averages)}`);

console.log('\n== 教师评分与成绩表 ==');
const list = (await tea('GET', '/teacher/grades')).data.students;
const me = list.find((x) => x.student_no === sno);
for (const [item, score] of Object.entries({ schools: 78, plan: 85, kb: 72, classroom: 95, final: 88 })) await tea('PUT', `/teacher/grades/${me.id}`, { item, score });
const csv = (await tea('GET', '/teacher/grades/export')).raw;
step(`成绩表第一行：${csv.slice(1).split('\r\n')[0]}`);
step(`我的那一行：${csv.split('\r\n').find((l) => l.includes(sno))}`);
console.log(`\n测试学号（演练后请删除）：${sno}、e2e7${tag}0、e2e7${tag}1`);
