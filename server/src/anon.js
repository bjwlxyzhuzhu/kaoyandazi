// 匿名演示模式（PRD M17，赛事双盲）：开启后，接口返回、导出文件、邮件里的学校名、学院名、教师姓名、学生姓名
// 全部替换为中性占位（“某地方本科院校”“教师A”“学生001”）。录制演示视频、截图时开启。
import { db, getSetting, getSettingJson } from './db.js';

export function anonEnabled() {
  return getSetting('anon.enabled') === '1';
}

/** 机构信息：教师在后台填写，用于打印版抬头；匿名模式下全部被替换 */
export function orgInfo() {
  return getSettingJson('org', { school_name: '', college_name: '', teacher_names: '', extra_terms: '' });
}

const splitList = (s) => String(s || '').split(/[,，、\s\n]+/).map((x) => x.trim()).filter(Boolean);
const hasCJK = (s) => /[一-龥]/.test(s);
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let cache = { at: 0, pairs: [] };

/** 替换表：长的先替换，避免“宝鸡文理学院”被“宝鸡”先替换掉一半 */
export function anonPairs() {
  if (Date.now() - cache.at < 5000) return cache.pairs;
  const org = orgInfo();
  const pairs = [];
  const push = (real, fake) => { if (real && real.length >= 2 && !pairs.some((p) => p[0] === real)) pairs.push([real, fake]); };
  push(org.school_name, '某地方本科院校');
  push(org.college_name, '某学院');
  splitList(org.extra_terms).forEach((t) => push(t, '某地'));
  splitList(org.teacher_names).forEach((t, i) => push(t, `教师${String.fromCharCode(65 + (i % 26))}`));
  // 教师账号显示名只在含中文时替换：英文登录名（如 teacher）会和接口路径、字段名撞车
  db.prepare("SELECT name FROM users WHERE role = 'teacher' ORDER BY id").all().forEach((t, i) => { if (hasCJK(t.name)) push(t.name, `教师${String.fromCharCode(65 + ((i + splitList(org.teacher_names).length) % 26))}`); });
  db.prepare("SELECT id, name, student_no FROM users WHERE role = 'student' ORDER BY id").all().forEach((s, i) => {
    const tag = `学生${String(i + 1).padStart(3, '0')}`;
    push(s.name, tag);
    if (/^\d{6,}$/.test(s.student_no)) push(s.student_no, `${tag}学号`);
  });
  db.prepare('SELECT name FROM classes').all().forEach((c, i) => { if (hasCJK(c.name) && !/默认班级|评委沙箱/.test(c.name)) push(c.name, `班级${i + 1}`); });
  pairs.sort((a, b) => b[0].length - a[0].length);
  const compiled = pairs.map(([real, fake]) => [/^\d+$/.test(real) ? new RegExp(`(?<!\\d)${reEsc(real)}(?!\\d)`, 'g') : new RegExp(reEsc(real), 'g'), fake]);
  cache = { at: Date.now(), pairs: compiled };
  return compiled;
}

export function resetAnonCache() { cache = { at: 0, pairs: [] }; }

export function anonText(text) {
  if (!anonEnabled() || text == null) return text;
  let s = String(text);
  for (const [re, fake] of anonPairs()) s = s.replace(re, fake);
  return s;
}

/** Express 中间件：改写 JSON、文本类响应与 SSE 流 */
export function anonMiddleware(req, res, next) {
  if (!anonEnabled()) return next();
  const json = res.json.bind(res);
  const send = res.send.bind(res);
  const write = res.write.bind(res);
  res.json = (body) => {
    res.type('application/json');
    return send(anonText(JSON.stringify(body)));
  };
  res.send = (body) => {
    const type = String(res.get('Content-Type') || '');
    if (typeof body === 'string' && (!type || /json|text|html|csv|markdown|xml/.test(type))) return send(anonText(body));
    return send(body);
  };
  res.write = (chunk, ...rest) => {
    const type = String(res.get('Content-Type') || '');
    if (type.includes('event-stream') && (typeof chunk === 'string' || Buffer.isBuffer(chunk))) return write(anonText(chunk.toString()), ...rest);
    return write(chunk, ...rest);
  };
  void json;
  next();
}
