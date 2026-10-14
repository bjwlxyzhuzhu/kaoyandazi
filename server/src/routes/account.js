// M1 账号：注册、登录、退出、个人信息
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, getSetting } from '../db.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword, maskKey, decrypt } from '../crypto.js';
import { nowLocal } from '../time.js';
import { AppError } from '../errors.js';
import { setSession, clearSession, requireLogin, rateLimit } from '../auth.js';
import { resolvePersona, companions } from '../registry.js';
import { exportUserData, purgeUsers } from '../userdata.js';

export const GRADES = ['大一', '大二', '大三', '大四', '其他'];
export const MAJOR_GROUPS = ['理工', '经管', '文史', '艺术', '教育', '其他'];

const r = Router();
// 全班常在同一校园出口 IP 下同时注册，按 IP 的上限要留足余量
const authLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 300 });
const accountLimit = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, key: (req) => `login:${String(req.body?.student_no || '').trim()}` });

const str = (v, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** 面向前端的用户信息：不包含密码哈希与任何完整 Key */
export function publicMe(u) {
  const cls = u.class_id ? db.prepare('SELECT id, name, is_sandbox FROM classes WHERE id = ?').get(u.class_id) : null;
  const savedKey = u.key_enc ? decrypt(u.key_enc) : '';
  return {
    id: u.id,
    role: u.role,
    student_no: u.role === 'teacher' ? u.student_no.replace(/^t:/, '') : u.student_no,
    name: u.name,
    email: u.email,
    major: u.major,
    major_group: u.major_group,
    grade: u.grade,
    persona: u.role === 'student' ? resolvePersona(u.persona) : null,
    email_remind: !!u.email_remind,
    remind_hour: u.remind_hour,
    consent_at: u.consent_at,
    is_demo: !!u.is_demo,
    expires_at: u.is_demo ? u.expires_at || null : null,
    class: cls ? { id: cls.id, name: cls.name, is_sandbox: !!cls.is_sandbox } : null,
    key_saved_on_server: !!savedKey,
    key_mask: savedKey ? maskKey(savedKey) : '',
    use_own_key_basic: !!u.use_own_key_basic,
    prepare_done: u.role === 'student' ? prepareDone(u) : true,
  };
}

/** M1 出发准备是否走完：读须知、认识模块、填前测、选人设 */
function prepareDone(u) {
  if (!u.consent_at || !u.persona) return false;
  if (!getSetting(`prepare.modules_read.${u.id}`)) return false;
  const pre = db.prepare("SELECT id FROM surveys WHERE user_id = ? AND kind = 'pre' LIMIT 1").get(u.id);
  return !!pre;
}

r.post('/register', authLimit, (req, res) => {
  const b = req.body || {};
  const invite = str(b.invite_code, 32);
  const studentNo = str(b.student_no, 32);
  const name = str(b.name, 40);
  const email = str(b.email, 100);
  const major = str(b.major, 60);
  const grade = str(b.grade, 10);
  const majorGroup = str(b.major_group, 10);
  const password = typeof b.password === 'string' ? b.password : '';

  const cls = invite ? db.prepare('SELECT * FROM classes WHERE invite_code = ? COLLATE NOCASE').get(invite) : null;
  if (!cls) throw new AppError(400, 'BAD_INVITE', '邀请码不正确，请向老师确认。');
  if (cls.is_sandbox) throw new AppError(400, 'SANDBOX', '评委测试账号由老师在后台生成，不能自己注册。');
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(studentNo)) throw new AppError(400, 'BAD_STUDENT_NO', '学号只能包含字母、数字、下划线或短横线，长度3—32位。');
  if (!name) throw new AppError(400, 'BAD_NAME', '请填写姓名。');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'BAD_EMAIL', '请填写正确的邮箱（推荐QQ邮箱）。');
  if (!major) throw new AppError(400, 'BAD_MAJOR', '请填写专业。');
  if (!GRADES.includes(grade)) throw new AppError(400, 'BAD_GRADE', '请选择年级。');
  if (!MAJOR_GROUPS.includes(majorGroup)) throw new AppError(400, 'BAD_MAJOR_GROUP', '请选择专业大类。');
  if (password.length < 8) throw new AppError(400, 'BAD_PASSWORD', '密码至少8位。');
  if (db.prepare('SELECT 1 FROM users WHERE student_no = ?').get(studentNo)) {
    throw new AppError(409, 'DUP_STUDENT_NO', '这个学号已经注册过了，请直接登录。');
  }

  const now = nowLocal();
  const info = db.prepare(`INSERT INTO users(role, student_no, name, email, major, major_group, grade, pw_hash, persona, is_demo, created_at, last_seen, class_id)
    VALUES('student', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    studentNo, name, email, major, majorGroup, grade, hashPassword(password), resolvePersona(b.persona),
    cls.is_sandbox ? 1 : 0, now, now, cls.id,
  );
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  setSession(res, user.id);
  res.json({ me: publicMe(user) });
});

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

r.post('/login', authLimit, accountLimit, (req, res) => {
  const b = req.body || {};
  const account = str(b.student_no, 64);
  const password = typeof b.password === 'string' ? b.password : '';
  if (!account || !password) throw new AppError(400, 'BAD_LOGIN', '请输入学号和密码。');

  // 教师账号来自环境变量 TEACHER_ACCOUNTS
  const t = config.teacherAccounts.find((a) => a.username === account);
  if (t) {
    // 允许 TEACHER_ACCOUNTS 里写 scrypt 哈希（scrypt:盐:哈希），公开仓库与镜像里就不必出现明文密码
    const okPw = /^scrypt[:$]/.test(t.password)
      ? verifyPassword(password, t.password.replace(/:/g, '$'))
      : safeEqual(t.password, password);
    if (!okPw) throw new AppError(401, 'BAD_LOGIN', '账号或密码不正确。');
    const sno = `t:${t.username}`;
    let user = db.prepare('SELECT * FROM users WHERE student_no = ?').get(sno);
    if (!user) {
      const now = nowLocal();
      const info = db.prepare(`INSERT INTO users(role, student_no, name, pw_hash, created_at, last_seen)
        VALUES('teacher', ?, ?, ?, ?, ?)`).run(sno, t.username, hashPassword(crypto.randomBytes(16).toString('hex')), now, now);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }
    setSession(res, user.id);
    return res.json({ me: publicMe(user) });
  }

  const user = db.prepare("SELECT * FROM users WHERE student_no = ? AND role = 'student'").get(account);
  if (!user || !verifyPassword(password, user.pw_hash)) throw new AppError(401, 'BAD_LOGIN', '学号或密码不正确。');
  if (user.is_demo && user.expires_at && user.expires_at < nowLocal()) throw new AppError(403, 'DEMO_EXPIRED', '这个评委测试账号已经过期，请联系老师重新生成。');
  setSession(res, user.id);
  res.json({ me: publicMe(user) });
});

r.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

r.get('/me', requireLogin, (req, res) => {
  res.json({ me: publicMe(req.user) });
});

r.put('/me', requireLogin, (req, res) => {
  const b = req.body || {};
  const u = req.user;
  const fields = {};
  if (u.role === 'student' && typeof b.persona === 'string') {
    if (!companions.some((c) => c.key === b.persona)) throw new AppError(400, 'BAD_PERSONA', '没有这位陪伴导师。');
    fields.persona = b.persona;
  }
  if (typeof b.email_remind === 'boolean') fields.email_remind = b.email_remind ? 1 : 0;
  if (b.remind_hour !== undefined) {
    const h = Number(b.remind_hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new AppError(400, 'BAD_HOUR', '提醒时间应为0—23点。');
    fields.remind_hour = h;
  }
  const keys = Object.keys(fields);
  if (keys.length) {
    db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), u.id);
  }
  res.json({ me: publicMe(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) });
});

/** 导出我的全部数据（JSON），不含密码哈希与加密保存的 Key */
r.get('/me/export', requireLogin, (req, res) => {
  if (req.user.role !== 'student') throw new AppError(403, 'FORBIDDEN', '教师账号没有可导出的学习数据。');
  const data = { exported_at: nowLocal(), app: '山海问知', note: '这是你在平台上的全部数据，只包含你自己的。', ...exportUserData(req.user.id) };
  res.set({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`山海问知-我的数据-${nowLocal().slice(0, 10)}`)}.json` });
  res.send(JSON.stringify(data, null, 1));
});

/** 注销：需要再输一次密码；删除账号与全部学习数据，不可恢复 */
r.delete('/me', requireLogin, (req, res) => {
  const u = req.user;
  if (u.role !== 'student') throw new AppError(403, 'FORBIDDEN', '教师账号来自环境变量配置，不能在这里注销。');
  if (!verifyPassword(String(req.body?.password || ''), u.pw_hash)) throw new AppError(400, 'BAD_PASSWORD', '密码不对，没有注销。');
  if (req.body?.confirm !== '注销账号') throw new AppError(400, 'NEED_CONFIRM', '注销不可恢复。请在确认框里输入“注销账号”。');
  const counts = purgeUsers([u.id]);
  clearSession(res);
  res.json({ ok: true, deleted: counts });
});

export default r;
