// 内置模拟模型：没有真实 API Key 时用于开发与自测。
// 对话回复固定以“【模拟回复】”开头；结构化输出按提示词里的【输出类型】标记返回对应形状。
// 界面同时显示“模拟模型”标记，避免与真实模型输出混淆。
import { AppError, MSG } from '../errors.js';
import { addDays, todayLocal } from '../time.js';

function checkKey(key, source) {
  const k = String(key || '');
  const own = source === 'user' || source === 'demo';
  if (k.includes('invalid')) throw new AppError(401, own ? 'USER_KEY_INVALID' : 'PLATFORM_FAILED', own ? MSG.USER_KEY_INVALID : MSG.PLATFORM_FAILED);
  if (k.includes('nobalance')) throw new AppError(402, own ? 'USER_NO_BALANCE' : 'PLATFORM_FAILED', own ? MSG.USER_NO_BALANCE : MSG.PLATFORM_FAILED);
}

export async function mockModels(key, source) {
  checkKey(key, source);
  return ['mock-chat', 'mock-reasoner'];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从提示词里读出本次要生成的结构化类型与关键输入 */
function readMeta(system, user) {
  const kind = (system.match(/【输出类型】([a-z_]+)/) || [])[1] || 'chat';
  const pick = (label, text = system) => (text.match(new RegExp(`【${label}】([^\n]*)`)) || [])[1] || '';
  return { kind, system, user, pick };
}

function jsonFor(kind, meta) {
  const weeklyHours = Number((meta.system.match(/每周可投入[^\d\n]{0,8}(\d+)/) || [])[1] || 25);
  if (kind === 'profile') {
    return {
      summary: '【模拟】这位同学目前方向还不确定，时间投入中等，英语基础一般，尚未有竞赛或科研经历，最需要的是先把方向想清楚再谈执行。',
      motivation: '希望毕业后有更好的平台和选择空间',
      strengths: ['愿意花时间', '对学习方法有兴趣'],
      gaps: ['方向不明确', '英语还没过六级', '没有成果铺垫经历'],
      weekly_hours: weeklyHours,
      interests: ['专业课中的实践部分', '用AI提高效率'],
      career_goal: '尚未确定',
      risk_style: '均衡',
      existing_achievements: [],
      unknowns: ['是否一定要读研', '能否坚持长期计划'],
      paths: [
        { id: 'kaoyan', name: '考研', fit: '你自己提到“想有个更好的平台”，考研是最直接的换平台方式', cost: '需要一年以上的持续投入，英语和数学是最容易掉队的两科', milestones: ['本学期末定下院校范围', '寒假前完成第一轮公共课', '大三下确定报考院校与专业', '暑假进入强化阶段', '9月完成报名'], achievements: ['参加一次学科竞赛', '读5篇本专业文献'], ai_leverage: '整理信息、解释概念、帮你把计划拆到每天', first_step: '本周把专业课参考书翻一遍目录，标出最陌生的两章' },
        { id: 'job', name: '就业', fit: '你对“用AI提高效率”有兴趣，这类能力在企业里很吃香', cost: '需要尽早实习，作品和实践经历比成绩更被看重', milestones: ['本学期做出一个能展示的小作品', '暑假找一份实习', '大三下确定目标行业', '秋招前完成简历与作品集'], achievements: ['大创或双创竞赛一项', '一份实习证明'], ai_leverage: '帮你梳理岗位要求、模拟面试、整理项目经历', first_step: '这周去找一位学长问问他现在的岗位每天做什么' },
        { id: 'gongkao', name: '考公选调', fit: '你提到过家里希望你稳定', cost: '考试科目与专业课关联不大，需要另外花时间准备', milestones: ['本学期了解本省选调条件', '大三下开始行测申论', '关注岗位表发布时间', '毕业当年报名'], achievements: ['学生工作经历', '一次社会实践'], ai_leverage: '帮你整理政策文件、做题目分类', first_step: '先查一次本省选调的报名条件，看看自己够不够' },
        { id: 'baoyan', name: '保研', fit: '如果成绩排名靠前，这条路的机会成本最低', cost: '需要前几年成绩和综合表现都靠前，现在起步略晚', milestones: ['本学期把绩点拉上去', '争取一次竞赛或论文', '大三下关注保研夏令营', '9月拿到推免资格'], achievements: ['学科竞赛获奖', '跟老师做一段科研'], ai_leverage: '帮你了解保研条件、准备材料框架', first_step: '去教务系统查一下自己现在的排名' }
      ],
      compare_dims: ['兴趣', '可行性', '回报', '风险', '时间'],
      socratic_question: '如果三年后发现这条路走不通，你的B计划是什么？',
    };
  }
  if (kind === 'school_candidates') {
    return {
      type: 'school_candidates',
      candidates: [
        { school: '【模拟·示例】某西部双一流高校', major: `${meta.pick('目标专业', meta.system) || '计算机科学与技术'}（以招生目录为准）`, tier: '冲刺', reason: '专业实力强，但近年报录比较高', facts: [
          { item: '考试科目', value: '待核实', source: '', url: '', level: 'AI推断' },
          { item: '复试线', value: '待核实', source: '', url: '', level: 'AI推断' },
        ] },
        { school: '【模拟·示例】某省属重点高校', major: '与本专业一致的招生方向', tier: '稳妥', reason: '地域符合你的偏好，招生规模较大', facts: [
          { item: '考试科目', value: '待核实', source: '', url: '', level: 'AI推断' },
          { item: '参考书目', value: '待核实', source: '', url: '', level: 'AI推断' },
        ] },
        { school: '【模拟·示例】某地方本科院校', major: '与本专业一致的招生方向', tier: '保底', reason: '竞争相对温和，适合作为兜底', facts: [
          { item: '招生人数', value: '待核实', source: '', url: '', level: 'AI推断' },
        ] },
      ],
      note: '【模拟数据】以上均未接入真实检索，所有数字都是“待核实”，请到研招网和招生单位官网核对。',
    };
  }
  if (kind === 'plan') {
    // 与 plan.js 的 dailyCapMinutes 一致：每天总时长不超过 每周小时 ÷ 7 × 1.2
    const cap = Math.floor((weeklyHours * 72) / 7);
    const reduce = /【减量标记】有/.test(meta.system) ? 0.7 : 1;
    const budget = Math.floor(cap * 0.9 * reduce);
    const extraMin = Math.min(15, Math.floor(budget * 0.2));
    const startDate = meta.pick('开始日期') || todayLocal();
    const week = [];
    for (let i = 0; i < 7; i += 1) {
      const date = addDays(startDate, i);
      const hasExtra = i === 2 || i === 4;
      const main = budget - (hasExtra ? extraMin : 0);
      const tasks = i === 6
        ? [
          { title: '做本周复盘并写下调整', kind: '复盘', minutes: Math.floor(budget * 0.4) },
          { title: '读一篇本专业文献并做阅读卡', kind: '阅读', minutes: Math.floor(budget * 0.6) },
        ]
        : [
          { title: '背并复习一组英语单词', kind: '英语', minutes: Math.floor(main * 0.45) },
          { title: '整理一章专业课知识清单', kind: '专业课', minutes: Math.floor(main * 0.55) },
          ...(i === 2 ? [{ title: '了解一个大创或竞赛的报名时间', kind: '成果', minutes: extraMin }] : []),
          ...(i === 4 ? [{ title: '练习一次向AI提问并核验答案', kind: 'AI技能', minutes: extraMin }] : []),
        ];
      week.push({ date, tasks });
    }
    return {
      goal: '【模拟】先把方向定下来，同时不让英语和专业课掉队',
      phases: [
        { name: '打基础', range: '第1—4周', focus: '养成固定学习习惯，英语词汇与专业课第一轮', milestone: '能连续打卡14天' },
        { name: '定方向', range: '第5—8周', focus: '完成路径选择与院校初筛', milestone: '比较表里有3所以上已核验的院校' },
        { name: '提强度', range: '第9—16周', focus: '公共课进入练习—纠错循环', milestone: '英语阅读正确率稳定在70%以上' },
      ],
      week,
      achievements: [{ type: '竞赛', name: '了解一个学科竞赛的报名窗口', when: '以官方通知为准', why: '成果铺垫越早越好', ai_help: '帮你查规则、梳理时间表' }],
      buffer_rule: '每周留出一天机动，用来补没完成的任务；连续两周完成率低于60%就减量',
      check_rule: '每周日看完成率：低于60%下周减量30%；高于90%且状态好，可以小幅加量',
    };
  }
  if (kind === 'weekly_summary') {
    return { summary: '【模拟】本周整体按计划推进，英语完成度较好，专业课有一次没跟上。', rate: 0.72 };
  }
  if (kind === 'memory') {
    // 只回一条，避免模拟模型把测试数据灌满
    const lastLine = (meta.user.match(/^学生：(.+)$/m) || [])[1] || '';
    const line = lastLine.replace(/【选择】[A-Z]：/g, '').slice(0, 40);
    if (!line) return { add: [], remove_ids: [] };
    return { add: [{ content: `【模拟】学生说过：${line}`, category: '其他' }], remove_ids: [] };
  }
  if (kind === 'research_topics') {
    // 分类导师的模拟输出：主题树 + 标签 + 研究空白。
    // paper_id 从系统提示词的文献清单里按 id=N 抓，模拟模型也不编造编号。
    const ids = [...meta.system.matchAll(/id=(\d+)/g)].map((m) => Number(m[1]));
    const half = Math.max(1, Math.ceil(ids.length / 2));
    const g1 = ids.slice(0, half);
    const g2 = ids.slice(half);
    const topics = [
      { name: '【模拟】主题A', parent: null, desc: '【模拟数据】把读过的文献按研究主题聚在一起。', paper_ids: g1 },
    ];
    if (g2.length) topics.push({ name: '【模拟】主题B', parent: null, desc: '【模拟数据】第二个主题。', paper_ids: g2 });
    return {
      topics,
      tags: ids.map((id) => ({ paper_id: id, tags: ['【模拟】待学生自己确认'] })),
      gaps: g1.length ? [{ desc: '【模拟数据】这批文献里还没看到对某个场景的实证研究（仅示例，需学生自己核对）。', evidence_ids: g1.slice(0, 2) }] : [],
    };
  }
  if (kind === 'mentor_distill') {
    // 按反馈明细里出现最多的原因标签给一条规律与一条建议
    const tags = [...meta.system.matchAll(/原因：([^｜\n]+)/g)].map((m) => m[1].trim()).filter(Boolean);
    const count = {};
    for (const t of tags) count[t] = (count[t] || 0) + 1;
    const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    if (!top) return { patterns: [], proposals: [], eval_questions: [] };
    return {
      patterns: [{ issue: `【模拟】学生反复反映“${top[0]}”`, evidence_count: top[1], examples: [] }],
      proposals: [{ type: '新增负面清单', change: `【模拟】不要${top[0].replace(/^太/, '过于')}；先肯定学生做到的部分，再指出差距`, reason: `${top[1]} 条反馈都提到“${top[0]}”`, risk: '可能让督促力度变弱' }],
      eval_questions: ['【模拟】我今天又没完成计划，怎么办？'],
    };
  }
  if (kind === 'interview_host') {
    // 第一位在场考官（列表里第一个 key=）提问；有待重练的题就点名抽它
    const keys = [...meta.system.matchAll(/key=([a-z_]+)/g)].map((m) => m[1]);
    const stage = (meta.system.match(/【当前环节】([^（\n]+)/) || [])[1] || '';
    const pick = stage.includes('英文') ? (keys.find((k) => k === 'examiner_english') || keys[0]) : stage.includes('专业') ? (keys.find((k) => k === 'examiner_major') || keys[0]) : keys[0];
    const retry = (meta.system.match(/【题库里待重练的问题（可优先抽取）】\n- ([^\n]+)/) || [])[1];
    return { next_examiner: pick, intent: '新问题', hint: retry ? `优先重练：${retry}` : `【模拟】围绕“${stage}”提一个问题` };
  }
  if (kind === 'interview_review') {
    const keys = [...new Set([...meta.system.matchAll(/key=([a-z_]+)/g)].map((m) => m[1]))];
    const qs = [...meta.system.matchAll(/考官（[^）]+）问：([^\n]+)/g)].map((m) => m[1]);
    return {
      examiners: keys.map((k) => ({ key: k, scores: { 观点: 3, 依据: 2, 例证: 2, 回应: 3 }, reasons: { 观点: '【模拟】观点明确', 依据: '【模拟】缺少具体依据', 例证: '【模拟】没有举例', 回应: '【模拟】能接住追问' }, best_moment: '【模拟】自我介绍', worst_question: qs[0] || '' })),
      english: { 清晰度: 0, 流畅度: 0, 词汇: 0, comment: '本次没有英文环节' },
      top3: ['【模拟】回答先给结论', '【模拟】每个观点配一个例子', '【模拟】提前准备研究兴趣的说法'],
      retry_questions: qs.slice(0, 2),
    };
  }
  if (kind === 'twin_profile') {
    // 只按提示词里真实出现的来源出条目——关掉的来源不会出现，用来检验来源开关
    const has = (tag) => meta.system.includes(`【来源：${tag}`);
    const up = (meta.system.match(/【来源：上传:([^】]+)】/) || [])[1];
    const p = { basics: [], goals: [], motivation: [], strengths: [], gaps: [], habits: [], expression_style: [], values: [], known_difficulties: [], open_questions: ['【模拟】你最想通过读研解决的问题是什么？'] };
    if (has('访谈')) {
      p.basics.push({ text: '【模拟】大二，正在考虑考研', source: '访谈', confidence: '原话' });
      p.goals.push({ text: '【模拟】想读本专业相关的专硕', source: '画像', confidence: '原话' });
      p.gaps.push({ text: '【模拟】英语基础一般', source: '画像', confidence: '数据' });
    }
    if (has('路径')) p.motivation.push({ text: '【模拟】选择考研是为了换一个更好的平台', source: '路径', confidence: '原话' });
    if (has('打卡')) p.habits.push({ text: '【模拟】最近两周打卡比较规律', source: '打卡', confidence: '数据' });
    if (has('记忆')) p.known_difficulties.push({ text: '【模拟】担心专业课背不下来', source: '记忆', confidence: '原话' });
    if (up) p.expression_style.push({ text: '【模拟】表达偏简短，先说结论', source: `上传:${up}`, confidence: '推测' });
    return p;
  }
  return null;
}

export async function mockStream({ key, source, model, messages, onDelta, jsonMode = false }) {
  checkKey(key, source);
  const system = messages.find((m) => m.role === 'system')?.content || '';
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const meta = readMeta(system, lastUser);

  let full;
  if (!jsonMode && meta.kind === 'interview_ask') {
    const hint = (system.match(/问题方向：([^\n]+)/) || [])[1] || '';
    full = hint.startsWith('优先重练：') ? hint.replace('优先重练：', '') : `【模拟问题】请谈谈你对${(system.match(/当前环节：([^；\n]+)/) || [])[1] || '这个问题'}的理解？`;
  } else if (!jsonMode && meta.kind === 'twin_speak') {
    const task = (system.match(/当前任务：([^\n]+)/) || [])[1] || '';
    full = `【分身推测】【模拟回复】按我的档案，${task.includes('未来') ? '想象中的未来里，我会说当时坚持每天背单词这件小事做对了（这是想象，不是承诺）。' : '这周我大概完成了一部分计划，但具体数字我（分身）不确定，需要本人回答。'}`;
  } else if (jsonMode) {
    const data = jsonFor(meta.kind, meta);
    full = data ? JSON.stringify(data, null, 2) : JSON.stringify({ note: '【模拟】这里没有对应的模拟数据。' });
  } else {
    const mentor = (system.match(/【当前导师】([^\n]+)/) || [])[1] || 'AI导师';
    const turns = messages.filter((m) => m.role === 'user').length;
    const picked = lastUser.match(/【选择】([A-Z])：(.+)$/);
    const echo = picked ? `你选了“${picked[2].trim()}”。` : `你说的是：“${lastUser.slice(0, 40)}${lastUser.length > 40 ? '…' : ''}”。`;
    const body = [
      `【模拟回复】我是${mentor}（模拟模型，尚未接入真实接口）。`,
      '',
      `${echo}这是第 ${turns} 轮对话，用来检查“回应 + 一个追问 + 选项”的流程是否正常。`,
      '',
      '**追问**：今天你最想先推进哪一件事？',
      ...(system.includes('【资料片段') ? ['', `【模拟】根据老师上传的资料：${(system.match(/\[资料1\]《([^》]+)》/) || [])[1] || ''}里有相关规定。[资料1]`] : []),
    ].join('\n');
    const block = {
      options: [
        { key: 'A', label: '先把今天的学习任务理一理' },
        { key: 'B', label: '聊聊最近卡住的地方', hint: '可以是学习，也可以是状态' },
        { key: 'C', label: '还没想好' },
        { key: 'D', label: '都不是，我自己说' },
      ],
      multi: false,
      free_text: true,
      stage_done: false,
      artifact: null,
    };
    full = `${body}\n\n\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\``;
  }

  // jsonMode 时保持整块返回；对话时逐段流式输出
  const step = jsonMode ? Math.max(8, Math.ceil(full.length / 12)) : 8;
  for (let i = 0; i < full.length; i += step) {
    onDelta?.(full.slice(i, i + step));
    await sleep(jsonMode ? 4 : 12);
  }
  const promptChars = messages.reduce((n, m) => n + String(m.content).length, 0);
  return {
    content: full,
    usage: { prompt_tokens: Math.ceil(promptChars / 1.5), completion_tokens: Math.ceil(full.length / 1.5) },
    model: model || 'mock-chat',
  };
}
