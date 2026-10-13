// 邮件（M8）：QQ邮箱 SMTP。未配置 SMTP 时系统照常运行，只记一条“未发送”的日志。
import nodemailer from 'nodemailer';
import { db } from './db.js';
import { nowLocal } from './time.js';
import { getSetting } from './db.js';
import { redact } from './crypto.js';
import { anonText } from './anon.js';

let cached = null;
let cachedKey = '';

function smtpConfig() {
  // 教师后台已保存的配置优先，其次环境变量
  const fromSettings = {
    host: getSetting('smtp.host'),
    port: getSetting('smtp.port'),
    user: getSetting('smtp.user'),
    pass: getSetting('smtp.pass'),
    fromName: getSetting('smtp.from_name'),
  };
  const host = fromSettings.host || process.env.SMTP_HOST || 'smtp.qq.com';
  const port = Number(fromSettings.port || process.env.SMTP_PORT || 465);
  const user = fromSettings.user || process.env.SMTP_USER || '';
  const pass = fromSettings.pass || process.env.SMTP_PASS || '';
  const fromName = fromSettings.fromName || process.env.SMTP_FROM_NAME || '山海问知';
  // 教师在后台可以整体关掉邮件提醒（站内提醒照常）
  const enabled = getSetting('mail.enabled') !== '0';
  return { host, port, user, pass, fromName, enabled, configured: enabled && !!(user && pass) };
}

function transporter() {
  const c = smtpConfig();
  const key = `${c.host}:${c.port}:${c.user}:${c.pass}`;
  if (cached && cachedKey === key) return { t: cached, c };
  if (cached) cached.close?.();
  cached = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.port === 465,
    auth: { user: c.user, pass: c.pass },
    connectionTimeout: 15000,
    socketTimeout: 20000,
  });
  cachedKey = key;
  return { t: cached, c };
}

export function mailConfigured() {
  return smtpConfig().configured;
}

/** 配置变化后清掉连接缓存（教师在后台改 SMTP 时调用） */
export function resetMailer() {
  cached?.close?.();
  cached = null;
  cachedKey = '';
}

function record(userId, kind, ok, info) {
  db.prepare('INSERT INTO mail_log(user_id, kind, date, ok, info, created_at) VALUES(?, ?, ?, ?, ?, ?)')
    .run(userId ?? null, kind, nowLocal().slice(0, 10), ok ? 1 : 0, String(info || '').slice(0, 300), nowLocal());
}

/**
 * 发一封邮件。返回 { sent, info }。
 * 同一类邮件每人每天最多一封（force 用于教师手动测试）。
 */
export async function sendMail({ user, to, subject, text, kind = 'general', force = false }) {
  const c = smtpConfig();
  if (!c.configured) {
    record(user?.id, kind, 0, c.enabled ? '未配置 SMTP，邮件未发送' : '教师已关闭邮件提醒，邮件未发送');
    return { sent: false, info: c.enabled ? '未配置 SMTP' : '邮件提醒已关闭' };
  }
  const today = nowLocal().slice(0, 10);
  if (!force && user?.id) {
    const dup = db.prepare('SELECT id FROM mail_log WHERE user_id = ? AND kind = ? AND date = ? AND ok = 1').get(user.id, kind, today);
    if (dup) return { sent: false, info: '今天已发过同类邮件' };
  }
  try {
    const { t } = transporter();
    const info = await t.sendMail({
      from: `"${c.fromName}" <${c.user}>`,
      to,
      subject: anonText(subject),
      text: anonText(text),
    });
    record(user?.id, kind, 1, `已发送：${info.messageId || ''}`);
    return { sent: true, info: info.messageId || '已发送' };
  } catch (e) {
    // 失败原因里不能出现授权码
    record(user?.id, kind, 0, `发送失败：${redact(e?.message || e)}`);
    return { sent: false, info: redact(e?.message || String(e)) };
  }
}

/** 教师后台“发送测试邮件” */
export async function testMail(to) {
  if (!smtpConfig().configured) return { sent: false, info: '还没有配置 SMTP（需要 QQ 邮箱授权码）' };
  return sendMail({ to, kind: 'test', force: true, subject: '【山海问知】测试邮件', text: '这是一封测试邮件。收到即说明邮件提醒可以正常工作。\n\n山海问知' });
}

/** 最近的邮件记录（教师端“每个学生的邮件记录”用） */
export function mailHistory({ userId, limit = 50 } = {}) {
  const rows = userId
    ? db.prepare('SELECT * FROM mail_log WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit)
    : db.prepare('SELECT * FROM mail_log ORDER BY id DESC LIMIT ?').all(limit);
  return rows;
}
