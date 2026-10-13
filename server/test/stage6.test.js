// 阶段6自测：数字分身（M19）、API实验室（M15）、导出与注销
// 通过标准：16.2 第3条——未同意不能建立 → 关闭“打卡与复盘”后档案里没有打卡条目 → 上传含手机号、身份证号的文本，入库前已遮盖
//          → 锁定一条后重新生成不被覆盖 → 分身参加周复盘会，纪要为草稿且未写入方案 → 删除后数据库里查不到
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

const { createApp } = await import('../src/app.js');
const { db, setSetting } = await import('../src/db.js');
const { todayLocal, addDays } = await import('../src/time.js');
const { redact, normalizeGenerated, mergeWithLocked, parseUpload } = await import('../src/twin.js');
const { makeZip } = await import('../src/research/zip.js');
const { deflateRawSync } = await import('node:zlib');

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
      return {
        status: res.status,
        events: text.trim().split('\n\n').filter(Boolean).map((c) => ({ ev: c.match(/^event: (.+)$/m)?.[1], data: JSON.parse(c.match(/^data: (.+)$/m)?.[1] || 'null') })),
      };
    }
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* 非 JSON */ }
    return { status: res.status, body: data, raw };
  }
  return { call };
}

const stu = client();
const KEY = { 'X-User-Key': 'sk-studentOwnKEY5678' };
let uid;

// ---------- 纯函数 ----------

test('敏感信息遮盖：身份证号、手机号、住址、家庭经济、健康信息', () => {
  const src = [
    '我叫小林，手机 13812345678，也可以打 138-1234-5678。',
    '身份证号 61030219990101123X。',
    '家住陕西省宝鸡市渭滨区经二路12号幸福小区3栋2单元501室。',
    '家庭年收入不到三万，我申请了助学贷款。',
    '去年确诊过焦虑症，现在在吃药。',
    '我喜欢读教育心理学，打算考学科教学（语文）。',
  ].join('\n');
  const { text, log } = redact(src);
  assert.ok(!text.includes('13812345678') && !text.includes('1234-5678'), '手机号已遮盖');
  assert.ok(!text.includes('61030219990101123X'), '身份证号已遮盖');
  assert.ok(!text.includes('幸福小区') && !text.includes('经二路'), '住址已遮盖');
  assert.ok(!text.includes('三万') && !text.includes('助学贷款'), '家庭经济已遮盖');
  assert.ok(!text.includes('焦虑症') && !text.includes('吃药'), '健康信息已遮盖');
  assert.ok(text.includes('学科教学（语文）'), '正常内容保留');
  const types = log.map((l) => l.type);
  for (const t of ['手机号', '身份证号', '住址', '家庭经济', '健康信息']) assert.ok(types.includes(t), `遮盖记录里有 ${t}`);
  assert.ok(!JSON.stringify(log).includes('138'), '遮盖记录只记类型和次数，不记原文');
});

test('档案规范化：来源必须是本次提供的、推测不超过三分之一、敏感推断被删', () => {
  const data = {
    basics: [
      { text: '大二', source: '访谈', confidence: '原话' },
      { text: '可能家庭经济困难', source: '访谈', confidence: '推测' },
      { text: '没给来源' },
    ],
    habits: [{ text: '连续打卡7天', source: '打卡', confidence: '数据' }],
    goals: [
      { text: '想读专硕', source: '画像', confidence: '原话' },
      { text: '猜他想去西安', source: '画像', confidence: '推测' },
      { text: '猜他喜欢教书', source: '画像', confidence: '推测' },
    ],
  };
  const p = normalizeGenerated(data, { used: ['profile'], uploads: [], sources: { checkin: false } });
  assert.deepEqual(p.basics.map((x) => x.text), ['大二'], '敏感推断和无来源条目被删');
  assert.equal(p.habits.length, 0, '“打卡”来源没有开启，条目被删');
  const all = Object.values(p).filter(Array.isArray).flat().filter((x) => typeof x === 'object');
  assert.ok(all.filter((x) => x.confidence === '推测').length <= Math.floor(all.length / 3), '推测不超过三分之一');
});

