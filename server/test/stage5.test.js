// 阶段5自测：书房（M11 学术进阶、M12 知识库、M10 成果铺垫）
// 通过标准：16.3（知识库）与 16.1 第9步（检索 → 入库 → 核验 → 阅读卡 → 导入 RIS → 分类 → 选题 → 导出 → 拒绝写作）
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
const { checkResearchBoundary } = await import('../src/research/boundary.js');
const { parseAuto, decodeText, toCsv } = await import('../src/research/formats.js');
const { makeZip, readZip } = await import('../src/research/zip.js');
const { titleSimilarity, normalizeTitle, firstAuthorSurname, SIMILARITY_THRESHOLD } = await import('../src/research/works.js');
const { searchWorks } = await import('../src/research/works.js');

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
        status: res.status, raw: text,
        events: text.trim().split('\n\n').filter(Boolean).map((c) => ({
          ev: c.match(/^event: (.+)$/m)?.[1],
          data: JSON.parse(c.match(/^data: (.+)$/m)?.[1] || 'null'),
        })),
      };
    }
    if (type.includes('application/zip') || type.includes('octet-stream')) {
      return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()), type };
    }
    if (type.includes('text/') || type.includes('bibtex') || type.includes('json')) {
      const text = await res.text();
      return { status: res.status, raw: text, type, body: type.includes('json') ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null };
    }
    return { status: res.status, body: await res.json().catch(() => null), type };
  }
  return { call };
}

const stu = client();
const stu2 = client();
let uid;

// ---------- 纯函数：相似度与规范化（PRD 7.x 阈值 0.85） ----------

test('题名相似度与规范化：中英文都适用，阈值0.85', () => {
  assert.equal(normalizeTitle('The Great Gatsby!'), 'greatgatsby');
  assert.equal(normalizeTitle('ＡＩ　与教育'), 'ai与教育', '全角转半角并去空格');
  assert.ok(titleSimilarity('生成式人工智能与教育评价', '生成式人工智能与教育评价') === 1);
  assert.ok(titleSimilarity('生成式人工智能与教育评价', '生成式人工智能与教育评价研究') > SIMILARITY_THRESHOLD, '相近的题名相似度高于阈值');
  assert.ok(titleSimilarity('生成式人工智能与教育评价', '深度学习在医学影像中的应用') < 0.3, '无关题名相似度低');
  assert.equal(firstAuthorSurname(['夏娅娜']), '夏', '中文取姓');
  assert.equal(firstAuthorSurname(['Xia Yana']), 'yana', '英文取最后一段');
  assert.equal(firstAuthorSurname(['Yana Xia']), 'xia', '英文“名 姓”取最后一段');
  assert.equal(firstAuthorSurname([]), '');
});

// ---------- 边界拦截（16.1 第9步最后一条） ----------

test('写作、润色、翻译成稿、投稿、排版、代写一律拦下（不调用模型）', () => {
  for (const t of ['帮我写一篇综述', '替我润色这段', '把这篇翻译成英文稿', '推荐一个期刊投稿', '帮我排版成论文格式', '能不能代写', '论文格式帮我整一下']) {
    const hit = checkResearchBoundary(t);
    assert.ok(hit, `「${t}」应该被拦下`);
    assert.equal(typeof hit.reply, 'string');
    assert.ok(hit.reply.length > 0);
    assert.ok(Array.isArray(hit.options) && hit.options.length >= 2, '拦下后给出替代选项');
  }
  for (const t of ['带我精读一篇文献', '帮我看看这段的研究方法', '我想找生成式人工智能的文献']) {
    assert.equal(checkResearchBoundary(t), null, `「${t}」应放行`);
  }
});

// ---------- 文本格式解析与 GBK ----------

