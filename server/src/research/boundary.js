// 科研边界拦截（PRD M11 硬约束）
// 平台不做论文写作、续写、润色、改写、翻译成稿、排版、查重降重、投稿、期刊推荐。
// 提示词里已经写死，这里再加一道服务端检查：命中就在调用模型之前拦下，别浪费学生的 token。
import { AppError } from '../errors.js';

/** 明确属于“本平台不做”的请求 */
const BLOCKED = [
  { re: /(帮|替我|给我|请)?\s*(写|撰写|起草|生成)\s*(一篇|一份|个)?\s*(综述|文献综述|论文|小论文|开题报告|毕业设计|研究计划书|文献回顾)/, kind: '写作', hint: '写综述或论文' },
  { re: /(帮|替我|给我|请)?\s*(润色|打磨|改写|重写|扩写|续写|仿写|降重|查重)/, kind: '润色改写', hint: '润色、改写或降重' },
  { re: /(翻译成|译成|翻译为)\s*(英文|中文|英语|日语)?\s*(稿|全文|成稿|版本)?/, kind: '翻译成稿', hint: '翻译成稿' },
  { re: /(投|发)\s*(到)?\s*(哪个|什么|哪家)?\s*(期刊|刊物|会议|学报)/, kind: '投稿建议', hint: '推荐投稿期刊' },
  { re: /(推荐|选)\s*(一个|个)?\s*(期刊|刊物|投稿)/, kind: '投稿建议', hint: '推荐期刊' },
  { re: /(帮我|替我|给我)?\s*(排版|格式化成|做成|排成|整理成)\s*成?\s*(论文|正式|规范)/, kind: '排版', hint: '论文排版' },
  { re: /(论文|文章|稿件)\s*(排版|格式)/, kind: '排版', hint: '论文排版' },
  { re: /(代写|枪手|包过|包发表|包获奖|保证录用)/, kind: '学术不端', hint: '代写或包发表' },
];

/**
 * 检查一段学生输入是否触碰科研边界。
 * 返回 null 表示没问题；命中返回 { kind, hint, reply, options }。
 * reply 是给学生看的礼貌拒绝（不调用模型，直接返回）。
 */
export function checkResearchBoundary(text) {
  const t = String(text || '');
  if (!t.trim()) return null;
  for (const rule of BLOCKED) {
    if (rule.re.test(t)) {
      return {
        kind: rule.kind,
        hint: rule.hint,
        // 学术不端类要说得更重一些
        reply: rule.kind === '学术不端'
          ? '这件事我不能帮：代写、代投和"包获奖"这类服务既违反学术规范，也常常是骗局（收了钱就失联）。你的课程材料必须是你自己写的。不过我可以陪你把想法理清楚——你想从哪一步开始？'
          : `我不做${rule.hint}，这是这门课给平台划的边界（平台只负责检索、阅读、分类、选题和知识管理）。${optsFor(rule.kind)}`,
        options: optionsFor(rule.kind),
      };
    }
  }
  return null;
}

function optsFor(kind) {
  switch (kind) {
    case '写作':
      return '不过我可以帮你把读过的文献理成结构，剩下的字你自己写。';
    case '润色改写':
      return '不过我可以指出哪些句子读起来费解，由你自己改。';
    case '翻译成稿':
      return '不过我可以帮你读懂某一段英文在说什么。';
    case '投稿建议':
      return '不过我可以帮你判断一篇文献的研究方法是否扎实。';
    case '排版':
      return '不过我可以帮你把提纲理顺。';
    default:
      return '';
  }
}

function optionsFor(kind) {
  const common = [
    { key: 'A', label: '回到阅读：带我精读一篇文献' },
    { key: 'B', label: '继续打磨我的研究问题' },
    { key: 'C', label: '帮我梳理已读文献的主题结构' },
  ];
  if (kind === '写作') {
    return [
      { key: 'A', label: '帮我理一份提纲（我自己写正文）' },
      { key: 'B', label: '回到阅读：带我精读一篇文献' },
      { key: 'C', label: '继续打磨我的研究问题' },
      { key: 'D', label: '我有别的想法，我自己说' },
    ];
  }
  return [...common, { key: 'D', label: '我有别的想法，我自己说' }];
}

/** 抛成接口错误时用的中文提示 */
export function boundaryError(hit) {
  return new AppError(403, 'OUT_OF_SCOPE', hit.reply, { boundary: hit.kind, options: hit.options });
}
