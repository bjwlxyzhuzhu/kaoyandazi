// M19 数字分身：知情同意、数据来源、上传遮盖、档案生成与锁定、发言提示词（PRD M19、7.8、附录B.15）
// 分身档案是结构化 JSON，不是自由聊天人格；分身发言只依据档案，所有产出都是草稿。
import { db } from './db.js';
import { nowLocal, todayLocal, addDays } from './time.js';
import { AppError } from './errors.js';
import { renderPrompt, userBrief } from './prompts.js';
import { extractPdfText } from './research/pdf.js';
import { readZip } from './research/zip.js';
import { decodeText } from './research/formats.js';

export const DEFAULT_NAME = '镜中我';
export const ICONS = ['mirror', 'ridge', 'river', 'cloud', 'compass', 'spark'];

/** 数据来源（PRD M19 建立分身第2步），默认全部开启，可逐项关闭 */
export const SOURCES = [
  { key: 'profile', label: '入学访谈与画像' },
  { key: 'path', label: '路径与理由' },
  { key: 'checkin', label: '打卡与复盘' },
  { key: 'memory', label: '长期记忆' },
  { key: 'research', label: '阅读卡与选题卡' },
  { key: 'interview', label: '复试模拟记录' },
  { key: 'meeting', label: '会议纪要' },
];

/** 档案的九个类别（附录B.15） */
export const SECTIONS = [
  { key: 'basics', label: '基本面' },
  { key: 'goals', label: '目标' },
  { key: 'motivation', label: '动机' },
  { key: 'strengths', label: '优势' },
  { key: 'gaps', label: '短板' },
  { key: 'habits', label: '学习习惯' },
  { key: 'expression_style', label: '表达风格' },
  { key: 'values', label: '价值观与偏好' },
  { key: 'known_difficulties', label: '已知困难' },
];
const SECTION_KEYS = SECTIONS.map((s) => s.key);
export const MAX_PER_SECTION = 6;
export const CONFIDENCES = ['原话', '数据', '推测'];

export const PURPOSES = {
  meeting: '参加周复盘会',
  rehearsal: '复试彩排',
  future: '扮演“已经达成目标的未来的我”',
};

// ---------- 敏感信息遮盖（正则；PRD 7.8：正则 + 模型复核，模型复核在路由层可选） ----------