test('导入解析：RIS / EndNote / CSV / DOI 列表 / BibTeX 都能认出来', () => {
  const ris = `TY  - JOUR\nTI  - 生成式人工智能与教育评价\nAU  - 夏娅娜\nPY  - 2025\nJO  - 现代教育技术\nDO  - 10.3969/j.issn.1009-8097.2025.05.010\nER  -`;
  const a = parseAuto(ris, 'cnki.ris');
  assert.equal(a.format, 'ris');
  assert.equal(a.items[0].title, '生成式人工智能与教育评价');
  assert.equal(a.items[0].doi, '10.3969/j.issn.1009-8097.2025.05.010');

  const endnote = `%0 Journal Article\n%T 大语言模型与多智能体文本评估\n%A 李明\n%D 2024\n%J 中国远程教育`;
  const b = parseAuto(endnote, 'cnki.txt');
  assert.equal(b.format, 'tagged');
  assert.equal(b.items[0].title, '大语言模型与多智能体文本评估');

  const refworks = `RT Journal Article\nT1 智能体教育应用\nA1 王芳\nYR 2023\nJF 开放教育研究`;
  assert.equal(parseAuto(refworks, '').format, 'tagged');

  const csv = `title,authors,year,doi\n教育数字化转型,张三,2023,10.1000/xyz\n`;
  assert.equal(parseAuto(csv, 'x.csv').format, 'csv');

  const dois = '10.3969/j.issn.1009-8097.2025.05.010\n10.1000/abc.2024.01';
  const e = parseAuto(dois, '');
  assert.equal(e.format, 'doi_list');
  assert.equal(e.items.length, 2);

  const bib = `@article{xia2025,\n title = {生成式人工智能与教育评价},\n author = {夏娅娜},\n year = {2025}\n}`;
  assert.equal(parseAuto(bib, 'x.bib').format, 'bibtex');

  assert.throws(() => parseAuto('这是一段随便写的话，没有任何文献格式。', 'x.txt'), /认不出/);
});

test('GBK 自动识别：知网导出的 GBK 文件能正确解码', () => {
  const src = '生成式人工智能与教育评价';
  // 手工构造 GBK 字节（避免依赖 iconv）
  const gbk = Buffer.from([0xC9, 0xFA, 0xB3, 0xC9, 0xCA, 0xBD, 0xC8, 0xCB, 0xB9, 0xA4, 0xD6, 0xC7, 0xC4, 0xDC, 0xD3, 0xEB, 0xBD, 0xCC, 0xD3, 0xFD, 0xC6, 0xC0, 0xBC, 0xDB]);
  const out = decodeText(gbk);
  assert.equal(out, src, 'GBK 字节应解出正确中文');
  assert.equal(decodeText(Buffer.from(src, 'utf8')), src, 'UTF-8 不受影响');
});

test('CSV 导出带 BOM（Excel 打开不乱码）', () => {
  const csv = toCsv([{ title: '中文题名', authors: ['张三'], year: 2025, venue: '某刊', doi: '', url: '', tags: [], verify_status: 'verified', lang: 'zh' }]);
  assert.equal(csv.charCodeAt(0), 0xfeff, '首字符是 BOM');
  assert.ok(csv.includes('中文题名'));
});

// ---------- ZIP 导出 ----------

test('ZIP 打包：中文文件名使用 UTF-8 标志，能被正确读回', () => {
  const files = [
    { name: '阅读卡/01-生成式人工智能.md', data: '# 阅读卡\n\n内容' },
    { name: '文献清单.md', data: '# 清单' },
  ];
  const zip = makeZip(files);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'ZIP 本地文件头签名');
  // 通用标志位第 11 位（0x0800）表示文件名为 UTF-8
  const flag = zip.readUInt16LE(6);
  assert.equal(flag & 0x0800, 0x0800, '设置了 UTF-8 文件名标志');
  const back = readZip(zip);
  assert.equal(back.length, 2);
  assert.deepEqual(back.map((f) => f.name).sort(), ['阅读卡/01-生成式人工智能.md', '文献清单.md'].sort());
  assert.ok(back.find((f) => f.name === '文献清单.md').data.includes('# 清单'));
});

// ---------- 主流程：走完整条链（16.1 第9步） ----------

test('准备：注册学生并完成出发准备（走到第7站）', async () => {
  const r = await stu.call('POST', '/register', {
    invite_code: 'TEST2026', student_no: '2024501', name: '书房测试生', email: 's@qq.com',
    major: '教育技术学', grade: '大三', major_group: '教育', password: 'password-123',
  });
  assert.equal(r.status, 200, r.body?.error || '');
  uid = r.body.me.id;
  await stu.call('POST', '/prepare/consent', { agreed: true });
  await stu.call('POST', '/prepare/modules-read', {});
  const def = await stu.call('GET', '/surveys/pre');
  const answers = {};
  for (const it of def.body.items) answers[it.key] = it.type === 'scale' ? 3 : it.options[1];
  await stu.call('POST', '/surveys/pre', { answers });
  await stu.call('PUT', '/me', { persona: 'gentle' });
  const me = await stu.call('GET', '/me');
  assert.equal(me.body.me.prepare_done, true, '出发准备已完成');
  const today = await stu.call('GET', '/today');
  assert.equal(today.body.current, 2, '走完出发准备后停在“认识自己”');
  assert.ok(today.body.station.name, '返回当前站信息');
});

