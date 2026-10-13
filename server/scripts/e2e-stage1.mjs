// 端到端演练：对正在运行的应用（http://localhost:3000）走一遍阶段1完成标志
// 运行：node server/scripts/e2e-stage1.mjs
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
  if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
    const text = await res.text();
    return { status: res.status, events: text.trim().split('\n\n').map((c) => ({ ev: c.match(/^event: (.+)$/m)?.[1], data: JSON.parse(c.match(/^data: (.+)$/m)?.[1] || 'null') })) };
  }
  return { status: res.status, body: await res.json().catch(() => null) };
}

const sno = `demo${Date.now().toString().slice(-6)}`;
const reg = await call('POST', '/register', {
  invite_code: 'SHANHAI2026', student_no: sno, name: '演示学生', email: `${sno}@qq.com`,
  major: '汉语言文学', grade: '大二', major_group: '文史', password: 'demo-pass-001',
});
console.log('注册：', reg.status, reg.body?.me?.name, '默认陪伴导师 =', reg.body?.me?.persona);

const mods = await call('GET', '/me/modules');
for (const m of mods.body.modules.filter((x) => ['M9_companion', 'M4_intake', 'M6_school', 'M15_lab'].includes(x.id))) {
  console.log('模块：', m.name.slice(0, 16), '|', m.tier === 'basic' ? '基础' : '高阶', '|', m.status);
}

const r1 = await call('POST', '/conv/companion/send', { text: '你好，我在考研和考公之间犹豫', agent_key: 'gentle' });
const counts = {};
for (const e of r1.events) counts[e.ev] = (counts[e.ev] || 0) + 1;
console.log('第1轮 SSE 事件：', JSON.stringify(counts));
const msg = r1.events.at(-1).data.message;
console.log('导师：', msg.agent_key, '\n正文：\n' + msg.content);
console.log('选项：', msg.options.options.map((o) => `${o.key}.${o.label}`).join(' / '), '| 多选 =', msg.options.multi, '| 自由输入 =', msg.options.free_text);
console.log('正文含 JSON 代码块？', msg.content.includes('```'));

const pick = msg.options.options[1];
const r2 = await call('POST', '/conv/companion/send', { conv_id: r1.events[0].data.conv_id, text: `【选择】${pick.key}：${pick.label}` });
console.log('第2轮（点选', pick.key, '）结束事件：', r2.events.at(-1).ev, '| 回复首行：', r2.events.at(-1).data.message.content.split('\n').slice(0, 3).join(' '));

const q = await call('GET', '/me/quota');
console.log('今日基础额度：', `${q.body.used}/${q.body.limit}`);
