// 端到端演练（阶段6）：数字分身全流程（16.2 第3条）+ API 实验室（真实模型）
// 运行：先启动 node server/src/index.js，再执行 USER_KEY=sk-... node server/scripts/e2e-stage6.mjs
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
  const raw = await res.text();
  let data = null; try { data = JSON.parse(raw); } catch { /* */ }
  return { status: res.status, data, raw };
}
const must = async (m, p, b, h) => {
  const r = await call(m, p, b, h);
  if (r.status >= 400) throw new Error(`${m} ${p} → ${r.status} ${r.data?.error || ''}`);
  return r;
};
const events = (t) => t.trim().split('\n\n').filter(Boolean).map((c) => ({ ev: c.match(/^event: (.+)$/m)?.[1], data: JSON.parse(c.match(/^data: (.+)$/m)?.[1] || 'null') }));
const step = (s) => console.log(`✔ ${s}`);
const K = process.env.USER_KEY;
if (!K) { console.error('请设置 USER_KEY'); process.exit(1); }
const HK = { 'X-User-Key': K };
const sno = `twn${Date.now().toString().slice(-6)}`;
const flat = (p) => Object.entries(p).filter(([k]) => k !== 'open_questions').flatMap(([k, v]) => v.map((x) => ({ ...x, section: k })));

await must('POST', '/register', { invite_code: process.env.INVITE || 'SHANHAI2026', student_no: sno, name: '分身演练', email: `${sno}@example.com`, major: '汉语言文学', grade: '大二', major_group: '文史', password: 'e2e-pass-001' });
await must('POST', '/prepare/consent', { agreed: true });
await must('POST', '/prepare/modules-read', {});
const sv = (await must('GET', '/surveys/pre')).data;
const ans = {}; for (const it of sv.items) ans[it.key] = it.type === 'scale' ? 3 : it.options[1];
await must('POST', '/surveys/pre', { answers: ans });
await must('PUT', '/me', { persona: 'gentle', email_remind: false });
await must('POST', '/menus/intake', { answers: { grade: '大二', major_group: '文史', tendency: '考研', weekly_hours: 14, english: '过四级', rank: '前30%', achievements: ['暂无'], troubles: ['不知道选什么', '坚持不下去'] } });
await must('POST', '/conv/intake/send', { text: '我想当中学语文老师，但又怕考研考不上，家里希望我稳定一点。我说话比较直，喜欢先说结论。' });
const prof = await must('POST', '/profile/generate', {});
await must('PUT', '/profile', { profile: prof.data.profile });
await must('POST', '/profile/choose', { path_id: 'kaoyan', reason: '我想当中学语文老师，读学科教学专硕是最直接的路径，我愿意为此投入两年时间。' });
await must('POST', '/memories', { content: '担心专业课背不下来，英语还行', category: '困难' });
step(`注册 ${sno}，完成访谈、画像、路径，留下一条记忆`);

console.log('\n== ① 未同意不能建立 ==');
const pre = await call('POST', '/twin/build', {});
step(`未同意时生成档案 → ${pre.status} ${pre.data?.code}`);
await must('POST', '/twin/consent', { agreed: true });
step('勾选知情同意');

console.log('\n== ② 关闭“打卡与复盘”后生成档案 ==');
await must('PUT', '/twin/sources', { checkin: false });
const b1 = (await must('POST', '/twin/build', {})).data;
const items = flat(b1.twin.profile);
step(`用到的来源：${b1.used_sources.join('、')}；共 ${items.length} 条`);
for (const it of items) console.log(`   [${it.section}] ${it.text}（${it.source}｜${it.confidence}）`);
step(items.some((x) => x.source === '打卡' || /打卡/.test(x.text)) ? '⚠ 出现了打卡相关条目' : '档案中没有打卡相关条目');
step(`推测 ${items.filter((x) => x.confidence === '推测').length} / ${items.length}（应 ≤ 三分之一）`);

console.log('\n== ③ 上传含手机号、身份证号的文本 ==');
const up = (await must('POST', '/twin/uploads', { filename: '自我介绍.txt', kind: '自我介绍', text: '各位老师好，我是汉语言文学专业大二学生。联系电话13812345678，身份证号610302200501011234。我喜欢先说结论：我想做中学语文的阅读教学研究。' })).data;
step(up.note);
console.log(`   预览：${up.preview}`);
await must('POST', `/twin/uploads/${up.upload.id}/confirm`, {});
step('本人确认使用');