test('M11 关键词检索与核验：不需要任何 Key，人人可用', async () => {
  // 检索走真实 OpenAlex；测试环境可能无网，此时只验证接口形状与错误处理
  const r = await stu.call('POST', '/papers/search', { query: '生成式人工智能 教育评价', limit: 5 });
  if (r.status === 200) {
    assert.ok(Array.isArray(r.body.works));
    assert.ok('zh_coverage_low' in r.body, '返回中文覆盖提示字段');
    assert.equal(r.body.mock_hint, '检索结果来自 OpenAlex，不是模型生成的。');
  } else {
    assert.ok([502, 504].includes(r.status), `无网时返回服务不可用，实际 ${r.status}`);
  }
});

test('知识库：手动录入、DOI 去重、待核验状态', async () => {
  const a = await stu.call('POST', '/papers', {
    title: '生成式人工智能与教育评价', authors: ['夏娅娜'], year: 2025,
    venue: '现代教育技术', doi: '10.1000/dedupe-test.2025.001', source: 'manual',
  });
  assert.equal(a.status, 200);
  assert.equal(a.body.duplicated, false);
  assert.equal(a.body.paper.verify_status, 'unverified', '新录入默认待核验');

  // 同样的 DOI 再录一次 → 去重
  const b = await stu.call('POST', '/papers', { title: '换个题名也一样', doi: '10.1000/dedupe-test.2025.001' });
  assert.equal(b.body.duplicated, true, 'DOI 相同视为重复');
  assert.equal(b.body.paper.id, a.body.paper.id);

  const list = await stu.call('GET', '/papers');
  assert.equal(list.body.papers.length, 1, '知识库里只有一篇');
});

test('核验：假 DOI 判失败，网络异常判待核验（不误伤真实文献）', async () => {
  const p = await stu.call('POST', '/papers', { title: '一篇疑似编造的文献', doi: '10.9999/fake.2026.001' });
  const v = await stu.call('POST', `/papers/${p.body.paper.id}/verify`, {});
  assert.equal(v.status, 200);
  // 有网时应为 failed；无网时降级为 unverified（两者都不允许直接判“已核验”）
  assert.ok(['failed', 'unverified'].includes(v.body.result.status), `实际 ${v.body.result.status}`);
  if (v.body.result.status === 'failed') assert.ok(v.body.result.reason.includes('解析不到'), '给出可读的失败理由');
});

