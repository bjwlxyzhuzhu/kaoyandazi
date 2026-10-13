// 真实接口连通检查：拿到中转站地址/平台 Key、博查 Key 后运行一次。
// 运行：node server/scripts/check-live.mjs
// 读取 .env；也会读取教师后台保存的配置（后台优先）。只打印脱敏后的 Key。
process.env.NODE_ENV ||= 'development';

const { getLlmConfig } = await import('../src/llm/settings.js');
const { listModels, streamChat } = await import('../src/llm/client.js');
const { webSearch, fetchUrl, searchProvider } = await import('../src/search/tools.js');
const { maskKey } = await import('../src/crypto.js');
const { parseJsonLoose } = await import('../src/llm/json.js');

let failed = 0;
const ok = (m) => console.log(`✔ ${m}`);
const bad = (m, e) => { failed += 1; console.log(`✖ ${m}：${e?.message || e}`); };

// ---------- 模型 ----------
const llm = getLlmConfig();
console.log(`\n【模型】接口地址：${llm.baseUrl || '（未配置）'}；平台 Key：${llm.platformKey ? maskKey(llm.platformKey) : '（未配置）'}；对话模型：${llm.chatModel}；推理模型：${llm.reasonModel || '（未配置）'}`);
if (llm.mock) {
  console.log('  当前是模拟模型（mock），跳过真实模型检查。请在 .env 或教师后台填入真实地址和平台 Key。');
} else if (!llm.baseUrl || !llm.platformKey) {
  bad('模型配置', '接口地址或平台 Key 为空');
} else {
  try {
    const models = await listModels({ baseUrl: llm.baseUrl, key: llm.platformKey, source: 'platform' });
    ok(`模型列表：共 ${models.length} 个，${models.includes(llm.chatModel) ? '包含' : '【不包含】'}对话模型 ${llm.chatModel}`);
  } catch (e) { bad('模型列表', e); }

  try {
    let n = 0;
    const out = await streamChat({
      baseUrl: llm.baseUrl, key: llm.platformKey, model: llm.chatModel, source: 'platform', maxTokens: 300,
      messages: [
        { role: 'system', content: '你是学业规划导师。先用一句话回应，再问一个问题，最后输出 ```json {"options":[{"key":"A","label":"..."},{"key":"B","label":"..."}],"multi":false,"free_text":true} ``` 代码块。' },
        { role: 'user', content: '我在考研和就业之间犹豫。' },
      ],
      onDelta: () => { n += 1; },
    });
    ok(`流式对话：收到 ${n} 段增量，用量 ${out.usage?.prompt_tokens}+${out.usage?.completion_tokens} token${out.usage?.estimated ? '（估算）' : ''}`);
    console.log(`  ${out.content.slice(0, 120).replace(/\n/g, ' ')}…`);
    if (!/```json/.test(out.content)) console.log('  ⚠ 这次回复没有带选项代码块，界面会只显示正文和输入框（属于可降级情况）。');
  } catch (e) { bad('流式对话', e); }

  const jsonModel = llm.reasonModel || llm.chatModel;
  try {
    const out = await streamChat({
      baseUrl: llm.baseUrl, key: llm.platformKey, model: jsonModel, source: 'platform', maxTokens: 400, jsonMode: true,
      messages: [
        { role: 'system', content: '只输出 JSON：{"summary":"","paths":[{"id":"","name":""}]}' },
        { role: 'user', content: '为一位想当中学语文老师的大二学生给出3条路径。' },
      ],
    });
    const data = parseJsonLoose(out.content);
    if (data?.paths?.length) ok(`结构化 JSON（${jsonModel}，json_object 模式）：解析成功，${data.paths.length} 条路径`);
    else bad(`结构化 JSON（${jsonModel}）`, `无法解析：${out.content.slice(0, 80)}`);
  } catch (e) { bad(`结构化 JSON（${jsonModel}）`, e); }
}

// ---------- 检索 ----------
console.log(`\n【检索】服务：${searchProvider()}`);
if (searchProvider() === 'none') {
  console.log('  未启用。申请到博查 Key 后在 .env 设置 SEARCH_PROVIDER=bocha 和 BOCHA_API_KEY。');
} else {
  try {
    const hits = await webSearch('2027年全国硕士研究生招生考试 网上报名 公告', { count: 5 });
    ok(`检索返回 ${hits.length} 条`);
    for (const h of hits) console.log(`  [${h.level}] ${h.title.slice(0, 40)}  ${h.url}`);
    if (!hits.length) bad('检索结果', '返回为空');
  } catch (e) { bad('检索', e); }
}

try {
  const page = await fetchUrl('https://yz.chsi.com.cn/');
  ok(`读取官网页面：${page.title || '（无标题）'}，正文 ${page.text.length} 字，等级 ${page.level}`);
} catch (e) { bad('读取官网页面（研招网）', e); }

console.log(failed ? `\n有 ${failed} 项未通过。` : '\n全部通过。');
process.exit(failed ? 1 : 0);
