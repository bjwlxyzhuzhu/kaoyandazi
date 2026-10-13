// 端到端演练（阶段8）：导师工坊（真实模型）、反馈蒸馏（真实模型）、匿名模式、评委账号、成效看板
// 运行：先启动 node server/src/index.js，再执行 node server/scripts/e2e-stage8.mjs
const B = process.env.BASE || 'http://localhost:3000/api';
function client() {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(B + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    if (type.includes('event-stream')) { const t = await res.text(); return { status: res.status, raw: t, events: t.trim().split('\n\n').filter(Boolean).map((c) => ({ ev: c.match(/^event: (.+)$/m)?.[1], data: JSON.parse(c.match(/^data: (.+)$/m)?.[1] || 'null') })) }; }
    const buf = Buffer.from(await res.arrayBuffer());
    const raw = buf.toString('utf8');
    let data = null; try { data = JSON.parse(raw); } catch { /* */ }
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status} ${data?.error || ''}`);
    return { status: res.status, data, raw, buf };
  };
}
const step = (s) => console.log(`✔ ${s}`);
const tag = Date.now().toString().slice(-5);
const tea = client();
await tea('POST', '/login', { student_no: process.env.TEACHER_NO || 'teacher', password: process.env.TEACHER_PW || 'sh-63dcc37daddd' });
const stu = client();
const sno = `e2e8${tag}`;
await stu('POST', '/register', { invite_code: process.env.INVITE || 'SHANHAI2026', student_no: sno, name: '工坊演练', email: `${sno}@example.com`, major: '汉语言文学', grade: '大三', major_group: '文史', password: 'e2e-pass-001' });
await stu('POST', '/prepare/consent', { agreed: true });
await stu('POST', '/prepare/modules-read', {});
const sv = (await stu('GET', '/surveys/pre')).data; const ans = {}; for (const it of sv.items) ans[it.key] = it.type === 'scale' ? 3 : it.options[1];
await stu('POST', '/surveys/pre', { answers: ans });
await stu('PUT', '/me', { persona: 'strict', email_remind: false });
step(`注册 ${sno}`);

const ask = async (text) => {
  const r = await stu('POST', '/conv/ask/send', { text, agent_key: 'policy' });
  return r.events.find((e) => e.ev === 'done')?.data.message || { content: JSON.stringify(r.events.find((e) => e.ev === 'error')) };
};
const Q = '跨专业报考专业学位硕士需要满足什么要求？网上确认要做什么？';
const DOC = '研究生招生工作管理规定（节选，演练用示例文本）\n\n第十二条 报考专业学位硕士研究生的考生，跨专业报考须符合招生单位规定的学历与学科要求，具体以招生单位当年公布的招生简章为准。\n第十三条 考生须在规定时间内完成网上报名与网上确认，逾期不再补报。网上确认包括上传身份证件照片与学历学位信息核验。';

console.log('\n== 16.2-4 导师工坊（明章，真实模型）==');
const before = await ask(Q);
console.log(`   发布前：${before.content.replace(/\n+/g, ' ').slice(0, 160)}…  来源：${before.options?.sources ? '有' : '无'}`);
const up = (await tea('POST', '/teacher/mentors/policy/docs', { title: `招生工作管理规定（节选·演练${tag}）`, source: '演练用示例文本', level: '官方', license_note: '演练用，非真实文件', text: DOC, confirm_rules: true })).data;
step(`上传资料到草稿：${up.chunks} 片`);
const draftAsk = await ask(Q);
step(`草稿未发布时学生提问：来源 ${draftAsk.options?.sources ? '⚠ 有' : '无（回答不受影响）'}`);
await tea('POST', '/teacher/mentors/policy/evalset', { question: Q, points: ['招生简章', '网上确认', '学历学位信息核验'] });
const ev = (await tea('POST', '/teacher/mentors/policy/eval', {})).data;
step(`测试集：发布版覆盖率 ${ev.coverage_before}% → 草稿 ${ev.coverage_after}%`);
console.log(`   发布版答：${ev.rows[0].before.replace(/\n+/g, ' ').slice(0, 120)}…`);
console.log(`   草稿答：${ev.rows[0].after.replace(/\n+/g, ' ').slice(0, 120)}…`);
const pub = (await tea('POST', '/teacher/mentors/policy/publish', { change_note: '加入招生管理规定（演练）' })).data;
const after = await ask(Q);
step(`发布 ${pub.version} 后：来源 ${JSON.stringify((after.options?.sources || []).map((s) => `${s.title}｜${s.level}`))}`);
console.log(`   回答：${after.content.replace(/\n+/g, ' ').slice(0, 220)}…`);
const docId = up.doc_id;
await tea('PUT', `/teacher/mentors/policy/docs/${docId}`, { enabled: false });
const dis = await ask(Q);
step(`禁用资料后：来源 ${dis.options?.sources ? '⚠ 仍有' : '无'}`);
const prevVersion = (await tea('GET', '/teacher/mentors/policy')).data.versions.slice(-2)[0].version;
await tea('POST', '/teacher/mentors/policy/rollback', { version: prevVersion });
step(`回滚到 ${prevVersion}；学生端版本 = ${(await stu('GET', '/mentors')).data.agents.find((a) => a.key === 'policy').version}`);

console.log('\n== 16.2-5 反馈学习（砺行，真实模型蒸馏）==');
for (let i = 0; i < 5; i += 1) {
  const r = await stu('POST', '/conv/companion/send', { text: ['今天又没完成计划。', '英语单词背了又忘。', '我有点不想学了。', '专业课太多看不完。', '昨天熬夜今天起不来。'][i], agent_key: 'strict' });
  const m = r.events.find((e) => e.ev === 'done').data.message;
  await stu('POST', '/mentors/strict/feedback', { helpful: false, reasons: ['太严厉'], message_ref: `msg:${m.id}` });
}
const fb = (await tea('GET', '/teacher/mentors/strict/feedback')).data;
step(`教师端反馈：没帮助 ${fb.summary.unhelpful}，“太严厉” ${fb.summary.tags['太严厉']}；含学生原话“不想学了”？${fb.raw?.includes?.('不想学了') || JSON.stringify(fb).includes('我有点不想学了') ? '⚠ 是' : '否'}`);
const d = (await tea('POST', '/teacher/mentors/strict/distill', {})).data;
for (const p of d.patterns) console.log(`   规律：${p.issue}（${p.evidence_count} 条）`);
for (const p of d.items.filter((x) => x.status === 'pending')) console.log(`   建议【${p.type}】${p.change}\n      理由：${p.reason}｜副作用：${p.risk}`);

console.log('\n== 16-12 匿名模式 / 评委账号 / 看板 ==');
const org0 = (await tea('GET', '/teacher/org')).data.org;
await tea('PUT', '/teacher/org', { school_name: '宝鸡文理学院', college_name: '演练学院', teacher_names: '演练教师甲', extra_terms: '' });
await stu('POST', '/kb/items', { space: 'prep', type: 'note', title: '演练教师甲的课堂笔记', content: { body: '宝鸡文理学院演练学院' } });
await tea('PUT', '/teacher/anonymous-mode', { enabled: true });
let leaks = 0;
for (const [c, p] of [[stu, '/me'], [stu, '/kb/items'], [stu, '/kb/report/print'], [tea, '/teacher/students'], [tea, '/teacher/overview'], [tea, '/teacher/grades/export']]) {
  const r = await c('GET', p);
  if (/宝鸡文理学院|演练学院|演练教师甲|工坊演练/.test(r.raw)) { leaks += 1; console.log(`   ⚠ ${p} 泄露`); }
}
step(`匿名模式下抽查 6 个页面/导出：泄露 ${leaks} 处；学生看到的自己的名字：${(await stu('GET', '/me')).data.me.name}`);
await tea('PUT', '/teacher/anonymous-mode', { enabled: false });
await tea('PUT', '/teacher/org', org0);
const reg0 = (await tea('GET', '/teacher/impact')).data.metrics.find((m) => m.id === 'registered').value;
const j = (await tea('POST', '/teacher/demo-accounts', { count: 1, days: 3, note: '演练' })).data.accounts[0];
const judge = client();
const me = (await judge('POST', '/login', { student_no: j.student_no, password: j.password })).data.me;
step(`评委账号登录：is_demo=${me.is_demo}，有效期 ${me.expires_at}`);
await judge('POST', '/prepare/consent', { agreed: true });
const jr = await judge('POST', '/conv/companion/send', { text: '你好，我是评委，想看看这个平台' });
step(`评委与搭子对话：${jr.events.find((e) => e.ev === 'done')?.data.message.content.replace(/\n+/g, ' ').slice(0, 80)}…`);
const reg1 = (await tea('GET', '/teacher/impact')).data.metrics.find((m) => m.id === 'registered').value;
step(`看板注册人数 ${reg0} → ${reg1}（评委不计入）`);
const xl = await tea('GET', '/teacher/impact/export');
step(`导出 Excel ${xl.buf.length} 字节，PK 头：${xl.buf.slice(0, 2).toString()}`);
console.log(`\n测试学号（演练后请删除）：${sno}、${j.student_no}`);