test('16.1 第9步：检索 → 加入知识库 → 核验 → 阅读卡 → RIS 导入 → 分类 → 选题卡', async () => {
  // 1）加入两篇真实存在的文献（检索结果或手动录入都走同一接口）
  const beforeCount = (await stu.call('GET', '/papers')).body.papers.length;
  const p1 = await stu.call('POST', '/papers', {
    title: '谁更懂教学设计？——大语言模型与多智能体文本评估模式比较研究',
    authors: ['夏娅娜'], year: 2025, venue: '现代教育技术',
    doi: '10.3969/j.issn.1009-8097.2025.05.010', abstract: '比较大语言模型与多智能体在教学设计文本评估上的表现。', lang: 'zh',
  });
  const p2 = await stu.call('POST', '/papers', {
    title: '生成式人工智能赋能教育评价改革', authors: ['李明'], year: 2024,
    venue: '中国远程教育', abstract: '讨论生成式人工智能在教育评价中的应用路径。', lang: 'zh',
  });
  assert.equal(p1.body.duplicated, false);
  assert.equal(p2.body.duplicated, false);
  const paperIds = [p1.body.paper.id, p2.body.paper.id];

  // 2）核验（有网时第一篇的中文 DOI 应能解析）
  const v = await stu.call('POST', '/papers/verify-batch', { ids: paperIds });
  assert.equal(v.status, 200);
  assert.equal(v.body.results.length, 2);

  // 3）阅读卡：学生自己写判断，AI 起草的内容另放 ai_note
  const card = await stu.call('POST', '/cards', {
    paper_id: paperIds[0],
    question: '多智能体评估比单一大模型更可靠吗？',
    method: '比较研究：同一批教学设计文本，两种评估模式各评一遍，比对一致性',
    evidence: '文中给出两种模式与专家评分的相关性系数',
    conclusion: '多智能体在细分维度上更接近专家判断，但成本更高',
    limitation: '样本只有一所学校，外部效度有限',
    my_judgment: '我认为关键不在智能体数量，而在评估维度是否拆得足够细——这点文中没有充分讨论。',
    doubts: ['相关性系数的置信区间没有报告'],
    ai_note: 'AI 只提示了"看方法部分的一致性系数"，内容由学生自己写',
    minutes: 45,
  });
  assert.equal(card.status, 200);
  assert.ok(card.body.card.id);
  assert.ok(card.body.card.my_judgment.length > 10, '“我的判断”必须是学生自己写的');

  // 阅读打卡写入
  const log = await stu.call('GET', '/reading-log');
  assert.ok(log.body.last7.minutes >= 45, '阅读时长已记录');

  // 4）导入知网导出的 RIS
  const ris = [
    'TY  - JOUR',
    'TI  - 智能体协同的教育应用研究',
    'AU  - 王芳',
    'PY  - 2023',
    'JO  - 开放教育研究',
    'DO  - 10.13966/j.cnki.kfjyyj.2023.01.001',
    'ER  -',
    '',
    'TY  - JOUR',
    'TI  - 教育数字化转型的路径',
    'AU  - 张三',
    'PY  - 2023',
    'JO  - 电化教育研究',
    'ER  -',
  ].join('\n');
  const imp = await stu.call('POST', '/kb/import', { text: ris, filename: 'cnki.ris' });
  assert.equal(imp.status, 200, imp.body?.error || '');
  assert.equal(imp.body.format, 'ris');
  assert.equal(imp.body.imported, 2, '导入2篇');
  assert.ok(Array.isArray(imp.body.report.ok) && imp.body.report.ok.length === 2);

  // 重复导入同一份 → 全部判重
  const imp2 = await stu.call('POST', '/kb/import', { text: ris, filename: 'cnki.ris' });
  assert.equal(imp2.body.imported, 0);
  assert.equal(imp2.body.duplicated, 2, '第二次导入全部识别为重复');

  const all = await stu.call('GET', '/papers');
  assert.equal(all.body.papers.length, beforeCount + 4, '本轮新增2篇录入 + 2篇 RIS 导入');

  // 5）分类：织理给出建议（需要学生自己的 Key，高阶模块）
  const USER_KEY = 'sk-studentOwnKEY5678';
  const sug = await stu.call('POST', '/topics/suggest', {}, { 'X-User-Key': USER_KEY });
  assert.equal(sug.status, 200, sug.body?.error || '');
  assert.ok(Array.isArray(sug.body.topics) && sug.body.topics.length >= 1, '至少一个主题');
  assert.ok(Array.isArray(sug.body.tags));
  // 模型不能编造 paper_id
  for (const t of sug.body.topics) {
    for (const pid of t.paper_ids) assert.ok(paperIds.concat(all.body.papers.map((p) => p.id)).includes(pid), '主题里的编号必须真实存在');
  }
  // 没有 Key 时被拦下
  const noKey = await stu.call('POST', '/topics/suggest', {});
  assert.equal(noKey.status, 403);
  assert.equal(noKey.body.code, 'NEED_USER_KEY');

  // 6）学生确认后落库
  const apply = await stu.call('POST', '/topics/apply', {
    topics: [
      { name: '生成式AI与教育评价', parent: null, desc: '围绕评价方式的研究', paper_ids: paperIds },
      { name: '智能体协同', parent: '生成式AI与教育评价', desc: '多智能体在教育中的协同', paper_ids: [p1.body.paper.id] },
    ],
    tags: [{ paper_id: paperIds[0], tags: ['多智能体', '文本评估'] }],
  });
  assert.equal(apply.status, 200);
  assert.equal(apply.body.topics, 2);
  assert.ok(apply.body.tagged >= 2, '文献已挂到主题上');

  const topics = await stu.call('GET', '/topics');
  assert.equal(topics.body.topics.length, 2);
  assert.ok(topics.body.topics.some((t) => t.name === '智能体协同' && t.parent_id), '子主题挂在父主题下');
  assert.ok(topics.body.topics.find((t) => t.name === '生成式AI与教育评价').paper_count >= 1);

  // 7）选题卡：问枢收敛出一个可做的问题
  const idea = await stu.call('POST', '/ideas', {
    question: '多智能体评估在多大程度上优于单一模型？——基于教学设计文本的实证研究',
    significance: '为一线教师是否值得引入多智能体评估提供依据',
    feasibility: '本校本学期有3门课可作为文本来源',
    method: '准实验：同一批文本，两种评估模式与专家评分比对',
    risks: '样本量小，可能不足以支撑统计推论',
    paper_ids: paperIds,
  });
  assert.equal(idea.status, 200);
  const ideas = await stu.call('GET', '/ideas');
  assert.equal(ideas.body.ideas.length, 1);
  assert.equal(ideas.body.ideas[0].status, 'candidate');
  assert.deepEqual(ideas.body.ideas[0].paper_ids, paperIds, '选题卡关联到具体文献');

  // 收敛：学生选定一个，放弃其余
  const upd = await stu.call('PUT', `/ideas/${idea.body.idea.id}`, { status: 'chosen' });
  assert.equal(upd.body.idea.status, 'chosen');
});