test('锁定合并：锁定的条目在重新生成后原样保留', () => {
  const old = { goals: [{ id: 'g1', text: '我要考西北大学', source: '本人修改', confidence: '原话', locked: true }, { id: 'g2', text: '旧的说法', source: '画像', confidence: '原话' }] };
  const fresh = { goals: [{ text: '想读专硕', source: '画像', confidence: '原话' }] };
  const m = mergeWithLocked(old, fresh);
  assert.ok(m.goals.some((x) => x.text === '我要考西北大学' && x.locked), '锁定条目保留');
  assert.ok(!m.goals.some((x) => x.text === '旧的说法'), '未锁定的旧条目被新结果替换');
  assert.ok(m.goals.some((x) => x.text === '想读专硕'));
});

test('上传解析：TXT（含 GBK）、Word（.docx）；图片和旧版 .doc 给出中文提示', async () => {
  assert.equal(await parseUpload(Buffer.from('自我介绍：我喜欢教育学。', 'utf8'), 'a.txt'), '自我介绍：我喜欢教育学。');
  const gbk = Buffer.from([0xCE, 0xD2, 0xCF, 0xB2, 0xBB, 0xB6]); // “我喜欢”
  assert.equal(await parseUpload(gbk, 'b.txt'), '我喜欢');
  // 构造一个最小的 .docx：word/document.xml，用 deflate 压缩（Word 实际就是这样存的）
  const xml = '<w:document><w:body><w:p><w:r><w:t>我的简历</w:t></w:r></w:p><w:p><w:r><w:t>手机 13900001111</w:t></w:r></w:p></w:body></w:document>';
  const store = makeZip([{ name: 'word/document.xml', data: xml }]);
  // 把 store 条目改写成 deflate 条目，验证 readZip 能解压
  const raw = Buffer.from(xml, 'utf8');
  const comp = deflateRawSync(raw);
  const nameLen = Buffer.byteLength('word/document.xml');
  const local = Buffer.from(store.slice(0, 30));
  local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18);
  const nameBuf = store.slice(30, 30 + nameLen);
  const cdStart = 30 + nameLen + raw.length;
  const cd = Buffer.from(store.slice(cdStart, cdStart + 46 + nameLen));
  cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20);
  const end = Buffer.from(store.slice(cdStart + 46 + nameLen));
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(30 + nameLen + comp.length, 16);
  const docx = Buffer.concat([local, nameBuf, comp, cd, end]);
  const t = await parseUpload(docx, '简历.docx');
  assert.ok(t.includes('我的简历') && t.includes('13900001111'), 'Word 正文读出来了（遮盖在下一步做）');
  await assert.rejects(parseUpload(Buffer.from([1, 2, 3]), 'x.png'), /OCR|识图/);
  await assert.rejects(parseUpload(Buffer.from([1, 2, 3]), 'x.doc'), /docx/);
});

// ---------- 16.2 第3条 ----------

test('准备：注册并攒一些数据（画像、路径、打卡、记忆）', async () => {
  const r = await stu.call('POST', '/register', {
    invite_code: 'TEST2026', student_no: '2024601', name: '分身测试生', email: 't@qq.com',
    major: '汉语言文学', grade: '大二', major_group: '文史', password: 'password-123',
  });
  uid = r.body.me.id;
  await stu.call('POST', '/prepare/consent', { agreed: true });
  await stu.call('POST', '/prepare/modules-read', {});
  const def = await stu.call('GET', '/surveys/pre');
  const answers = {};
  for (const it of def.body.items) answers[it.key] = it.type === 'scale' ? 3 : it.options[1];
  await stu.call('POST', '/surveys/pre', { answers });
  await stu.call('PUT', '/me', { persona: 'gentle' });
  await stu.call('POST', '/menus/intake', { answers: { grade: '大二', major_group: '文史', tendency: '考研', weekly_hours: 14, english: '过四级', rank: '前30%', achievements: ['暂无'], troubles: ['不知道选什么'] } });
  const gen = await stu.call('POST', '/profile/generate', {});
  await stu.call('PUT', '/profile', { profile: gen.body.profile });
  await stu.call('POST', '/profile/choose', { path_id: 'kaoyan', reason: '我想当中学语文老师，读学科教学专硕是最直接的路径，我愿意为此投入两年时间。' });
  db.prepare('INSERT INTO checkins(user_id, date, minutes, done_count, total_count, reflection, mood) VALUES(?, ?, ?, ?, ?, ?, ?)')
    .run(uid, addDays(todayLocal(), -1), 90, 2, 3, '今天背单词状态不错', 4);
  await stu.call('POST', '/memories', { content: '担心专业课背不下来', category: '困难' });
});

