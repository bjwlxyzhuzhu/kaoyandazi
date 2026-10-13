// 时间工具：全站使用 Asia/Shanghai 本地时间
import { config } from './config.js';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.tz,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function parts(d) {
  const o = {};
  for (const p of fmt.formatToParts(d)) o[p.type] = p.value;
  return o;
}

/** 'YYYY-MM-DD HH:MM:SS'（本地时区） */
export function nowLocal(d = new Date()) {
  const p = parts(d);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/** 'YYYY-MM-DD'（本地时区） */
export function todayLocal(d = new Date()) {
  return nowLocal(d).slice(0, 10);
}

/** 'YYYY-MM'（本地时区） */
export function monthLocal(d = new Date()) {
  return nowLocal(d).slice(0, 7);
}

// 纯日期运算一律按 UTC 处理 'YYYY-MM-DD' 字符串，避免服务器时区让日期错一天

/** 'YYYY-MM-DD' 加减天数 */
export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 0=周日 … 6=周六 */
export function weekdayOf(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/** 所在周的周一 */
export function mondayOf(dateStr) {
  const day = weekdayOf(dateStr);
  return addDays(dateStr, day === 0 ? -6 : 1 - day);
}

/** 从某天起连续 n 天 */
export function daysFrom(dateStr, n) {
  return Array.from({ length: n }, (_, i) => addDays(dateStr, i));
}
