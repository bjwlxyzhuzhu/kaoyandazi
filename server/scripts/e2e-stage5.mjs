// 端到端演练（阶段5）：书房——检索 → 核验 → 阅读卡 → 导入 → 分类 → 选题 → 导出 → 边界拦截
// 运行：先启动 node server/src/index.js，再执行 node server/scripts/e2e-stage5.mjs
// 检索与核验走真实 OpenAlex / Crossref / doi.org；分类与对话走真实模型（需要学生自己的 Key）
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
  if (type.includes('application/zip')) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* 非 JSON（如 bib） */ }
  return { status: res.status, data, raw };
}
const must = async (m, p, b, h) => {
  const r = await call(m, p, b, h);
  if (r.status >= 400) throw new Error(`${m} ${p} → ${r.status} ${r.data?.error || r.raw?.slice(0, 120) || ''}`);
  return r;
};
function events(text) {
  return text.trim().split('\n\n').filter(Boolean).map((c) => ({
    ev: c.match(/^event: (.+)$/m)?.[1],
    data: JSON.parse(c.match(/^data: (.+)$/m)?.[1] || 'null'),
  }));
}
const step = (s) => console.log(`✔ ${s}`);

const sno = `res${Date.now().toString().slice(-6)}`;
const K = process.env.USER_KEY;
const HK = K ? { 'X-User-Key': K } : {};

await must('POST', '/register', { invite_code: process.env.INVITE || 'SHANHAI2026', student_no: sno, name: '书房演练', email: `${sno}@example.com`, major: '教育技术学', grade: '大三', major_group: '教育', password: 'e2e-pass-001' });
for (const [p, b] of [['/prepare/consent', { agreed: true }], ['/prepare/modules-read', {}]]) await must('POST', p, b);
const sv = (await must('GET', '/surveys/pre')).data;
const ans = {};
for (const it of sv.items) ans[it.key] = it.type === 'scale' ? 3 : it.options[1];
await must('POST', '/surveys/pre', { answers: ans });
await must('PUT', '/me', { persona: 'gentle', email_remind: false });
step(`注册 ${sno} 并完成出发准备`);

// ---------- 1. 真实检索 ----------
console.log('\n== 1. 关键词检索（真实 OpenAlex）==');
const search = await must('POST', '/papers/search', { query: process.env.Q || '生成式人工智能 教育评价', limit: 8 });
step(`关键词「${search.data.query}」共 ${search.data.total} 条，返回 ${search.data.works.length} 条`);
for (const w of search.data.works.slice(0, 5)) {
  console.log(`   · ${w.title}\n     ${w.authors.slice(0, 2).join('、')}｜${w.year || '年份不详'}｜${w.venue || '来源未标注'}${w.doi ? `｜DOI ${w.doi}` : ''}`);
}
if (search.data.zh_coverage_low) console.log('   （平台已提示中文覆盖不足，应引导去知网检索后导出）');

// ---------- 2. 加入知识库 + 核验 ----------
console.log('\n== 2. 加入知识库并核验 ==');
const added = [];
for (const w of search.data.works.slice(0, 2)) {
  const r = await must('POST', '/papers', {
    title: w.title, authors: w.authors, year: w.year, venue: w.venue, doi: w.doi,
    url: w.url, abstract: w.abstract, lang: w.lang, source: 'openalex',
  });
  if (!r.data.duplicated) added.push(r.data.paper);
}
step(`加入 ${added.length} 篇（其中 ${search.data.works.slice(0, 2).length - added.length} 篇已存在）`);

for (const p of added) {
  const v = (await must('POST', `/papers/${p.id}/verify`, {})).data;
  console.log(`   ${v.result.status === 'verified' ? '✅' : v.result.status === 'failed' ? '❌' : '⚠️'} ${p.title.slice(0, 50)}`);
  console.log(`      ${v.result.reason}`);
}