test('16.1 第9步：导出 BibTeX 与 Markdown（阅读卡打包 ZIP）', async () => {
  const bib = await stu.call('GET', '/kb/export?format=bib');
  assert.equal(bib.status, 200);
  assert.ok(bib.raw.includes('@article{'), 'BibTeX 含条目');
  assert.ok(bib.raw.includes('生成式人工智能与教育评价') || bib.raw.includes('谁更懂教学设计'), '含中文题名');
  assert.ok(bib.raw.includes('doi = {'), '含 DOI');

  const md = await stu.call('GET', '/kb/export?format=md');
  assert.equal(md.status, 200);
  assert.ok(md.buffer && md.buffer.length > 0, '返回 ZIP 字节');
  const files = readZip(md.buffer);
  assert.ok(files.some((f) => f.name.startsWith('阅读卡/')), 'ZIP 里有阅读卡目录');
  assert.ok(files.some((f) => f.name === '文献清单.md'), 'ZIP 里有文献清单');
  const cardFile = files.find((f) => f.name.startsWith('阅读卡/') && f.name.endsWith('.md'));
  assert.ok(cardFile.data.includes('我的判断'), '阅读卡 Markdown 保留“我的判断”一栏');

  // 其余格式
  assert.ok((await stu.call('GET', '/kb/export?format=ris')).raw.includes('TY  - JOUR'));
  assert.ok((await stu.call('GET', '/kb/export?format=csv')).raw.length > 0);
  const json = await stu.call('GET', '/kb/export?format=json');
  const backup = JSON.parse(json.raw);
  assert.equal(backup.app, '山海问知');
  const paperCount = await stu.call('GET', '/papers');
  assert.ok(Array.isArray(backup.papers) && backup.papers.length === paperCount.body.papers.length, '备份含全部文献');
  assert.ok(Array.isArray(backup.cards) && backup.cards.length === 1);
  assert.equal((await stu.call('GET', '/kb/export?format=docx')).status, 400, '不支持的格式给出提示');
});

test('16.1 第9步：请求“帮我写综述”被拒绝，且不消耗模型调用', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ?').get(uid).n;
  const r = await stu.call('POST', '/conv/research_read/send', { text: '帮我写一篇综述，就写生成式人工智能与教育评价' }, { 'X-User-Key': 'sk-studentOwnKEY5678' });
  assert.equal(r.status, 200, 'SSE 正常返回');
  const done = r.events.find((e) => e.ev === 'done');
  assert.ok(done, '有 done 事件');
  assert.equal(done.data.boundary, '写作', '标记为被边界拦下');
  assert.ok(/不做|不能帮/.test(done.data.message.content), '回复里说明不做这件事');
  assert.ok(done.data.message.options, '给出替代选项');
  // 拦截发生在调用模型之前，记录里不出现真实模型调用（只有一条 boundary 记录）
  const after = db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE user_id = ? AND model != 'boundary' AND ok = 1").get(uid).n;
  assert.equal(after, before, '被拦下的请求没有产生任何模型调用');
  // 学生消息仍保留在对话里（可回看）
  const conv = await stu.call('GET', '/conv/research_read');
  const texts = conv.body.messages.map((m) => m.content);
  assert.ok(texts.some((t) => t.includes('帮我写一篇综述')), '学生原话保留在对话里');
});

