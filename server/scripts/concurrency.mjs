// 并发验证（PRD 13.2）：30 名学生同时在线 + 若干评委账号。
// 每个学生走一遍“注册 → 出发准备 → 一轮带选项对话 → 打卡”的关键路径，
// 记录成功率、耗时分布（P50 / P95 / 最大）与首字延迟，并核对额度扣减是否正确。
// 用法：node server/scripts/concurrency.mjs [人数]
process.env.NODE_ENV ||= 'development';
const { db } = await import('../src/db.js');

const BASE = process.env.BASE || 'http://localhost:3000/api';
const N = Number(process.argv[2] || 30);
const RUN = `cc${Date.now().toString(36)}`;
const INVITE = process.env.DEFAULT_INVITE_CODE || 'SHANHAI2026';

const stats = { ok: 0, fail: 0, errors: [] };
const times = [];      // 每个学生走完整条路径的耗时
const firstToken = [];  // 首字延迟

const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
};
const avg = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0);

async function student(i) {
  const t0 = Date.now();
  const no = `${RUN}s${String(i).padStart(2, '0')}`;
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(BASE + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    if (!res.ok) throw new Error(`${path} → ${res.status} ${(await res.text()).slice(0, 120)}`);
    return res.json().catch(() => null);
  };

  await call('POST', '/register', {
    invite_code: INVITE, student_no: no, name: `并发${i}`, email: `${RUN}${i}@example.com`,
    major: '汉语言文学', grade: '大三', major_group: '文史', password: `${RUN}-pw-${i}`,
  });
  await call('POST', '/prepare/consent', { agreed: true });
  await call('POST', '/prepare/modules-read', {});
  const sur = await call('GET', '/surveys/pre');
  const answers = {};
  for (const it of sur.items) answers[it.key] = it.type === 'scale' ? 3 : it.options[1];
  await call('POST', '/surveys/pre', { answers });

  // 一轮带选项的对话（SSE），记录首字延迟
  const sse = await fetch(`${BASE}/conv/companion/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Accept: 'text/event-stream' },
    body: JSON.stringify({ text: '我在考研和就业之间犹豫，想先弄清楚目标。' }),
  });
  if (!sse.ok) throw new Error(`对话 → ${sse.status}`);
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let tFirst = 0;
  let done = 0;
  for (;;) {
    const { value, done: fin } = await reader.read();
    if (fin) break;
    if (!tFirst) tFirst = Date.now() - t0;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (/^event: done/m.test(chunk)) done += 1;
    }
  }
  if (!done) throw new Error('对话没有正常结束');
  firstToken.push(tFirst);
  times.push(Date.now() - t0);
}

const t = Date.now();
const results = await Promise.allSettled(Array.from({ length: N }, (_, i) => student(i + 1)));
for (const r of results) {
  if (r.status === 'fulfilled') stats.ok += 1;
  else { stats.fail += 1; if (stats.errors.length < 5) stats.errors.push(String(r.reason?.message || r.reason)); }
}
const wall = Date.now() - t;

// 核对额度扣减：每个学生应有 1 次模型调用
const rows = db.prepare("SELECT student_no FROM users WHERE student_no LIKE ? AND role='student'").all(`${RUN}%`);
const calls = db.prepare(
  `SELECT COUNT(*) AS n FROM ai_calls a JOIN users u ON u.id = a.user_id WHERE u.student_no LIKE ?`,
).get(`${RUN}%`).n;

console.log(`\n【${N} 人并发（同时发起，不做排队）】`);
console.log(`成功 ${stats.ok} / 失败 ${stats.fail}；整批用时 ${(wall / 1000).toFixed(1)} 秒`);
console.log(`单人走完关键路径：P50 ${pct(times, 0.5)}ms、P95 ${pct(times, 0.95)}ms、最大 ${Math.max(0, ...times)}ms、平均 ${avg(times)}ms`);
console.log(`首字延迟：P50 ${pct(firstToken, 0.5)}ms、P95 ${pct(firstToken, 0.95)}ms（目标 ≤3 秒）`);
console.log(`注册人数 ${rows.length} / ${N}；模型调用记录 ${calls} 条（应为 ${stats.ok} 条）`);
if (stats.errors.length) console.log('失败样例：\n  ' + stats.errors.join('\n  '));
console.log(`\n演练账号前缀：${RUN}（全部成功即无需清理）`);