// 假 DOI 必须判失败
const fake = (await must('POST', '/papers', { title: '一篇故意编造的文献', doi: '10.9999/fake.2026.001' })).data.paper;
const fv = (await must('POST', `/papers/${fake.id}/verify`, {})).data;
step(`编造 DOI → ${fv.result.status}${fv.result.status === 'failed' ? '（正确拦下）' : '（⚠ 应判失败）'}`);

// ---------- 3. 导入知网 RIS ----------
console.log('\n== 3. 导入知网导出的 RIS ==');
const ris = [
  'TY  - JOUR', 'TI  - 智能体协同的教育应用研究', 'AU  - 王芳', 'PY  - 2023',
  'JO  - 开放教育研究', 'DO  - 10.13966/j.cnki.kfjyyj.2023.01.001', 'ER  -', '',
  'TY  - JOUR', 'TI  - 教育数字化转型的路径与风险', 'AU  - 张三', 'PY  - 2023',
  'JO  - 电化教育研究', 'ER  -',
].join('\n');
const imp = (await must('POST', '/kb/import', { text: ris, filename: 'cnki.ris' })).data;
step(`识别为 ${imp.format}：新增 ${imp.imported} 条，重复 ${imp.duplicated} 条`);
for (const t of imp.report.ok || []) console.log(`   + ${t}`);
const imp2 = (await must('POST', '/kb/import', { text: ris, filename: 'cnki.ris' })).data;
step(`再导一次：新增 ${imp2.imported}，重复 ${imp2.duplicated}（应为 0 / 2）`);

// ---------- 4. 分类（真实模型）----------
console.log('\n== 4. 织理分类（真实模型）==');
if (!K) {
  console.log('   （未设置 USER_KEY，跳过需要学生 Key 的部分）');
} else {
  const sug = (await must('POST', '/topics/suggest', { granularity: '细', basis: '主题' }, HK)).data;
  step(`主题 ${sug.topics.length} 个、标签 ${sug.tags.length} 组、研究空白 ${sug.gaps.length} 条`);
  for (const t of sug.topics) console.log(`   · ${t.parent ? '└ ' : ''}${t.name}（${t.paper_ids.length} 篇）—— ${t.desc}`);
  for (const g of sug.gaps) console.log(`   ␣ 空白：${g.desc}（依据 ${g.evidence_ids.join('、')}）`);

  const all = (await must('GET', '/papers')).data.papers.map((p) => p.id);
  const invented = sug.topics.flatMap((t) => t.paper_ids).filter((id) => !all.includes(id));
  step(invented.length ? `⚠ 编造了不存在的编号：${invented.join('、')}` : '所有 paper_id 都真实存在（服务端已过滤）');

  if (sug.topics.length) {
    const ap = (await must('POST', '/topics/apply', {
      topics: sug.topics.map((t) => ({ name: t.name, parent: t.parent, desc: t.desc, paper_ids: t.paper_ids })),
      tags: sug.tags,
    })).data;
    step(`确认落库：${ap.topics} 个主题，${ap.tagged} 篇文献归位`);
  }
}

// ---------- 5. 阅读助手的对话与阅读卡 ----------
console.log('\n== 5. 照卷精读（真实模型）==');
if (K && added.length) {
  await must('POST', '/menus/research_read', { answers: { purpose: '学方法', source: '知识库中选' } });
  const r = events((await must('POST', '/conv/research_read/send', {
    text: '这篇我看完了，作者用的方法我大概明白，但不太确定它为什么这么设计。',
  }, HK)).text);
  const body = r.filter((e) => e.ev === 'delta').map((e) => e.data.text).join('');
  const done = r.find((e) => e.ev === 'done');
  console.log(`   照卷说：${body.replace(/\n+/g, ' ').slice(0, 260)}…`);
  const opts = done?.data?.message?.options?.options || [];
  step(`给出 ${opts.length} 个选项：${opts.map((o) => o.label).join(' / ')}`);

  // 学生自己写一张卡（“我的判断”只能学生写）
  const card = (await must('POST', '/cards', {
    paper_id: added[0].id,
    question: '多智能体评估比单一模型更可靠吗？',
    method: '比较研究',
    evidence: '文中给出与专家评分的一致性系数',
    conclusion: '细分维度上更接近专家判断',
    limitation: '样本只来自一所学校',
    my_judgment: '我认为关键不在智能体数量，而在评估维度是否拆得足够细。',
    doubts: ['没有报告置信区间'],
    minutes: 50,
  })).data.card;
  step(`阅读卡已保存（id=${card.id}），阅读时长 50 分钟已记录`);
}