test('16.2-3①：未同意知情书时不能建立分身', async () => {
  const g = await stu.call('GET', '/twin');
  assert.equal(g.body.twin.exists, false);
  for (const [m, p, b] of [['POST', '/twin/build', {}], ['PUT', '/twin/sources', { checkin: false }], ['POST', '/twin/uploads', { text: 'x', filename: 'a.txt' }], ['POST', '/twin/talk', { purpose: 'future', text: '你好' }]]) {
    const r = await stu.call(m, p, b, KEY);
    assert.equal(r.status, 403, `${p} 应被拦下`);
    assert.equal(r.body.code, 'NEED_CONSENT');
  }
  assert.equal((await stu.call('POST', '/twin/consent', { agreed: false })).status, 400, '不勾选不能同意');
  const ok = await stu.call('POST', '/twin/consent', { agreed: true });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.twin.consented, true);
  assert.equal(ok.body.twin.name, '镜中我', '默认名字');
  assert.equal(Object.values(ok.body.twin.sources).every(Boolean), true, '数据来源默认全开');
  assert.equal(ok.body.sources.length, 7, '七个数据来源');
});

test('16.2-3②：关闭“打卡与复盘”后生成档案，档案里没有打卡条目', async () => {
  // 先全开生成一次，确认打卡数据确实会被用到
  const full = await stu.call('POST', '/twin/build', {});
  assert.equal(full.status, 200, full.body?.error);
  assert.ok(full.body.used_sources.includes('checkin'));
  const flat = (p) => Object.values(p).filter(Array.isArray).flat().filter((x) => typeof x === 'object');
  assert.ok(flat(full.body.twin.profile).some((x) => x.source === '打卡'), '全开时有打卡条目');

  const off = await stu.call('PUT', '/twin/sources', { checkin: false });
  assert.equal(off.body.twin.sources.checkin, false);
  const r = await stu.call('POST', '/twin/build', {});
  assert.ok(!r.body.used_sources.includes('checkin'), '本次没有用打卡数据');
  const items = flat(r.body.twin.profile);
  assert.ok(items.length > 0, '仍然生成了档案');
  assert.ok(!items.some((x) => x.source === '打卡' || /打卡/.test(x.text)), '档案中不出现打卡相关条目');
  assert.ok(items.every((x) => x.source && x.confidence), '每一条都有来源和可信度');
});

