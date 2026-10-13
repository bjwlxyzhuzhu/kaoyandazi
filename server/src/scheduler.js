// M8 定时巡检：每10分钟检查一次（时区 Asia/Shanghai），按规则触发干预与邮件。
// 全部基于规则模板，不调用大模型。没有配置 SMTP 时照常写干预，只是不发邮件。
import { nowLocal } from './time.js';
import { getSetting } from './db.js';
import { runChecksForAll } from './interventions.js';
import { mailConfigured } from './mail.js';

const TICK_MS = 10 * 60 * 1000;   // 每10分钟
let timer = null;
let running = false;
let lastRunKey = '';              // 同一分钟内只跑一次

async function tick() {
  if (running) return;
  const stamp = nowLocal();
  const key = stamp.slice(0, 16); // 精确到分钟
  if (key === lastRunKey) return;
  running = true;
  try {
    const out = await runChecksForAll();
    lastRunKey = key;
    if (out.triggered.length) {
      const n = out.triggered.reduce((s, x) => s + x.created.length, 0);
      console.log(`[巡检] ${stamp} 检查 ${out.students} 名学生，触发 ${n} 条提醒${mailConfigured() ? '' : '（未配置 SMTP，仅站内提醒）'}`);
    }
  } catch (e) {
    console.warn('[巡检] 出错：', e?.message);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  if (timer) return;
  if (getSetting('checks.enabled') === '0') {
    console.log('[巡检] 已在教师后台关闭，未启动定时任务。');
    return;
  }
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();               // 不阻止进程退出
  setTimeout(tick, 20_000).unref?.();
  console.log(`[巡检] 已启动：每10分钟检查一次${mailConfigured() ? '' : '（未配置 SMTP，只写站内提醒）'}`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 教师手动触发一次（不受10分钟限制） */
export async function runOnce() {
  return runChecksForAll();
}