const REDACT_RULES = [
  { type: '身份证号', re: /(?<!\d)\d{17}[\dXx](?!\d)|(?<!\d)\d{15}(?!\d)/g, mask: '[已遮盖：身份证号]' },
  { type: '手机号', re: /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d[-\s]?\d{4}[-\s]?\d{4}(?!\d)/g, mask: '[已遮盖：手机号]' },
  { type: '固定电话', re: /(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g, mask: '[已遮盖：电话]' },
  { type: '邮箱', re: /[\w.+-]+@[\w-]+(\.[\w-]+)+/g, mask: '[已遮盖：邮箱]' },
  { type: '银行卡号', re: /(?<!\d)\d{16,19}(?!\d)/g, mask: '[已遮盖：卡号]' },
  // 住址：省/市/区/县/路/街/号/小区/栋/单元/室 组合成的一串
  { type: '住址', re: /(?:[一-龥]{2,}(?:省|市|自治区))?[一-龥]{1,}(?:市|区|县)[一-龥\d]{0,20}(?:路|街|巷|道|村|镇)[一-龥\d-]{0,12}(?:号|弄|小区|栋|幢|单元|室)[一-龥\d-]{0,12}/g, mask: '[已遮盖：住址]' },
  { type: '住址', re: /(?:家庭住址|家住|住址|现住)\s*[:：]?\s*[^\n，。；,;]{2,40}/g, mask: '[已遮盖：住址]' },
  // 家庭经济：一整句话遮掉
  { type: '家庭经济', re: /[^\n。；;]*(?:家庭(?:年|月)?收入|月收入|年收入|低保|建档立卡|贫困生|助学贷款|家里(?:很)?穷|欠债)[^\n。；;]*/g, mask: '[已遮盖：家庭经济信息]' },
  // 健康：一整句话遮掉
  { type: '健康信息', re: /[^\n。；;]*(?:确诊|病历|诊断为|抑郁症|焦虑症|精神科|住院|服药|吃药|心理咨询记录)[^\n。；;]*/g, mask: '[已遮盖：健康信息]' },
];

/**
 * 遮盖敏感信息。返回 { text, log }，log 只记类型和次数，不记原文（原文不进库）。
 */
export function redact(text) {
  let out = String(text || '');
  const counts = {};
  for (const rule of REDACT_RULES) {
    out = out.replace(rule.re, (m) => {
      if (/^\[已遮盖/.test(m.trim())) return m;
      counts[rule.type] = (counts[rule.type] || 0) + 1;
      return rule.mask;
    });
  }
  const log = Object.entries(counts).map(([type, count]) => ({ type, count }));
  return { text: out, log };
}

/** 档案条目里不许出现的敏感推断（附录B.15：不推断健康、家庭经济、宗教、政治倾向） */
const PROFILE_FORBIDDEN = /身份证|手机|电话|住址|家住|家庭.{0,4}(?:经济|收入|条件)|经济困难|收入|贫困|低保|助学贷款|抑郁|焦虑症|确诊|病|服药|宗教|信仰|党派|政治倾向|\[已遮盖/;

/** 学生手动补充或修改的档案条目：命中敏感规则、或遮盖后与原文不同（说明里面有隐私），都不收 */
export function isProfileSensitive(text) {
  const t = String(text || '');
  return PROFILE_FORBIDDEN.test(t) || redact(t).log.length > 0;
}

// ---------- 上传文件解析 ----------

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MAX_CHARS = 20000;
export const UPLOAD_KINDS = ['简历', '自我介绍', '学习日志', '成绩概况', '获奖与项目', '课程论文片段', '其他'];

/** .docx 是 ZIP 里的 word/document.xml，取 <w:t> 文本、按段落 <w:p> 换行 */
function docxText(buf) {
  let files;
  try { files = readZip(buf); } catch { throw new AppError(400, 'BAD_FILE', '这个 Word 文件读不出来，可能已损坏。可以另存为 .docx 或 .txt 再传。'); }
  const doc = files.find((f) => f.name === 'word/document.xml');
  if (!doc || typeof doc.data !== 'string') throw new AppError(400, 'BAD_FILE', '这个 Word 文件里没有找到正文。');
  return doc.data
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 解析上传文件，返回纯文本。支持 PDF、Word（.docx）、TXT、Markdown。
 * 图片需要视觉模型做 OCR，中转站目前没有可用的视觉模型，按 PRD 7.8 提示学生改传文本。
 */
export async function parseUpload(buf, filename) {
  const name = String(filename || '').toLowerCase();
  if (!buf?.length) throw new AppError(400, 'NO_FILE', '没有收到文件。');
  if (buf.length > UPLOAD_MAX_BYTES) throw new AppError(413, 'TOO_LARGE', '文件超过10MB，请拆开或只传需要的部分。');
  if (/\.(png|jpe?g|gif|webp|bmp|heic)$/.test(name)) {
    throw new AppError(415, 'NEED_TEXT', '图片需要文字识别（OCR），平台目前接入的模型不支持识图。请把图片里的文字复制成 TXT，或另存为 PDF 再传。');
  }
  if (/\.doc$/.test(name)) throw new AppError(415, 'OLD_DOC', '这是旧版 Word（.doc）格式，请在 Word 里“另存为 .docx”再上传。');
  let text = '';
  if (/\.pdf$/.test(name) || buf.slice(0, 4).toString('latin1') === '%PDF') {
    const out = await extractPdfText(buf);
    if (!out.hasText) throw new AppError(422, 'NO_TEXT', '这个 PDF 里没有可提取的文字（可能是扫描件）。请改传文字版或 TXT。');
    text = out.text;
  } else if (/\.docx$/.test(name) || buf.slice(0, 2).toString('latin1') === 'PK') {
    text = docxText(buf);
  } else if (/\.(txt|md|markdown)$/.test(name) || !name.includes('.')) {
    text = decodeText(buf);
  } else {
    throw new AppError(415, 'BAD_TYPE', '支持 PDF、Word（.docx）、TXT、Markdown。');
  }
  text = text.replace(/\r\n/g, '\n').trim();
  if (!text) throw new AppError(422, 'NO_TEXT', '文件里没有读出文字。');
  return text.slice(0, UPLOAD_MAX_CHARS);
}

// ---------- 分身读写 ----------

export function getTwinRow(userId) {
  return db.prepare('SELECT * FROM twins WHERE user_id = ?').get(userId) || null;
}

function parse(json, fallback) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

export function sourcesOf(row) {
  const saved = parse(row?.sources_json, {});
  const out = {};
  for (const s of SOURCES) out[s.key] = saved[s.key] !== false;
  return out;
}

export function emptyProfile() {
  const p = {};
  for (const k of SECTION_KEYS) p[k] = [];
  p.open_questions = [];
  return p;
}

/** 给每条档案一个稳定 id（类别 + 序号），锁定与校正都靠它 */
function withIds(profile) {
  const p = emptyProfile();
  for (const k of SECTION_KEYS) {
    p[k] = (profile?.[k] || []).map((it, i) => ({
      id: it.id || `${k}-${i + 1}-${Math.random().toString(36).slice(2, 6)}`,
      text: String(it.text || '').slice(0, 200),
      source: String(it.source || '').slice(0, 40),
      confidence: CONFIDENCES.includes(it.confidence) ? it.confidence : '推测',
      confirmed: !!it.confirmed,
      locked: !!it.locked,
    }));
  }
  p.open_questions = (profile?.open_questions || []).map((q) => String(q).slice(0, 120)).slice(0, 6);
  return p;
}

export function publicTwin(row) {
  if (!row) return { exists: false, consented: false };
  const profile = withIds(parse(row.profile_json, emptyProfile()));
  return {
    exists: true,
    consented: !!row.consent_at,
    consent_at: row.consent_at,
    name: row.name || DEFAULT_NAME,
    icon: row.icon || 'mirror',
    sources: sourcesOf(row),
    profile,
    built: !!row.profile_json,
    version: row.version || 0,
    updated_at: row.updated_at,
  };
}

export function requireConsent(userId) {
  const row = getTwinRow(userId);
  if (!row?.consent_at) throw new AppError(403, 'NEED_CONSENT', '请先阅读并勾选数字分身的知情同意，才能建立分身。');
  return row;
}

export function saveProfile(userId, profile, { bump = true } = {}) {
  db.prepare(`UPDATE twins SET profile_json = ?, version = version + ?, updated_at = ? WHERE user_id = ?`)
    .run(JSON.stringify(profile), bump ? 1 : 0, nowLocal(), userId);
}

// ---------- 数据来源摘要（只取学生开启的来源） ----------

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * 按学生开启的数据来源拼出“分身整理器”能看到的资料。
 * 关掉的来源一个字都不进提示词——这是 16.2 第3条“关闭打卡与复盘后档案里不出现打卡条目”的保证。
 */
export function sourceMaterials(userId, sources) {
  const parts = [];
  const used = [];

  if (sources.profile) {
    const p = db.prepare('SELECT profile_json FROM profiles WHERE user_id = ?').get(userId);
    const prof = parse(p?.profile_json, null);
    const menu = db.prepare("SELECT answers_json FROM menu_answers WHERE user_id = ? AND flow = 'intake' ORDER BY id DESC LIMIT 1").get(userId);
    const lines = [];
    if (menu) lines.push(`入学访谈菜单：${clip(menu.answers_json, 400)}`);
    if (prof) {
      lines.push(`画像摘要：${clip(prof.summary, 300)}`);
      if (prof.motivation) lines.push(`动机：${clip(prof.motivation, 150)}`);
      if (prof.strengths?.length) lines.push(`优势：${prof.strengths.join('、')}`);
      if (prof.gaps?.length) lines.push(`短板：${prof.gaps.join('、')}`);
      if (prof.interests?.length) lines.push(`兴趣：${prof.interests.join('、')}`);
      if (prof.career_goal) lines.push(`职业目标：${clip(prof.career_goal, 100)}`);
    }
    const intake = db.prepare(`SELECT m.content FROM messages m JOIN conversations c ON c.id = m.conv_id
      WHERE c.user_id = ? AND c.kind = 'intake' AND m.role = 'user' ORDER BY m.id DESC LIMIT 8`).all(userId);
    if (intake.length) lines.push(`访谈里学生的原话：\n${intake.reverse().map((m) => `  “${clip(m.content.replace(/【选择】[A-Z]：/g, ''), 120)}”`).join('\n')}`);
    if (lines.length) { parts.push(`【来源：访谈/画像】\n${lines.join('\n')}`); used.push('profile'); }
  }

  if (sources.path) {
    const p = db.prepare('SELECT chosen_path, choice_reason FROM profiles WHERE user_id = ?').get(userId);
    if (p?.chosen_path) {
      parts.push(`【来源：路径】\n已选路径：${p.chosen_path}\n学生写的理由：“${clip(p.choice_reason, 300)}”`);
      used.push('path');
    }
  }

  if (sources.checkin) {
    const rows = db.prepare('SELECT date, minutes, done_count, total_count, mood, reflection FROM checkins WHERE user_id = ? ORDER BY date DESC LIMIT 14').all(userId);
    const reviews = db.prepare('SELECT week_start, rate, blockers_json, adjust_json, summary FROM weekly_reviews WHERE user_id = ? ORDER BY id DESC LIMIT 4').all(userId);
    if (rows.length || reviews.length) {
      const lines = rows.map((c) => `  ${c.date}：完成 ${c.done_count}/${c.total_count}，${c.minutes}分钟，状态${c.mood}，复盘“${clip(c.reflection, 60)}”`);
      for (const r of reviews) lines.push(`  周复盘（${r.week_start}）：完成率${Math.round((r.rate || 0) * 100)}%，卡点 ${clip(r.blockers_json, 60)}，“${clip(r.summary, 60)}”`);
      parts.push(`【来源：打卡】\n${lines.join('\n')}`);
      used.push('checkin');
    }
  }

  if (sources.memory) {
    const rows = db.prepare('SELECT content, category FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(userId);
    if (rows.length) { parts.push(`【来源：记忆】\n${rows.map((m) => `  [${m.category}] ${clip(m.content, 100)}`).join('\n')}`); used.push('memory'); }
  }

  if (sources.research) {
    const cards = db.prepare('SELECT question, my_judgment FROM reading_cards WHERE user_id = ? ORDER BY id DESC LIMIT 6').all(userId);
    const ideas = db.prepare('SELECT question, status FROM topic_ideas WHERE user_id = ? ORDER BY id DESC LIMIT 4').all(userId);
    const lines = [
      ...cards.map((c) => `  阅读卡：${clip(c.question, 80)}${c.my_judgment ? `｜学生自己的判断：“${clip(c.my_judgment, 100)}”` : ''}`),
      ...ideas.map((i) => `  选题卡（${i.status}）：${clip(i.question, 100)}`),
    ];
    if (lines.length) { parts.push(`【来源：阅读卡】\n${lines.join('\n')}`); used.push('research'); }
  }

  if (sources.interview) {
    const rows = db.prepare('SELECT self_review, created_at FROM mock_interviews WHERE user_id = ? AND self_review IS NOT NULL ORDER BY id DESC LIMIT 3').all(userId);
    if (rows.length) { parts.push(`【来源：复试模拟】\n${rows.map((r) => `  自评：“${clip(r.self_review, 150)}”`).join('\n')}`); used.push('interview'); }
  }

  if (sources.meeting) {
    const rows = db.prepare("SELECT mode, summary_json FROM group_sessions WHERE user_id = ? AND status = 'closed' AND summary_json IS NOT NULL ORDER BY id DESC LIMIT 4").all(userId);
    const lines = rows.map((r) => {
      const s = parse(r.summary_json, {});
      return `  ${r.mode}：要点 ${(s.points || []).slice(0, 3).map((x) => clip(x, 60)).join('；')}｜学生的决定：${clip(s.decision, 60)}`;
    });
    if (lines.length) { parts.push(`【来源：会议】\n${lines.join('\n')}`); used.push('meeting'); }
  }

  // 已确认的上传资料（已遮盖），按 PRD 只用于学习表达风格与经历
  const uploads = db.prepare('SELECT filename, kind, text_redacted FROM twin_uploads WHERE user_id = ? AND confirmed = 1 ORDER BY id DESC LIMIT 5').all(userId);
  for (const u of uploads) {
    parts.push(`【来源：上传:${u.filename}】（类型：${u.kind}${u.kind === '课程论文片段' ? '，只用于学习表达风格，不要提取观点' : ''}）\n${String(u.text_redacted).slice(0, 3000)}`);
  }
  if (uploads.length) used.push('upload');

  return { text: parts.join('\n\n') || '（学生开启的数据来源里暂时还没有内容）', used, uploads: uploads.map((u) => u.filename) };
}

/** 打卡相关的来源标签与关键词——关掉“打卡与复盘”时，模型如果仍写了这类条目，服务端再过滤一次 */
const CHECKIN_HINT = /打卡|复盘|连续.{0,4}天|完成率/;

/**
 * 校验并规范化模型生成的档案：
 *  - 每条必须有 source 与 confidence；source 只能是本次实际提供的来源
 *  - 每类最多 6 条；“推测”不超过总数的三分之一
 *  - 删掉含敏感推断的条目
 */
export function normalizeGenerated(data, { used, uploads, sources }) {
  const allowedSource = (s) => {
    const v = String(s || '');
    if (/^上传[:：]/.test(v)) return uploads.some((f) => v.includes(f)) || uploads.length > 0;
    const map = { 访谈: 'profile', 画像: 'profile', 路径: 'path', 打卡: 'checkin', 记忆: 'memory', 阅读卡: 'research', 选题卡: 'research', 复试: 'interview', 会议: 'meeting' };
    const hit = Object.entries(map).find(([k]) => v.includes(k));
    return hit ? used.includes(hit[1]) : false;
  };
  const p = emptyProfile();
  for (const k of SECTION_KEYS) {
    p[k] = (Array.isArray(data?.[k]) ? data[k] : [])
      .filter((it) => it && typeof it.text === 'string' && it.text.trim())
      .filter((it) => it.source && it.confidence)
      .filter((it) => allowedSource(it.source))
      .filter((it) => !PROFILE_FORBIDDEN.test(it.text))
      .filter((it) => sources.checkin || !(CHECKIN_HINT.test(it.text) || /打卡/.test(it.source)))
      .slice(0, MAX_PER_SECTION)
      .map((it) => ({ text: it.text.trim(), source: it.source, confidence: CONFIDENCES.includes(it.confidence) ? it.confidence : '推测' }));
  }
  // “推测”不超过总数的三分之一：多出来的推测条目从后往前删
  const all = SECTION_KEYS.flatMap((k) => p[k].map((it) => ({ k, it })));
  let guesses = all.filter((x) => x.it.confidence === '推测');
  const limit = Math.floor(all.length / 3);
  while (guesses.length > limit && guesses.length) {
    const last = guesses.pop();
    p[last.k] = p[last.k].filter((it) => it !== last.it);
  }
  p.open_questions = (Array.isArray(data?.open_questions) ? data.open_questions : []).map((q) => String(q)).filter(Boolean).slice(0, 6);
  return p;
}

/**
 * 重新生成时合并：已锁定的条目原样保留（不被覆盖），已确认但未锁定的会被新结果替换。
 * 学生手动校正过的条目会被标记为 confirmed，同样保留——除非学生没锁定且新数据里有了不同说法。
 */
export function mergeWithLocked(oldProfile, fresh) {
  const old = withIds(oldProfile);
  const next = withIds(fresh);
  for (const k of SECTION_KEYS) {
    const locked = old[k].filter((it) => it.locked);
    const lockedTexts = new Set(locked.map((it) => it.text));
    const rest = next[k].filter((it) => !lockedTexts.has(it.text));
    next[k] = [...locked, ...rest].slice(0, Math.max(MAX_PER_SECTION, locked.length));
  }
  return next;
}

export function profileText(profile, { includeGuesses = true } = {}) {
  const p = withIds(profile);
  const lines = [];
  for (const s of SECTIONS) {
    const items = p[s.key].filter((it) => includeGuesses || it.confidence !== '推测');
    if (!items.length) continue;
    lines.push(`${s.label}：`);
    for (const it of items) lines.push(`  - ${it.text}（来源：${it.source}；可信度：${it.confidence}${it.confirmed || it.locked ? '；本人已确认' : ''}）`);
  }
  if (p.open_questions.length) lines.push(`还不知道的事：${p.open_questions.join('；')}`);
  return lines.join('\n') || '（档案还是空的）';
}

/** 分身发言的系统提示词（附录B.15 分身发言） */
export function twinSpeakPrompt(user, row, purpose, extra = '') {
  const t = publicTwin(row);
  return renderPrompt('twin_speak', {
    ...userBrief(user),
    分身名: t.name,
    当前任务: PURPOSES[purpose] || PURPOSES.meeting,
    分身档案: profileText(t.profile),
    任务补充: extra || '（无）',
  });
}

// ---------- 每周更新建议（规则拼装，不调用模型） ----------

/** 自上次生成以来新增的数据量；超过阈值时在分身页提示“有新数据，可以更新” */
export function updateSuggestion(userId) {
  const row = getTwinRow(userId);
  if (!row?.profile_json || !row.updated_at) return null;
  const since = row.updated_at;
  const s = sourcesOf(row);
  const counts = [];
  const count = (sql) => db.prepare(sql).get(userId, since).n;
  if (s.checkin) { const n = count('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ? AND date > substr(?, 1, 10)'); if (n) counts.push(`${n} 次打卡`); }
  if (s.memory) { const n = count('SELECT COUNT(*) AS n FROM memories WHERE user_id = ? AND created_at > ?'); if (n) counts.push(`${n} 条记忆`); }
  if (s.research) { const n = count('SELECT COUNT(*) AS n FROM reading_cards WHERE user_id = ? AND created_at > ?'); if (n) counts.push(`${n} 张阅读卡`); }
  if (s.meeting) { const n = count("SELECT COUNT(*) AS n FROM group_sessions WHERE user_id = ? AND closed_at > ?"); if (n) counts.push(`${n} 场会议`); }
  if (!counts.length) return null;
  const stale = since.slice(0, 10) <= addDays(todayLocal(), -7);
  return {
    text: `自上次整理（${since.slice(0, 10)}）以来，新增了 ${counts.join('、')}。可以让分身重新整理一次，锁定的条目不会被改动。`,
    weekly: stale,
  };
}

// ---------- 删除 ----------

/** 一键删除：档案、上传文件（文本只存在数据库里，没有落盘文件）、校正记录、分身对话；会议里分身的发言也删掉 */
export function deleteTwin(userId) {
  const counts = {};
  db.exec('BEGIN');
  try {
    counts.uploads = db.prepare('DELETE FROM twin_uploads WHERE user_id = ?').run(userId).changes;
    counts.corrections = db.prepare('DELETE FROM twin_corrections WHERE user_id = ?').run(userId).changes;
    counts.conversations = db.prepare('DELETE FROM twin_conversations WHERE user_id = ?').run(userId).changes;
    counts.meeting_speeches = db.prepare(`DELETE FROM group_messages WHERE speaker_type = 'twin'
      AND session_id IN (SELECT id FROM group_sessions WHERE user_id = ?)`).run(userId).changes;
    db.prepare('UPDATE group_sessions SET twin_joined = 0 WHERE user_id = ?').run(userId);
    db.prepare('UPDATE mock_interviews SET twin_rehearsal_json = NULL WHERE user_id = ?').run(userId);
    counts.twin = db.prepare('DELETE FROM twins WHERE user_id = ?').run(userId).changes;
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return counts;
}