console.log('\n== ④ 锁定一条后重新生成 ==');
const g = (await must('GET', '/twin')).data;
const goal = g.twin.profile.goals[0] || g.twin.profile.basics[0];
const sec = g.twin.profile.goals[0] ? 'goals' : 'basics';
await must('POST', '/twin/corrections', { action: 'edit', section: sec, id: goal.id, text: '我要考西北大学学科教学（语文）专硕', lock: true });
const b2 = (await must('POST', '/twin/build', {})).data;
const still = b2.twin.profile[sec].find((x) => x.text === '我要考西北大学学科教学（语文）专硕');
step(still?.locked ? '锁定条目重新生成后仍在' : '⚠ 锁定条目被覆盖');
const fromUpload = flat(b2.twin.profile).filter((x) => x.source.startsWith('上传'));
step(`来自上传资料的条目 ${fromUpload.length} 条：${fromUpload.map((x) => x.text).join('；')}`);
step(JSON.stringify(b2.twin.profile).includes('13812345678') ? '⚠ 档案里出现了手机号' : '档案里没有手机号和身份证号');

console.log('\n== 分身对话（真实模型）==');
const f = events((await must('POST', '/twin/talk', { purpose: 'future', text: '未来的我，你上岸以后回头看，现在的我最该做对哪件小事？' }, HK)).text).find((e) => e.ev === 'done');
console.log(`   未来的我：${f.data.reply.replace(/\n+/g, ' ')}`);
const q = events((await must('POST', '/twin/talk', { purpose: 'rehearsal', text: '请你说说本科阶段读过的最有收获的一本专业书。' }, HK)).text).find((e) => e.ev === 'done');
console.log(`   复试彩排：${q.data.reply.replace(/\n+/g, ' ')}`);

console.log('\n== ⑤ 分身参加周复盘会 ==');
const s = (await must('POST', '/group/sessions', { mode: 'weekly' })).data.session;
const j = (await must('POST', `/group/sessions/${s.id}/twin`, {}, HK)).data.session;
const tw = j.messages.find((m) => m.speaker_type === 'twin');
console.log(`   分身发言（草稿=${tw.is_draft}）：${tw.content.replace(/\n+/g, ' ')}`);
const tasksBefore = (await must('GET', '/plan')).data.tasks.length;
const closed = (await must('POST', `/group/sessions/${s.id}/close`, {})).data.session;
step(`纪要 draft=${closed.summary.draft}；${closed.action_items.length} 条行动项`);
if (closed.action_items.length) {
  const c = await call('POST', `/group/sessions/${s.id}/actions/confirm`, { ids: [closed.action_items[0].id] });
  step(`草稿状态下确认行动项 → ${c.status} ${c.data?.code}`);
}
step(`方案任务数 ${tasksBefore} → ${(await must('GET', '/plan')).data.tasks.length}（应不变）`);

console.log('\n== API 实验室（真实模型）==');
const ms = (await must('POST', '/lab/models', {}, HK)).data;
step(`拉到 ${ms.models.length} 个模型：${ms.models.slice(0, 6).join('、')}${ms.models.length > 6 ? '…' : ''}；Key 显示 ${ms.key_mask}`);
const two = ms.models.includes(ms.default_model) ? [ms.default_model, ms.models.find((x) => x !== ms.default_model)].filter(Boolean) : ms.models.slice(0, 2);
const ev = events((await must('POST', '/lab/chat', { text: '用一句话解释“边际效用递减”。', system: '你是经济学助教，回答不超过40字。', temperature: 0.3, max_tokens: 300, models: two }, HK)).text);
for (const m of two) {
  const text = ev.filter((e) => e.ev === 'delta' && e.data.model === m).map((e) => e.data.text).join('');
  const end = ev.find((e) => e.ev === 'model_end' && e.data.model === m);
  console.log(`   ${m}（${end?.data?.ms ?? '?'}ms${end?.data?.error ? `，失败：${end.data.error}` : ''}）：${text.replace(/\n+/g, ' ').slice(0, 120)}`);
}
const ag = (await must('POST', '/lab/agents', { name: '单词出题官', system: '你根据我给的英语单词出三道选择题', model: ms.default_model, temperature: 0.5, max_tokens: 500 })).data.agent;
step(`保存小智能体「${ag.name}」`);

console.log('\n== ⑥ 删除分身 ==');
const d = (await must('DELETE', '/twin', { confirm: '删除分身' })).data;
step(`已删除：${JSON.stringify(d.deleted)}`);
const after = (await must('GET', '/twin')).data;
step(`删除后 GET /twin：exists=${after.twin.exists}，上传 ${after.uploads.length} 份，校正 ${after.corrections.length} 条`);
console.log(`\n测试学号（演练后请删除）：${sno}`);
