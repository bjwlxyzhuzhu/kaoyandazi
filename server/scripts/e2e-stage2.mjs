// 端到端演练（阶段2完成标志）：对正在运行的应用走一遍“注册 → 出发准备 → 第2—5站 → 打卡”
// 运行：先启动 node server/src/index.js，再执行 node server/scripts/e2e-stage2.mjs
const B = process.env.BASE || 'http://localhost:3000/api';
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
const sno = `e2e${Date.now().toString().slice(-6)}`;

await call('POST', '/register', { invite_code: process.env.INVITE || 'SHANHAI2026', student_no: sno, name: '端到端测试', email: `${sno}@qq.com`, major: '汉语言文学', grade: '大二', major_group: '文史', password: 'e2e-pass-001' });
step(`注册 ${sno}；prepare_done = ${(await call('GET', '/me')).me.prepare_done}`);

await call('POST', '/prepare/consent', { agreed: true });
await call('POST', '/prepare/modules-read', {});
const survey = await call('GET', '/surveys/pre');
const ans = {};
for (const it of survey.items) ans[it.key] = it.type === 'scale' ? 4 : it.options[1];
await call('POST', '/surveys/pre', { answers: ans });
step(`出发准备四步完成；prepare_done = ${(await call('GET', '/me')).me.prepare_done}`);

const ch = await call('GET', '/chapters/1');
const quiz = await call('POST', '/chapters/1/tasks/t1', { content: { answers: { 1: '官方', 2: '院校', 3: '经验帖', 4: 'AI推断', 5: '经验帖', 6: '院校' } } });
step(`第1章课件 ${ch.courseware.pages.length} 页；t1 测验 ${quiz.correct}/${quiz.total}`);

await call('POST', '/menus/intake', { answers: { grade: '大二', major_group: '文史', tendency: '还没想好', weekly_hours: 14, english: '过四级', rank: '前30%', achievements: ['暂无'], troubles: ['不知道选什么'] } });
const talk = await call('POST', '/conv/intake/send', { text: '我想当中学语文老师，但家里希望我考公', agent_key: 'intake' });
const gen = await call('POST', '/profile/generate', {});
await call('PUT', '/profile', { profile: gen.profile });
step(`第2站：访谈一轮（${talk.text.includes('event: done') ? 'SSE 正常结束' : '异常'}），画像含路径 ${gen.profile.paths.map((p) => p.name).join('/')}`);

await call('POST', '/profile/choose', { path_id: 'kaoyan', reason: '我想当中学语文老师，读学科教学专硕能拿到更好的平台和教师资格，家里的考公建议我也会作为备选认真了解。' });
step('第3站：选定路径并写下理由');

await call('POST', '/menus/school', { answers: { subject: '学科教学（语文）', region: ['陕西'], level: '看专业实力不看牌子', degree: '专硕', cross: '就是本专业', risk: '稳健：一次上岸最重要' } });
const s = await call('POST', '/schools', { school: '陕西师范大学', major: '学科教学（语文）', tier: '稳妥', facts: [{ item: '考试科目', value: '待核实', source: '研究生院官网', url: 'https://yjsy.snnu.edu.cn/', level: '院校' }] });
await call('POST', `/schools/${s.school.id}/verify`, { index: 0 });
await call('PUT', `/schools/${s.school.id}`, { basis: '离家近，学科教学方向对口。', uncertainty: '今年招生人数尚未公布。' });
step('第4站：手动加入院校、核验一条数据、写齐依据与不确定之处（未绑定 Key，走手动路径）');

await call('POST', '/menus/plan', { answers: { weekly_hours: 14, slots: ['晚上', '周末'], focus: ['英语', '专业课'], research: '包含（推荐）', rhythm: '稳扎稳打' } });
const plan = await call('POST', '/plan/generate', {});
const saved = await call('POST', '/plan/save', { plan: plan.plan });
step(`第5站：方案采用，生成 ${saved.task_count} 个任务，每天上限 ${saved.daily_cap_minutes} 分钟`);

const today = await call('GET', '/checkin/today');
const ck = await call('POST', '/checkin', { done_task_ids: today.tasks.slice(0, 1).map((t) => t.id), minutes: 50, mood: 4, reflection: '英语单词背完了，专业课只开了个头，明天继续。' });
step(`打卡成功：完成 ${ck.done_count}/${ck.total_count}，连续 ${ck.streak} 天，盖章时间 ${ck.stamped_at}`);

const flow = await call('GET', '/flow');
console.log('\n主线状态：', flow.stations.slice(0, 6).map((x) => `${x.station}.${x.name}=${x.status}`).join('  '));
console.log('当前站：', flow.current, '\n测试学号（演示结束后请删除）：', sno);
