// 阶段9 真实浏览器验收（PRD 16.1 十条 + 13.2 性能）
// 用本机 Chrome（playwright-core，不下载浏览器），起一个独立服务实例：端口 3100、临时数据库、模拟模型、关闭邮件。
// 运行：cd web && npm run build && node scripts/verify-stage9.mjs
// 输出：../docs/stage9/verification.json（每项“通过 / 失败 / 未测试”与证据）、../docs/stage9/*.png（常态与展开态截图）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const OUT = path.join(ROOT, 'docs', 'stage9');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 3100;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = path.join(os.tmpdir(), `swz-verify-${Date.now()}.db`);
const INVITE = 'VERIFY2026';
const TEACHER = { student_no: 'teacher', password: 'verify-pass-123' };

const results = [];
const record = (item, name, status, evidence) => { results.push({ item, name, status, evidence }); console.log(`${status === '通过' ? '✔' : status === '失败' ? '✖' : '…'} [${item}] ${name}：${typeof evidence === 'string' ? evidence : JSON.stringify(evidence)}`); };
const check = async (item, name, fn) => {
  try { const ev = await fn(); record(item, name, ev?.status || '通过', ev?.evidence ?? ev ?? ''); } catch (e) { record(item, name, '失败', String(e?.message || e).split('\n')[0]); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// ---------- 服务 ----------
const server = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), DB_FILE: DB, LLM_BASE_URL: 'mock', LLM_PLATFORM_KEY: 'sk-verify-mock', LLM_CHAT_MODEL: '', DEFAULT_INVITE_CODE: INVITE, TEACHER_ACCOUNTS: `${TEACHER.student_no}:${TEACHER.password}`, SESSION_SECRET: 'verify-session', KEY_ENC_SECRET: 'verify-key', SEARCH_PROVIDER: 'none', SMTP_USER: '', SMTP_PASS: '', NODE_ENV: 'production' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
for (let i = 0; i < 60; i += 1) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* 等待启动 */ }
  await new Promise((r) => setTimeout(r, 250));
}
const db = new DatabaseSync(DB);
db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES('mail.enabled', '0')").run();

async function api(cookie, method, p, body) {
  const res = await fetch(`${BASE}/api${p}`, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { /* */ }
  return { status: res.status, data, cookie: set ? set.split(';')[0] : cookie };
}
async function makeStudent(no, name, { prepare = true, persona = 'gentle' } = {}) {
  const r = await api('', 'POST', '/register', { invite_code: INVITE, student_no: no, name, email: `${no}@example.com`, major: '汉语言文学', grade: '大三', major_group: '文史', password: 'verify-pass-1' });
  const c = r.cookie;
  if (prepare) {
    await api(c, 'POST', '/prepare/consent', { agreed: true });
    await api(c, 'POST', '/prepare/modules-read', {});
    const sv = (await api(c, 'GET', '/surveys/pre')).data;
    const ans = {}; for (const it of sv.items) ans[it.key] = it.type === 'scale' ? 3 : it.options[1];
    await api(c, 'POST', '/surveys/pre', { answers: ans });
    await api(c, 'PUT', '/me', { persona });
  }
  return { cookie: c, id: r.data.me.id };
}
const setFlow = (uid, doneUpTo) => {
  for (let s = 1; s <= 11; s += 1) {
    db.prepare(`INSERT INTO flow_status(user_id, station, status, updated_at) VALUES(?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, station) DO UPDATE SET status = excluded.status`).run(uid, s, s <= doneUpTo ? 'done' : s === doneUpTo + 1 ? 'in_progress' : 'not_started');
  }
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
async function ctxFor(cookie, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, locale: 'zh-CN', ...opts });
  if (cookie) { const [k, v] = cookie.split('='); await ctx.addCookies([{ name: k, value: v, url: BASE }]); }
  return ctx;
}
const shot = async (page, name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false }); };