// ---------- 6. 选题 ----------
console.log('\n== 6. 问枢收敛选题（真实模型）==');
if (K) {
  await must('POST', '/menus/research_topic', { answers: { purpose: '复试陈述', resources: ['数据', '时间'] } });
  const r = events((await must('POST', '/conv/research_topic/send', {
    text: '我想做多智能体评估和单一模型的比较，但我手上的数据只有一门课的作业。',
  }, HK)).text);
  const body = r.filter((e) => e.ev === 'delta').map((e) => e.data.text).join('');
  console.log(`   问枢说：${body.replace(/\n+/g, ' ').slice(0, 260)}…`);

  const idea = (await must('POST', '/ideas', {
    question: '多智能体评估在多大程度上优于单一模型？——基于一门课作业文本的探索性研究',
    significance: '为一门课的教师是否值得引入多智能体评估提供依据',
    feasibility: '手上有 60 份作业文本，一学期能完成',
    method: '同一批文本，两种评估模式与教师评分比对',
    risks: '样本量小，只能做探索性结论',
    paper_ids: added.map((p) => p.id),
  })).data.idea;
  step(`选题卡已保存（id=${idea.id}），状态 ${idea.status}`);
}

// ---------- 7. 导出 ----------
console.log('\n== 7. 导出 ==');
const bib = await must('GET', '/kb/export?format=bib');
step(`BibTeX ${bib.raw.length} 字，含 ${(bib.raw.match(/@article\{/g) || []).length} 条`);
const md = await must('GET', '/kb/export?format=md');
step(`阅读卡 ZIP ${md.buffer.length} 字节（Content-Type: ${md.status === 200 ? 'zip' : '?'}）`);
const json = (await must('GET', '/kb/export?format=json')).raw;
const backup = JSON.parse(json);
step(`JSON 备份：文献 ${backup.papers.length} 篇、阅读卡 ${backup.cards.length} 张、主题 ${backup.topics.length} 个、选题 ${backup.topic_ideas.length} 张`);

// ---------- 8. 边界拦截 ----------
console.log('\n== 8. 科研边界拦截（不调用模型）==');
if (K) {
  const countCalls = async () => {
    const u = (await must('GET', '/me/usage')).data;
    return (u.by_module || []).reduce((n, r) => n + r.calls, 0);
  };
  const before = await countCalls();
  const r = events((await must('POST', '/conv/research_read/send', { text: '帮我写一篇综述，就写生成式人工智能与教育评价' }, HK)).text);
  const done = r.find((e) => e.ev === 'done');
  step(`被拦下：${done?.data?.boundary || '（未标记）'}；回复：${(done?.data?.message?.content || '').slice(0, 120)}…`);
  const after = await countCalls();
  step(`学生 Key 的模型调用次数 ${before} → ${after}（被拦下的请求不应增加）`);
}

// ---------- 9. 报告 ----------
console.log('\n== 9. 知识库报告 ==');
const rep = (await must('GET', '/kb/report')).data;
step(`文献 ${rep.counts.papers}（已核验 ${rep.counts.papers_verified}）、阅读卡 ${rep.counts.cards}、主题 ${rep.counts.topics}、选题 ${rep.counts.ideas}、阅读 ${rep.counts.reading_minutes} 分钟`);

console.log(`\n测试学号（演练后请删除）：${sno}`);