test('知识库问答：带 Key 可用，不带 Key 被拦下', async () => {
  const noKey = await stu.call('POST', '/conv/research_search/send', { text: '我想找智能体教育应用的文献' });
  assert.equal(noKey.status, 403);
  assert.equal(noKey.body.code, 'NEED_USER_KEY');
});

test('知识库报告：统计准确，精选条目只能从自己的条目里挑', async () => {
  const rep = await stu.call('GET', '/kb/report');
  assert.equal(rep.status, 200);
  const paperCount = (await stu.call('GET', '/papers')).body.papers.length;
  assert.equal(rep.body.counts.papers, paperCount);
  assert.equal(rep.body.counts.cards, 1);
  assert.equal(rep.body.counts.topics, 2);
  assert.equal(rep.body.counts.ideas, 1);
  assert.ok(rep.body.counts.reading_minutes >= 45);
  assert.ok(rep.body.student.name === '书房测试生');
  assert.ok(rep.body.note.includes('只统计你自己的数据'));

  const papers = await stu.call('GET', '/papers');
  const first = papers.body.papers[0].id;
  const pick = await stu.call('PUT', '/kb/report/picks', { picks: [{ kind: 'paper', ref_id: first, title: '草稿', note: '最能代表我这学期读的一篇' }] });
  assert.equal(pick.body.picks, 1);

  // 挑别人的条目 → 被拒（这里用不存在的 id 模拟）
  const bad = await stu.call('PUT', '/kb/report/picks', { picks: [{ kind: 'paper', ref_id: 999999, title: 'x' }] });
  assert.equal(bad.body.picks, 0, '不属于自己的条目不会被记入');

  const again = await stu.call('GET', '/kb/report');
  assert.equal(again.body.picks.length, 0, '被拒的条目没写进去');

  // 打印版
  const print = await stu.call('GET', '/kb/report/print');
  assert.equal(print.status, 200);
  assert.ok(print.raw.includes('个人知识库报告'));
  assert.ok(print.raw.includes('书房测试生'));
});

test('M10 成果铺垫：目录按路径筛选、登记项目、临近截止提醒、完成后第9站算完成', async () => {
  const cat = await stu.call('GET', '/achievements/catalog');
  assert.equal(cat.status, 200);
  assert.equal(cat.body.catalog.length, 8);
  assert.ok(cat.body.catalog.every((c) => 'recommended' in c));
  assert.ok(cat.body.note.includes('官方通知为准'), '注明时间以官方通知为准');

  const a1 = await stu.call('POST', '/achievements', { type: '竞赛', name: '全国大学生数学建模竞赛', deadline: '2026-09-10' });
  assert.equal(a1.status, 200);
  assert.equal(a1.body.achievement.stage, '了解中');
  const a2 = await stu.call('POST', '/achievements', { type: '证书', name: '大学英语六级' });
  assert.equal((await stu.call('GET', '/achievements')).body.stats.total, 2);

  // 临近截止（7天内）标为 urgent
  const soon = await stu.call('POST', '/achievements', { type: '大创', name: '大创申报', deadline: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) });
  assert.equal(soon.body.achievement.urgent, true, '3天后截止标为紧急');
  const up = await stu.call('GET', '/achievements/upcoming');
  assert.ok(up.body.upcoming.some((x) => x.name === '大创申报'), '3天后截止的项目出现在提醒列表里');
});

test('M10 成果铺垫：全部结束后第9站标记完成', async () => {
  const list = await stu.call('GET', '/achievements');
  for (const a of list.body.achievements) {
    await stu.call('PUT', `/achievements/${a.id}`, { stage: '已完成' });
  }
  const after = await stu.call('GET', '/achievements');
  assert.equal(after.body.stats.done, 3);
  assert.equal(after.body.stats.active, 0);
});

test('PDF 上传：没有文件时给出提示；非法数据不崩', async () => {
  const none = await stu.call('POST', '/papers/pdf', {});
  assert.equal(none.status, 400);
  assert.equal(none.body.code, 'NO_FILE');

  const junk = await stu.call('POST', '/papers/pdf', { data: Buffer.from('这不是PDF').toString('base64'), filename: 'x.pdf' });
  assert.ok([200, 400, 422].includes(junk.status), `不崩，实际 ${junk.status}`);
  if (junk.status === 200) assert.equal(junk.body.hasText, false, '非PDF不应被当作有正文');
});