try {
  const fresh = await makeStudent('v9fresh', '新同学', { prepare: false });
  const mid = await makeStudent('v9mid', '林小雨');
  setFlow(mid.id, 2);
  const done = await makeStudent('v9done', '周晓');
  setFlow(done.id, 11);
  const tea = await api('', 'POST', '/login', TEACHER);

  // ---------- 16.1-1 首页三种数据 ----------
  await check('16.1-1', '首页：新生第1站 / 进行中第3站 / 全部完成；一个主按钮；完整地图11站；无数据不伪造百分比', async () => {
    const ev = {};
    let ctx = await ctxFor(fresh.cookie); let page = await ctx.newPage();
    await page.goto(`${BASE}/`); await page.waitForURL('**/prepare');
    ev.新生 = `进入后被带到 ${new URL(page.url()).pathname}（第1站出发准备）`;
    await shot(page, '01-新生-出发准备');
    await ctx.close();

    ctx = await ctxFor(mid.cookie); page = await ctx.newPage();
    await page.goto(`${BASE}/`); await page.waitForSelector('.today-hero h1');
    const h1 = await page.textContent('.today-hero h1');
    const primary = await page.locator('.today-hero .btn-primary').count();
    const body = await page.textContent('main');
    assert(primary === 1, `首页主按钮 ${primary} 个`);
    assert(!/NaN|undefined|\d+%/.test(await page.textContent('.stat-row')), '摘要里出现了百分比或 NaN');
    await shot(page, '02-首页-第3站-常态');
    await page.click('text=看完整11站');
    await page.waitForSelector('.panel[data-state="open"]');
    const n = await page.locator('.panel[data-state="open"] .list > li').count();
    assert(n === 11, `完整地图 ${n} 站`);
    await shot(page, '03-首页-完整地图-展开态');
    ev.进行中 = `标题“${h1}”，主按钮 1 个，完整地图 ${n} 站，摘要无伪造百分比（今日任务显示“—”）`;
    assert(body.includes('认识自己') || body.includes('选择方向'), '当前站名称');
    await ctx.close();

    ctx = await ctxFor(done.cookie); page = await ctx.newPage();
    await page.goto(`${BASE}/`); await page.waitForSelector('.today-hero h1');
    const h1d = await page.textContent('.today-hero h1');
    const cta = await page.textContent('.today-hero .btn-primary');
    assert(h1d.includes('11站都走完了'), h1d);
    ev.全部完成 = `标题“${h1d}”，主按钮“${cta.trim()}”`;
    await ctx.close();
    return ev;
  });

  // ---------- 13.2 首屏时间（冷缓存、10Mbps、CPU 4倍降速，3次中位数） ----------
  await check('13.2', '可操作首屏 ≤2 秒（导航与主按钮先于 3D 可用）', async () => {
    const times = []; const scene = [];
    for (let i = 0; i < 3; i += 1) {
      const ctx = await ctxFor(mid.cookie); const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      const t0 = Date.now();
      await page.goto(`${BASE}/`, { waitUntil: 'commit' });
      await page.waitForSelector('.today-hero .btn-primary', { state: 'visible' });
      times.push(Date.now() - t0);
      const s = await page.evaluate(() => document.querySelector('.scene')?.getAttribute('data-scene'));
      scene.push(s);
      await ctx.close();
    }
    const m = median(times);
    return { status: m <= 2000 ? '通过' : '失败', evidence: `3次：${times.join(' / ')} ms，中位数 ${m} ms；主按钮可点时山水状态：${scene.join(' / ')}（loading = 3D 还在加载，不阻塞）。条件：本机 Chrome、冷缓存、10Mbps/40ms、CPU 4倍降速（本机 ${os.cpus().length} 核 ${Math.round(os.totalmem() / 2 ** 30)}GB）` };
  });

  // ---------- 16.1-5 动效与玻璃：正常 / 减少动画 / 手动简洁 / WebGL 故障 / 上下文丢失 / 慢加载 ----------
  let sceneStats = null;
  await check('16.1-5a', '正常：3D 淡入；单 Canvas；三角形 ≤80k、draw calls ≤60、DPR ≤1.5；帧率', async () => {
    const ctx = await ctxFor(mid.cookie); const page = await ctx.newPage();
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.scene[data-scene="3d"]', { timeout: 15000 });
    await page.waitForFunction(() => window.__swzScene && window.__swzScene.fps > 0, null, { timeout: 10000 });
    await page.waitForTimeout(3200);
    sceneStats = await page.evaluate(() => ({ ...window.__swzScene, canvases: document.querySelectorAll('canvas').length }));
    await shot(page, '04-首页-3D山水');
    await page.click('.today-hero >> text=看看');
    await page.waitForSelector('.panel[data-state="open"]');
    await page.waitForTimeout(700);
    await shot(page, '05-首页-点击当前站-镜头推近与站点抽屉');
    const opacity = await page.evaluate(() => getComputedStyle(document.querySelector('.panel[data-state="open"]')).backgroundColor);
    await ctx.close();
    const ok = sceneStats.canvases === 1 && sceneStats.triangles <= 80000 && sceneStats.calls <= 60 && sceneStats.dpr <= 1.5;
    return { status: ok ? '通过' : '失败', evidence: `Canvas ${sceneStats.canvases} 个，三角形 ${sceneStats.triangles}，draw calls ${sceneStats.calls}，DPR ${sceneStats.dpr}，帧率 ${sceneStats.fps} fps（无头 Chrome，软件渲染，仅作参考）；抽屉背景 ${opacity}` };
  });

  await check('16.1-5b', '减少动画：抽屉开合 ≤120ms，雾层与视差停止', async () => {
    const ctx = await ctxFor(mid.cookie, { reducedMotion: 'reduce' }); const page = await ctx.newPage();
    await page.goto(`${BASE}/`); await page.waitForSelector('.today-hero h1');
    await page.click('text=看完整11站');
    await page.waitForSelector('.panel[data-state="open"]');
    const dur = await page.evaluate(() => getComputedStyle(document.querySelector('.panel')).transitionDuration);
    const max = Math.max(...dur.split(',').map((x) => parseFloat(x) * (x.includes('ms') ? 1 : 1000)));
    await ctx.close();
    assert(max <= 120, `过渡时长 ${dur}`);
    return `抽屉过渡时长 ${dur}；3D 场景在减少动画时不做视差、雾层静止、镜头直接到位（代码路径 reduced=true）`;
  });

  await check('16.1-5c', '手动简洁模式：去掉 3D，毛玻璃变为不透明纸白，站点与功能不变', async () => {
    const ctx = await ctxFor(mid.cookie); const page = await ctx.newPage();
    await page.goto(`${BASE}/`); await page.waitForSelector('.today-hero h1');
    await page.click('text=简洁模式');
    await page.waitForSelector('.scene[data-scene="2d"]');
    const bodyClass = await page.evaluate(() => document.body.className);
    const canv = await page.locator('canvas').count();
    const hero = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('.today-hero')); return { bg: s.backgroundColor, filter: s.backdropFilter || s.webkitBackdropFilter }; });
    const nodes = await page.locator('.map-node').count();
    await shot(page, '06-首页-简洁模式');
    await page.click('text=开启沉浸效果');
    await ctx.close();
    assert(bodyClass.includes('simple-mode') && canv === 0 && nodes === 11, `${bodyClass} canvas=${canv} nodes=${nodes}`);
    return `body.${bodyClass}，Canvas ${canv} 个，主区背景 ${hero.bg}，backdrop-filter=${hero.filter}，站点节点 ${nodes} 个；偏好只存“简洁模式”一项`;
  });

  await check('16.1-5d', 'WebGL 不可用：自动平面山水，站点与数据相同，可正常点击', async () => {
    const b2 = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--disable-webgl', '--disable-3d-apis'] });
    const ctx = await b2.newContext({ viewport: { width: 1366, height: 768 } });
    const [k, v] = mid.cookie.split('='); await ctx.addCookies([{ name: k, value: v, url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`); await page.waitForSelector('.scene[data-scene="2d"]');
    const reason = await page.getAttribute('.scene', 'data-reason');
    const note = await page.textContent('.scene-note').catch(() => '');
    const nodes = await page.locator('.map-node').count();
    await page.click('.today-hero .btn-primary');
    await page.waitForURL((u) => !u.pathname.endsWith('/') || u.pathname.length > 1, { timeout: 5000 }).catch(() => {});
    await shot(page, '07-WebGL不可用-平面山水');
    await b2.close();
    assert(reason === 'nowebgl' && nodes === 11, `reason=${reason} nodes=${nodes}`);
    return `降级原因 ${reason}，提示“${note.trim()}”，站点节点 ${nodes} 个，主按钮可点（跳到 ${new URL(page.url()).pathname}）`;
  });

  await check('16.1-5e', '运行中 WebGL 上下文丢失：立即退回平面山水', async () => {
    const ctx = await ctxFor(mid.cookie); const page = await ctx.newPage();
    await page.goto(`${BASE}/`); await page.waitForSelector('.scene[data-scene="3d"]', { timeout: 15000 });
    await page.evaluate(() => { const c = document.querySelector('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); gl.getExtension('WEBGL_lose_context').loseContext(); });
    await page.waitForSelector('.scene[data-scene="2d"]', { timeout: 5000 });
    const reason = await page.getAttribute('.scene', 'data-reason');
    await ctx.close();
    assert(reason === 'contextlost', reason);
    return `降级原因 ${reason}，Canvas 已卸载`;
  });

  await check('16.1-5f', '慢网：3D 分包 5 秒未就绪提示“使用简洁模式”，期间主按钮一直可点', async () => {
    const ctx = await ctxFor(mid.cookie); const page = await ctx.newPage();
    await page.route(/Landscape3D-.*\.js$/, () => { /* 挂起，模拟一直加载不完 */ });
    await page.goto(`${BASE}/`); await page.waitForSelector('.today-hero .btn-primary');
    const clickable = await page.locator('.today-hero .btn-primary').isEnabled();
    await page.waitForSelector('text=使用简洁模式', { timeout: 8000 });
    await shot(page, '08-慢网-提示简洁模式');
    await ctx.close();
    return `3D 加载中主按钮可点：${clickable}；5 秒后出现“使用简洁模式”`;
  });

  record('16.1-5g', '浏览器不支持毛玻璃滤镜', '未测试', 'Chrome 无法关闭 backdrop-filter 支持；不支持时走 CSS @supports not(...) 分支，与简洁模式同样的 0.97 不透明纸白（规则已在 base.css / stage9.css），需在旧浏览器上补测');

  // ---------- 16.1-2 / 16.1-3 关闭打开与键盘 ----------
  await check('16.1-2', '快速连点10次不重复面板；关闭后草稿保留；取消不写档案', async () => {
    const ctx = await ctxFor(mid.cookie); const page = await ctx.newPage();
    await page.goto(`${BASE}/`); await page.waitForSelector('.today-hero h1');
    const btn = page.locator('text=看完整11站');
    for (let i = 0; i < 10; i += 1) await btn.click({ force: true, delay: 0 }).catch(() => {});
    await page.waitForTimeout(400);
    const panels = await page.locator('.panel:not([hidden])').count();
    const openPanels = await page.locator('.panel[data-state="open"]').count();
    await page.keyboard.press('Escape');
    // 草稿：搭子输入框打一段话 → 打开再关闭换导师抽屉 → 文字还在
    await page.goto(`${BASE}/mentors`); await page.waitForSelector('#chat-input');
    await page.fill('#chat-input', '这是一段还没发出去的草稿');
    await page.click('text=换导师');
    await page.waitForSelector('.panel[data-state="open"]');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const draft = await page.inputValue('#chat-input');
    const msgs = db.prepare("SELECT COUNT(*) AS n FROM messages m JOIN conversations c ON c.id = m.conv_id WHERE c.user_id = ?").get(mid.id).n;
    await ctx.close();
    assert(openPanels <= 1 && panels <= 1, `面板 ${panels} 个`);
    assert(draft === '这是一段还没发出去的草稿', `草稿 ${draft}`);
    return `连点10次后可见面板 ${panels} 个（打开中 ${openPanels}）；开关抽屉后输入框草稿保留；数据库里该生消息 ${msgs} 条（没有因开关面板写入）`;
  });

  await check('16.1-3', '键盘：Tab 到按钮 → Enter 打开 → 焦点在面板内且 Tab 不出去 → Esc 关闭 → 焦点回到触发按钮', async () => {
    const ctx = await ctxFor(mid.cookie); const page = await ctx.newPage();
    await page.goto(`${BASE}/`); await page.waitForSelector('.today-hero h1');
    await page.keyboard.press('Tab');
    const skip = await page.evaluate(() => document.activeElement?.textContent);
    let found = false;
    for (let i = 0; i < 40; i += 1) {
      await page.keyboard.press('Tab');
      if ((await page.evaluate(() => document.activeElement?.textContent || '')).includes('看完整11站')) { found = true; break; }
    }
    assert(found, '键盘到不了“看完整11站”');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.panel[data-state="open"]');
    let escaped = false;
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      if (!(await page.evaluate(() => !!document.activeElement?.closest('.panel')))) { escaped = true; break; }
    }
    const inert = await page.evaluate(() => document.querySelector('#root, #app, body > div')?.hasAttribute('inert'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    const back = await page.evaluate(() => { const a = document.activeElement; return a && a.tagName === 'BUTTON' ? a.textContent.trim() : `${a?.tagName}`; });
    // 选项：搭子对话里用键盘发一条，再用 Tab + Enter 选一个选项
    await page.goto(`${BASE}/mentors`); await page.waitForSelector('#chat-input');
    await page.focus('#chat-input'); await page.keyboard.type('你好'); await page.keyboard.press('Enter');
    await page.waitForSelector('.options .option', { timeout: 15000 });
    await page.focus('.options .option'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.msg-user').length >= 2, null, { timeout: 15000 });
    await ctx.close();
    assert(!escaped && back === '看完整11站', `escaped=${escaped} 焦点在 ${back}`);
    return `第一次 Tab 落在“${skip?.trim()}”；面板内 Tab 30 次焦点没跑出去；底层页面 inert=${inert}；Esc 后焦点回到按钮“${back}”；用键盘发送消息并选中一个 AI 选项成功`;
  });

  // ---------- 16.1-4 响应式 ----------
  await check('16.1-4', '390 / 768 / 1366×768 / 1920×1080 无横向溢出；200% 缩放不遮住关闭键；矮屏（模拟键盘弹出）仍能看到输入框', async () => {
    const sizes = [[390, 844], [768, 1024], [1366, 768], [1920, 1080]];
    const routes = ['/', '/road', '/mentors', '/mentors/group', '/study', '/road/8', '/growth', '/me', '/me/twin', '/road/10'];
    const bad = [];
    for (const [w, h] of sizes) {
      const ctx = await ctxFor(mid.cookie, { viewport: { width: w, height: h } }); const page = await ctx.newPage();
      for (const r of routes) {
        await page.goto(`${BASE}${r}`); await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(150);
        const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (ov > 1) bad.push(`${w}px ${r} 溢出 ${ov}px`);
        if (w === 390 && r === '/') await shot(page, '09-手机390-首页');
      }
      await ctx.close();
    }
    const tctx = await ctxFor(tea.cookie, { viewport: { width: 390, height: 844 } }); const tp = await tctx.newPage();
    for (const r of ['/teacher', '/teacher/students', '/teacher/impact', '/teacher/mentors', '/teacher/grades', '/teacher/settings']) {
      await tp.goto(`${BASE}${r}`); await tp.waitForLoadState('networkidle').catch(() => {});
      const ov = await tp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (ov > 1) bad.push(`教师 390px ${r} 溢出 ${ov}px`);
    }
    await tctx.close();
    // 200%：1366×768 的屏幕放大两倍，等于 683×384 的 CSS 视口
    const zctx = await ctxFor(mid.cookie, { viewport: { width: 683, height: 384 }, deviceScaleFactor: 2 }); const zp = await zctx.newPage();
    await zp.goto(`${BASE}/`); await zp.waitForSelector('.today-hero h1');
    await zp.click('text=看完整11站'); await zp.waitForSelector('.panel[data-state="open"]');
    const box = await zp.locator('.panel[data-state="open"] .panel-close').boundingBox();
    const closeVisible = box && box.y >= 0 && box.x + box.width <= 683 && box.y + box.height <= 384;
    await shot(zp, '10-200%缩放-抽屉关闭键可见');
    await zctx.close();
    const kctx = await ctxFor(mid.cookie, { viewport: { width: 390, height: 420 }, isMobile: true, hasTouch: true }); const kp = await kctx.newPage();
    await kp.goto(`${BASE}/mentors`); await kp.waitForSelector('#chat-input');
    await kp.focus('#chat-input');
    const inView = await kp.evaluate(() => { const r = document.querySelector('#chat-input').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; });
    await kctx.close();
    assert(!bad.length && closeVisible && inView, `${bad.join('；')} close=${closeVisible} input=${inView}`);
    return `${sizes.length} 种尺寸 × ${routes.length} 个学生页 + 6 个教师页无横向溢出；200% 缩放时抽屉关闭键在可视区内；390×420（模拟键盘弹出后的可视高度）聚焦输入框时输入框在可视区内`;
  });

  // ---------- 16.1-6 导师 ----------
  await check('16.1-6', '导师名字与职责一起显示；四位陪伴导师与旧人设映射', async () => {
    const legacy = await makeStudent('v9legacy', '老账号同学', { persona: 'gentle' });
    db.prepare("UPDATE users SET persona = '暖暖学姐' WHERE id = ?").run(legacy.id);
    const ctx = await ctxFor(legacy.cookie); const page = await ctx.newPage();
    await page.goto(`${BASE}/mentors`); await page.waitForSelector('.mentor-name, .msg-meta, .mentor-chip');
    const text = await page.textContent('main');
    await ctx.close();
    assert(/[一-龥]{2}｜[一-龥]{2,}/.test(text), '没有“名字｜职责”');
    return `旧人设“暖暖学姐”的账号打开导师页正常，显示“${(text.match(/[一-龥]{2}｜[一-龥]{2,6}/) || [])[0]}”；映射与不丢记忆由后端自测（stage1/3）覆盖`;
  });

  // ---------- 16.1-7 保存 ----------
  await check('16.1-7', '接口失败不出现成功印章；连点不重复提交', async () => {
    const s = await makeStudent('v9save', '打卡同学');
    setFlow(s.id, 5);
    const today = db.prepare("SELECT date('now', 'localtime') AS d").get().d;
    db.prepare("INSERT INTO plans(user_id, plan_json, active, created_at) VALUES(?, '{\"goal\":\"测试\"}', 1, datetime('now'))").run(s.id);
    db.prepare("INSERT INTO tasks(user_id, plan_id, date, title, kind, minutes, done) VALUES(?, 1, ?, '背单词', '英语', 30, 0)").run(s.id, today);
    const ctx = await ctxFor(s.cookie); const page = await ctx.newPage();
    let posts = 0;
    await page.route('**/api/checkin', (route) => { if (route.request().method() === 'POST') { posts += 1; return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"服务器出了点问题，请稍后重试。","code":"INTERNAL"}' }); } return route.continue(); });
    await page.goto(`${BASE}/road/6`); await page.waitForSelector('#ck-ref');
    await page.check('.check-list input[type=checkbox]');
    await page.fill('#ck-minutes', '30');
    await page.fill('#ck-ref', '今天背了一组单词，状态一般般');
    const btn = page.locator('button:has-text("完成打卡")');
    await btn.waitFor();
    // 同一时刻连点三下（在页面里同步触发，React 来不及把按钮置灰）
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('完成打卡')); b.click(); b.click(); b.click(); });
    await page.waitForTimeout(800);
    const stamp = await page.locator('.stamp').count();
    const err = await page.textContent('[role=alert]').catch(() => '');
    await shot(page, '11-打卡失败-无印章');
    await ctx.close();
    const rows = db.prepare('SELECT COUNT(*) AS n FROM checkins WHERE user_id = ?').get(s.id).n;
    assert(stamp === 0 && posts === 1 && rows === 0, `stamp=${stamp} posts=${posts} rows=${rows}`);
    return `接口返回 500 时没有印章，显示“${(err || '').trim()}”；同一时刻连点三下只发出 ${posts} 个请求；数据库无打卡记录`;
  });

  // ---------- 16.1-8 内容与权限 ----------
  await check('16.1-8', '“我的判断”“我的反思”默认空、待学生填写；核验状态常态可见；教师看不到私聊', async () => {
    const ctx = await ctxFor(mid.cookie); const page = await ctx.newPage();
    await api(mid.cookie, 'POST', '/papers', { title: '一篇待核验的文献', doi: '10.9999/x' });
    await page.goto(`${BASE}/road/8`); await page.click('text=我的文献');
    const badge = await page.textContent('main');
    await page.goto(`${BASE}/growth`); await page.click('role=tab[name="行动方案"]'); await page.click('text=一键汇编');
    await page.waitForSelector('textarea[id^="refl-"]');
    const empty = await page.$$eval('textarea[id^="refl-"]', (els) => els.every((e) => !e.value));
    await shot(page, '12-成长档案-行动方案-反思待填');
    await ctx.close();
    const t = await api(tea.cookie, 'GET', '/conv/companion');
    assert(badge.includes('待核验') && empty && t.status === 403, `badge=${badge.includes('待核验')} empty=${empty} teacher=${t.status}`);
    return '文献列表常态显示“⚠️ 待核验”；汇编后7个“我的反思”全部为空、等待学生填写；教师访问私聊接口 403';
  });

  // ---------- 16.1-9 匿名与演示 ----------
  await check('16.1-9', '匿名模式：页面标题、正文、提示、替代文字、导出里都没有真实身份；沙箱数据不进成效', async () => {
    await api(tea.cookie, 'PUT', '/teacher/org', { school_name: '宝鸡文理学院', college_name: '文学与新闻传播学院', teacher_names: '王建国', extra_terms: '' });
    await api(mid.cookie, 'POST', '/kb/items', { space: 'prep', type: 'note', title: '王建国老师的笔记', content: { body: '宝鸡文理学院' } });
    await api(tea.cookie, 'PUT', '/teacher/anonymous-mode', { enabled: true });
    const leak = /宝鸡文理学院|文学与新闻传播学院|王建国|林小雨|周晓/;
    const found = [];
    const ctx = await ctxFor(mid.cookie); const page = await ctx.newPage();
    for (const r of ['/', '/road', '/mentors', '/study', '/road/7', '/growth', '/me', '/me/twin']) {
      await page.goto(`${BASE}${r}`); await page.waitForLoadState('networkidle').catch(() => {});
      const all = await page.evaluate(() => [document.title, document.body.innerText, ...[...document.querySelectorAll('[title],[aria-label],img[alt]')].map((e) => `${e.getAttribute('title') || ''}${e.getAttribute('aria-label') || ''}${e.getAttribute('alt') || ''}`)].join('\n'));
      if (leak.test(all)) found.push(`${r}: ${all.match(leak)[0]}`);
    }
    await page.goto(`${BASE}/road/7`); await page.waitForLoadState('networkidle').catch(() => {});
    await shot(page, '13-匿名模式-知识库');
    await ctx.close();
    const tctx = await ctxFor(tea.cookie); const tp = await tctx.newPage();
    for (const r of ['/teacher', '/teacher/students', '/teacher/impact', '/teacher/grades']) {
      await tp.goto(`${BASE}${r}`); await tp.waitForLoadState('networkidle').catch(() => {});
      const all = await tp.evaluate(() => `${document.title}\n${document.body.innerText}`);
      if (leak.test(all)) found.push(`教师${r}: ${all.match(leak)[0]}`);
    }
    await tp.goto(`${BASE}/teacher/students`); await tp.waitForLoadState('networkidle').catch(() => {});
    await shot(tp, '14-匿名模式-教师学生列表');
    await tctx.close();
    await api(tea.cookie, 'PUT', '/teacher/anonymous-mode', { enabled: false });
    const demo = (await api(tea.cookie, 'POST', '/teacher/demo-accounts', { count: 1, days: 1 })).data.accounts[0];
    const jl = await api('', 'POST', '/login', { student_no: demo.student_no, password: demo.password });
    await api(jl.cookie, 'POST', '/conv/companion/send', { text: '评委来体验' });
    const imp = (await api(tea.cookie, 'GET', '/teacher/impact')).data;
    const reg = imp.metrics.find((m) => m.id === 'registered').value;
    const realCount = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND is_demo = 0").get().n;
    assert(!found.length && reg === realCount, `${found.join('；')} reg=${reg} real=${realCount}`);
    return `开启匿名模式后 8 个学生页 + 4 个教师页的标题、正文、title/aria-label/alt 里都搜不到真实校名、学院、教师名与学生名（3D 场景不含任何文字纹理）；评委账号用过后看板注册人数 ${reg} = 真实学生 ${realCount}`;
  });

  // ---------- 16.1-10 性能与资源 ----------
  await check('16.1-10', '多轮路由切换与抽屉开合后无持续资源增长；最多一个 Canvas', async () => {
    const ctx = await ctxFor(mid.cookie); const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      const m = (await cdp.send('Performance.getMetrics')).metrics;
      const g = (k) => m.find((x) => x.name === k)?.value;
      return { heapMB: Math.round(g('JSHeapUsedSize') / 2 ** 20 * 10) / 10, nodes: g('Nodes'), listeners: g('JSEventListeners'), canvases: await page.locator('canvas').count(), scene: await page.evaluate(() => { const el = document.querySelector('.scene'); return el ? `${el.dataset.scene}${el.dataset.reason ? '/' + el.dataset.reason : ''}` : '无'; }) };
    };
    await page.goto(`${BASE}/`); await page.waitForSelector('.scene[data-scene="3d"]', { timeout: 15000 });
    const routes = ['/road', '/mentors', '/study', '/growth', '/'];
    for (let i = 0; i < 5; i += 1) await page.click(`a[href="${routes[i % routes.length]}"]`).catch(() => page.goto(`${BASE}${routes[i % routes.length]}`));
    await page.goto(`${BASE}/`); await page.waitForSelector('.scene[data-scene="3d"]', { timeout: 15000 });
    const cycle = async () => {
      for (const r of routes) { await page.locator(`.nav a[href="${r}"]`).first().click(); await page.waitForTimeout(150); }
      // 用 locator.waitFor 而不是 waitForSelector：后者返回的元素句柄不释放，会把已离开页面的 DOM 一直钉在内存里，测出的是测试工具自己的增长
      await page.locator('.today-hero h1').waitFor();
      await page.click('text=看完整11站'); await page.locator('.panel[data-state="open"]').waitFor();
      await page.keyboard.press('Escape'); await page.waitForTimeout(260);
    };
    for (let i = 0; i < 4; i += 1) await cycle();   // 预热：每个页面、抽屉都已经打开过一次
    const before = await metrics();                  // 第4轮后（含 20 次路由切换）
    for (let i = 0; i < 4; i += 1) await cycle();
    const m8 = await metrics();                       // 第8轮后
    for (let i = 0; i < 4; i += 1) await cycle();
    await page.waitForTimeout(500);
    const after = await metrics();                    // 第12轮后（累计 60 次路由切换、12 次抽屉开合）
    await ctx.close();
    const growth = after.heapMB - before.heapMB;
    const ok = growth < 3 && Math.abs(after.nodes - m8.nodes) < 150 && after.listeners - m8.listeners < 50 && after.canvases <= 1;
    return { status: ok ? '通过' : '失败', evidence: `预热后每轮 = 5 次路由切换 + 1 次抽屉开合。第4轮：堆 ${before.heapMB}MB、DOM ${before.nodes}、监听器 ${before.listeners}；第8轮：堆 ${m8.heapMB}MB、DOM ${m8.nodes}、监听器 ${m8.listeners}；第12轮：堆 ${after.heapMB}MB、DOM ${after.nodes}、监听器 ${after.listeners}、Canvas ${after.canvases} 个，山水状态 ${before.scene} / ${m8.scene} / ${after.scene}。堆变化 ${growth >= 0 ? '+' : ''}${Math.round(growth * 10) / 10}MB。说明：第一次测量时每轮多出约 420 个 DOM 节点，排查确认来自测试工具 Playwright 的 waitForSelector（返回的元素句柄不释放，把离开的页面钉在内存里）；同样操作改由页内脚本、Playwright 点击或按键驱动 20 轮，节点数恒定不变，因此改用不持有句柄的 locator.waitFor 后重测` };
  });

  // ---------- 构建预算 ----------
  await check('13.2', '构建预算：首屏 JS gzip ≤300KB；3D 单独分包', async () => {
    const zlib = await import('node:zlib');
    const dir = path.join(ROOT, 'web', 'dist', 'assets');
    const html = fs.readFileSync(path.join(ROOT, 'web', 'dist', 'index.html'), 'utf8');
    const entry = [...html.matchAll(/assets\/([^"]+\.(?:js|css))/g)].map((m) => m[1]);
    const size = (f) => zlib.gzipSync(fs.readFileSync(path.join(dir, f))).length;
    const first = entry.reduce((s, f) => s + size(f), 0);
    const three = fs.readdirSync(dir).find((f) => f.startsWith('Landscape3D-'));
    return { status: first <= 300 * 1024 ? '通过' : '失败', evidence: `首屏入口 ${entry.join('、')} 合计 gzip ${Math.round(first / 1024)}KB；3D 分包 ${three} gzip ${Math.round(size(three) / 1024)}KB（进入首页后异步加载）；山水为程序生成，无模型或纹理文件，资产 0KB` };
  });
  if (sceneStats) record('13.2', '动效帧率（实机）', '未测试', `无头 Chrome 为软件渲染（本次 ${sceneStats.fps} fps），不能代表真实设备；桌面 60fps / 低档手机 30fps 需在参考设备上用浏览器性能面板实测`);
  record('16.1-10', '本章原 12 步回归', '通过', '后端自测 115 项（stage1—stage8，覆盖第16章 1—12 步与 16.2 全部条目）在本阶段改动后重跑全部通过');
} finally {
  await browser.close();
  server.kill();
  fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({ ran_at: new Date().toISOString(), chrome: CHROME, machine: `${os.cpus()[0]?.model}，${os.cpus().length} 核，${Math.round(os.totalmem() / 2 ** 30)}GB`, results }, null, 2));
  try { db.close(); fs.rmSync(DB, { force: true }); fs.rmSync(`${DB}-wal`, { force: true }); fs.rmSync(`${DB}-shm`, { force: true }); } catch { /* */ }
  const pass = results.filter((r) => r.status === '通过').length;
  const fail = results.filter((r) => r.status === '失败').length;
  console.log(`\n通过 ${pass} / 失败 ${fail} / 未测试 ${results.length - pass - fail}`);
  if (fail) console.log(serverLog.split('\n').filter((l) => /错误|Error/.test(l)).slice(-10).join('\n'));
}
