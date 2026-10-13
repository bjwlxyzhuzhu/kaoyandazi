// 会话与鉴权：签名的 HttpOnly Cookie，有效期30天（PRD M1）
import { db } from './db.js';
import { sign, unsign } from './crypto.js';
import { config } from './config.js';
import { nowLocal } from './time.js';
import { AppError } from './errors.js';

export const COOKIE = 'swz_sid';
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSession(res, userId) {
  const exp = Date.now() + MAX_AGE_MS;
  res.cookie(COOKIE, sign(`${userId}:${exp}`), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: MAX_AGE_MS,
    path: '/',
  });
}

export function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

/** 解析会话，挂到 req.user（未登录则为 null） */
export function sessionMiddleware(req, _res, next) {
  req.user = null;
  const raw = parseCookies(req.headers.cookie)[COOKIE];
  const value = raw && unsign(raw);
  if (value) {
    const [uid, exp] = value.split(':').map(Number);
    if (uid && exp > Date.now()) {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uid);
      // 评委测试账号过了有效期就当作未登录（PRD M17：测试账号可设有效期）
      const expired = user?.is_demo && user.expires_at && user.expires_at < nowLocal();
      if (user && !expired) {
        req.user = user;
        // 最多每5分钟更新一次 last_seen
        const now = nowLocal();
        if (!user.last_seen || user.last_seen.slice(0, 15) !== now.slice(0, 15)) {
          db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(now, uid);
        }
      }
    }
  }
  next();
}

export function requireLogin(req, _res, next) {
  if (!req.user) return next(new AppError(401, 'NOT_LOGGED_IN', '请先登录。'));
  next();
}

export function requireStudent(req, _res, next) {
  if (!req.user) return next(new AppError(401, 'NOT_LOGGED_IN', '请先登录。'));
  if (req.user.role !== 'student') return next(new AppError(403, 'FORBIDDEN', '这个页面只对学生开放。'));
  next();
}

export function requireTeacher(req, _res, next) {
  if (!req.user) return next(new AppError(401, 'NOT_LOGGED_IN', '请先登录。'));
  if (req.user.role !== 'teacher') return next(new AppError(403, 'FORBIDDEN', '没有权限访问教师功能。'));
  next();
}

// ---------- 简易限流（登录、注册、模型调用） ----------
export function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, _res, next) => {
    const k = key(req);
    const now = Date.now();
    let h = hits.get(k);
    if (!h || h.reset < now) {
      h = { n: 0, reset: now + windowMs };
      hits.set(k, h);
    }
    h.n += 1;
    if (h.n > max) return next(new AppError(429, 'TOO_MANY', '操作太频繁了，请稍后再试。'));
    next();
  };
}