test('16.2-3③：上传含手机号、身份证号的文本，入库前已遮盖并提示确认', async () => {
  const text = '自我介绍：我是汉语言文学专业的学生，手机13812345678，身份证610302200501011234。我喜欢先说结论，再讲理由。';
  const up = await stu.call('POST', '/twin/uploads', { text, filename: '自我介绍.txt', kind: '自我介绍' });
  assert.equal(up.status, 200, up.body?.error);
  assert.equal(up.body.upload.confirmed, false, '上传后先是“待确认”');
  assert.ok(up.body.note.includes('遮盖'), '提示学生核对');
  const row = db.prepare('SELECT * FROM twin_uploads WHERE id = ?').get(up.body.upload.id);
  assert.ok(!row.text_redacted.includes('13812345678'), '库里没有手机号');
  assert.ok(!row.text_redacted.includes('610302200501011234'), '库里没有身份证号');
  assert.ok(row.text_redacted.includes('[已遮盖：手机号]') && row.text_redacted.includes('[已遮盖：身份证号]'));
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM twin_uploads').all()).includes('13812345678'), '任何一列都没有原文');

  // 未确认的资料不进档案
  const r1 = await stu.call('POST', '/twin/build', {});
  assert.ok(!Object.values(r1.body.twin.profile).flat().some((x) => String(x?.source || '').startsWith('上传')), '未确认的资料不被使用');
  const c = await stu.call('POST', `/twin/uploads/${up.body.upload.id}/confirm`, {});
  assert.equal(c.body.uploads[0].confirmed, true);
  const r2 = await stu.call('POST', '/twin/build', {});
  assert.ok(Object.values(r2.body.twin.profile).flat().some((x) => String(x?.source || '').startsWith('上传:自我介绍')), '确认后被使用');
});

test('16.2-3④：锁定一条档案后重新生成，不被覆盖；校正都有记录', async () => {
  const g = await stu.call('GET', '/twin');
  const goal = g.body.twin.profile.goals[0];
  assert.ok(goal, '有一条目标');
  const edit = await stu.call('POST', '/twin/corrections', { action: 'edit', section: 'goals', id: goal.id, text: '我要考西北大学学科教学（语文）专硕', lock: true });
  assert.equal(edit.status, 200, edit.body?.error);
  const locked = edit.body.twin.profile.goals.find((x) => x.text === '我要考西北大学学科教学（语文）专硕');
  assert.ok(locked.locked && locked.confirmed);
  for (let i = 0; i < 2; i += 1) {
    const r = await stu.call('POST', '/twin/build', {});
    const still = r.body.twin.profile.goals.find((x) => x.text === '我要考西北大学学科教学（语文）专硕');
    assert.ok(still && still.locked, `第${i + 1}次重新生成后锁定条目仍在`);
  }
  // 其他校正：新增、删除、敏感内容被拒
  const add = await stu.call('POST', '/twin/corrections', { action: 'add', section: 'values', text: '我更看重离家近' });
  assert.ok(add.body.twin.profile.values.some((x) => x.text === '我更看重离家近' && x.source === '本人补充'));
  const bad = await stu.call('POST', '/twin/corrections', { action: 'add', section: 'basics', text: '我的手机号是13800001111' });
  assert.equal(bad.status, 400, '隐私内容不进档案');
  const v = add.body.twin.profile.values.find((x) => x.text === '我更看重离家近');
  const del = await stu.call('POST', '/twin/corrections', { action: 'delete', section: 'values', id: v.id });
  assert.ok(!del.body.twin.profile.values.some((x) => x.id === v.id));
  assert.ok(del.body.corrections.length >= 3, '每次修改都记入校正记录');
  // 改名：不允许恋爱设定
  assert.equal((await stu.call('PUT', '/twin', { name: '男友' })).status, 400);
  assert.equal((await stu.call('PUT', '/twin', { name: '小镜', icon: 'river' })).body.twin.name, '小镜');
});

test('分身对话：需要自己的 Key；每段带【分身推测】；记为草稿；危机兜底', async () => {
  const noKey = await stu.call('POST', '/twin/talk', { purpose: 'future', text: '未来的我，你好' });
  assert.equal(noKey.status, 403);
  assert.equal(noKey.body.code, 'NEED_USER_KEY');
  const r = await stu.call('POST', '/twin/talk', { purpose: 'future', text: '未来的我，当时做对了什么？' }, KEY);
  const done = r.events.find((e) => e.ev === 'done');
  assert.ok(done.data.reply.includes('【分身推测】'));
  assert.equal(done.data.draft, true);
  const crisis = await stu.call('POST', '/twin/talk', { purpose: 'future', text: '我真的撑不下去了，不想活了' }, KEY);
  const cd = crisis.events.find((e) => e.ev === 'done');
  assert.ok(cd.data.crisis && cd.data.reply.includes('12356'), '转入心理危机兜底');
  const talks = await stu.call('GET', '/twin/talks');
  assert.ok(talks.body.conversations.length >= 2);
});

