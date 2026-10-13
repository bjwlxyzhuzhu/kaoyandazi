// Express 应用
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { ROOT_DIR } from './config.js';
import { db } from './db.js';
import { redact } from './crypto.js';
import { AppError } from './errors.js';
import { sessionMiddleware } from './auth.js';
import account from './routes/account.js';
import keys from './routes/keys.js';
import conv from './routes/conv.js';
import teacher from './routes/teacher.js';
import mentors from './routes/mentors.js';
import flow from './routes/flow.js';
import profile from './routes/profile.js';
import schools from './routes/schools.js';
import plan from './routes/plan.js';
import classroom from './routes/classroom.js';
import memory from './routes/memory.js';
import group from './routes/group.js';
import research from './routes/research.js';
import kb from './routes/kb.js';
import achievements from './routes/achievements.js';
import twin from './routes/twin.js';
import lab from './routes/lab.js';
import interview from './routes/interview.js';
import assess from './routes/assess.js';
import workshop from './routes/workshop.js';
import admin, { runlogMiddleware } from './routes/admin.js';
import { anonMiddleware } from './anon.js';

// 日志一律脱敏：任何疑似 Key 的片段都显示为 sk-****
for (const level of ['log', 'info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => orig(...args.map((a) => (typeof a === 'string' ? redact(a) : a instanceof Error ? redact(a.stack || a.message) : a)));
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // 访问日志：只记录方法、路径、状态与耗时，不记录请求头（其中可能有 X-User-Key）和请求体
  app.use((req, res, next) => {
    const t = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api/')) console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - t}ms`);
    });
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware);
  app.use(runlogMiddleware);
  app.use(anonMiddleware);

  app.get('/api/health', (_req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use('/api', account, keys, conv, teacher, mentors, flow, profile, schools, plan, classroom, memory, group, research, kb, achievements, twin, lab, interview, assess, workshop, admin);
  app.use('/api', (_req, _res, next) => next(new AppError(404, 'NOT_FOUND', '接口不存在。')));

  // 生产环境：同一端口提供前端静态文件
  const dist = path.join(ROOT_DIR, 'web', 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '7d', setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // 统一错误处理：返回中文提示，不泄露内部信息
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    }
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: '请求格式不正确。', code: 'BAD_JSON' });
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: '内容太长了。', code: 'TOO_LARGE' });
    console.error('[服务器错误]', err);
    if (res.headersSent) return res.end();
    res.status(500).json({ error: '服务器出了点问题，请稍后重试。', code: 'INTERNAL' });
  });

  return app;
}