test('16.2-3⑤：分身参加周复盘会，纪要标记为草稿且未写入方案', async () => {
  const s = await stu.call('POST', '/group/sessions', { mode: 'weekly' });
  const sid = s.body.session.id;
  const noKey = await stu.call('POST', `/group/sessions/${sid}/twin`, {});
  assert.equal(noKey.status, 403, '分身参会是高阶功能');
  const j = await stu.call('POST', `/group/sessions/${sid}/twin`, {}, KEY);
  assert.equal(j.status, 200, j.body?.error);
  assert.equal(j.body.session.twin_joined, true);
  const tw = j.body.session.messages.find((m) => m.speaker_type === 'twin');
  assert.ok(tw && tw.is_draft && tw.content.includes('【分身推测】'), '分身发言是草稿并带标记');

  const tasksBefore = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?').get(uid).n;
  const close = await stu.call('POST', `/group/sessions/${sid}/close`, {});
  assert.equal(close.status, 200, close.body?.error);
  assert.equal(close.body.session.summary.draft, true, '纪要标记为草稿');
  const items = close.body.session.action_items;
  if (items.length) {
    const conf = await stu.call('POST', `/group/sessions/${sid}/actions/confirm`, { ids: [items[0].id] });
    assert.equal(conf.status, 400, '草稿纪要下不能确认行动项');
    assert.equal(conf.body.code, 'DRAFT');
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?').get(uid).n, tasksBefore, '方案里没有新增任务');

  // 本人确认纪要后，才可以按正常流程确认行动项
  const ok = await stu.call('POST', `/group/sessions/${sid}/draft/confirm`, { decision: '这周先把单词补上' });
  assert.equal(ok.body.session.summary.draft, false);
  assert.equal(ok.body.session.summary.decision, '这周先把单词补上');
  if (items.length) {
    const conf = await stu.call('POST', `/group/sessions/${sid}/actions/confirm`, { ids: [items[0].id] });
    assert.equal(conf.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?').get(uid).n, tasksBefore + 1, '本人确认后只写入勾选的1条');
  }
  // 分身只能参加周复盘会
  const other = await stu.call('POST', '/group/sessions', { mode: 'stuck' });
  assert.equal((await stu.call('POST', `/group/sessions/${other.body.session.id}/twin`, {}, KEY)).status, 400);
});

test('隐私：教师端没有任何分身接口，学生详情里看不到分身', async () => {
  const tea = client();
  await tea.call('POST', '/login', { student_no: 'teacher', password: 'teacher-pass-123' });
  assert.equal((await tea.call('GET', '/twin')).status, 403, '教师访问学生分身接口被拒');
  const list = await tea.call('GET', '/teacher/students/memory-stats');
  assert.ok(!JSON.stringify(list.body || {}).includes('镜中我') && !JSON.stringify(list.body || {}).includes('小镜'));
});

test('16.2-3⑥：删除分身后数据库里查不到相关记录；长期记忆不受影响', async () => {
  const memBefore = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').get(uid).n;
  assert.equal((await stu.call('DELETE', '/twin', { confirm: '随便' })).status, 400, '需要二次确认');
  const d = await stu.call('DELETE', '/twin', { confirm: '删除分身' });
  assert.equal(d.status, 200);
  for (const t of ['twins', 'twin_uploads', 'twin_corrections', 'twin_conversations']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(uid).n, 0, `${t} 已清空`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM group_messages WHERE speaker_type = 'twin'").get().n, 0, '会议里分身的发言也删了');
  const dump = JSON.stringify(db.prepare("SELECT * FROM group_messages").all());
  assert.ok(!dump.includes('分身推测'), '库里再也找不到分身发言');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').get(uid).n, memBefore, '长期记忆不受影响');
  assert.equal((await stu.call('GET', '/twin')).body.twin.exists, false);
});

// ---------- M15 API实验室 ----------

test('API实验室：需要 Key；单模型与双模型对比；临时 Key；小智能体增删改；看懂平台', async () => {
  assert.equal((await stu.call('POST', '/lab/models', {})).status, 403, '高阶模块需要自己的 Key');
  const m = await stu.call('POST', '/lab/models', {}, KEY);
  assert.ok(m.body.models.length >= 1);
  assert.ok(m.body.key_mask.includes('****') && !m.body.key_mask.includes('studentOwnKEY'), 'Key 只显示掩码');
  const tmp = await stu.call('POST', '/lab/models', { temp_key: 'sk-tempKEY000111' });
  assert.equal(tmp.status, 200, '临时 Key 可用');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM users').all()).includes('tempKEY'), '临时 Key 没入库');

  const one = await stu.call('POST', '/lab/chat', { text: '用一句话解释什么是温度参数', system: '你是助教', temperature: 0.2, max_tokens: 200 }, KEY);
  assert.equal(one.events.filter((e) => e.ev === 'model_start').length, 1);
  const two = await stu.call('POST', '/lab/chat', { text: '同一个问题', models: ['mock-chat', 'mock-reasoner'] }, KEY);
  const starts = two.events.filter((e) => e.ev === 'model_start').map((e) => e.data.model);
  assert.deepEqual(starts, ['mock-chat', 'mock-reasoner'], '双模型依次回答');
  assert.ok(two.events.filter((e) => e.ev === 'delta').some((e) => e.data.model === 'mock-reasoner'));

  assert.equal((await stu.call('POST', '/lab/agents', { name: '', system: 'x' })).status, 400);
  const a = await stu.call('POST', '/lab/agents', { name: '单词出题官', system: '你根据我给的单词出三道选择题', model: 'mock-chat', temperature: 0.5, max_tokens: 500 });
  assert.equal(a.status, 200);
  const u2 = await stu.call('PUT', `/lab/agents/${a.body.agent.id}`, { temperature: 0.9 });
  assert.equal(u2.body.agent.temperature, 0.9);
  assert.equal((await stu.call('GET', '/lab/agents')).body.agents.length, 1);
  assert.equal((await stu.call('DELETE', `/lab/agents/${a.body.agent.id}`)).status, 200);

  const an = await stu.call('GET', '/lab/anatomy');
  assert.equal(an.body.formula, '智能体 = 模型 + 提示词 + 工具 + 记忆');
  assert.ok(an.body.system_prompt.includes('检索导师'));
  assert.ok(an.body.tool_call_example.note.includes('示例'), '工具调用样例明确标注为示例');
});

// ---------- 导出与注销 ----------

test('导出我的数据不含密码与 Key；注销需要密码和确认词，之后数据全部清除', async () => {
  const ex = await stu.call('GET', '/me/export');
  assert.equal(ex.status, 200);
  const data = JSON.parse(ex.raw);
  assert.equal(data.app, '山海问知');
  assert.ok(!('pw_hash' in data.users[0]) && !('key_enc' in data.users[0]), '不导出密码哈希与加密 Key');
  assert.ok(data.memories.length >= 1 && data.checkins.length >= 1);

  assert.equal((await stu.call('DELETE', '/me', { password: 'wrong', confirm: '注销账号' })).status, 400);
  assert.equal((await stu.call('DELETE', '/me', { password: 'password-123', confirm: '好' })).status, 400);
  const d = await stu.call('DELETE', '/me', { password: 'password-123', confirm: '注销账号' });
  assert.equal(d.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?').get(uid).n, 0);
  for (const t of ['memories', 'checkins', 'profiles', 'conversations', 'group_sessions', 'lab_agents', 'ai_calls']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?`).get(uid).n, 0, `${t} 已清空`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_reviews WHERE reviewer_id = ?').get(uid).n, 0, '互评记录也清空');
  assert.equal((await stu.call('GET', '/me')).status, 401, '注销后登录态失效');
});
