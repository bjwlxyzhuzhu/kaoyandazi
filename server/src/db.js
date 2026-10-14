// 数据库：Node 22 内置 node:sqlite，单文件
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { config, SHARED_DIR } from './config.js';
import { nowLocal } from './time.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function openDb(file) {
  const target = file || path.join(config.dataDir, 'app.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

/**
 * 已有数据库的增量迁移：schema.sql 只能“建表”，新加的列要在这里补。
 * 每一项都可重复执行（列已存在就跳过）。
 */
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  const add = (table, col, def) => { if (!has(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); };
  add('users', 'expires_at', 'TEXT');          // 补充（阶段8）：评委测试账号的有效期
  add('users', 'demo_note', 'TEXT');           // 补充（阶段8）：评委账号备注（发给谁）
  add('mentor_docs', 'level', 'TEXT');         // 补充（阶段8）：资料的证据等级（官方 / 院校 / 经验帖），引用时显示
}

export const db = openDb(process.env.DB_FILE);

// ---------- settings 表 ----------
export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function getSettingJson(key, fallback = null) {
  const v = getSetting(key);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

export function setSetting(key, value) {
  const v = value == null ? null : typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, v);
}

// ---------- 事务 ----------
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- 初始化数据 ----------
function seed() {
  // 默认真实班级：邀请码来自环境变量，或首次启动随机生成（教师可在后台修改）
  const cls = db.prepare('SELECT id FROM classes WHERE is_sandbox = 0 LIMIT 1').get();
  if (!cls) {
    const code = config.defaultInviteCode || crypto.randomBytes(3).toString('hex').toUpperCase();
    db.prepare('INSERT INTO classes(name, invite_code, is_sandbox) VALUES(?, ?, 0)').run('默认班级', code);
    console.log(`[初始化] 已创建默认班级，邀请码：${code}（可在教师后台修改）`);
  } else if (config.defaultInviteCode) {
    // 设置了 DEFAULT_INVITE_CODE 时以环境变量为准，部署后再改环境变量也能生效
    const cur = db.prepare('SELECT invite_code FROM classes WHERE id = ?').get(cls.id).invite_code;
    if (cur !== config.defaultInviteCode) {
      db.prepare('UPDATE classes SET invite_code = ? WHERE id = ?').run(config.defaultInviteCode, cls.id);
      console.log(`[初始化] 默认班级邀请码已按 DEFAULT_INVITE_CODE 更新为：${config.defaultInviteCode}`);
    }
  } else {
    const cur = db.prepare('SELECT invite_code FROM classes WHERE id = ?').get(cls.id).invite_code;
    console.log(`[初始化] 默认班级邀请码：${cur}`);
  }
  if (!config.teacherAccounts.length) {
    console.warn('[配置] 未设置 TEACHER_ACCOUNTS，教师端无法登录。格式：用户名:密码');
  } else {
    const desc = config.teacherAccounts.map((t) => `${t.username}（${/^scrypt[:$]/.test(t.password) ? '哈希' : `密码 ${t.password.length} 位`}）`);
    console.log(`[配置] 教师账号：${desc.join('、')}`);
  }
  // 评委沙箱班级：评委测试账号都放这里，任何统计都排除它（PRD M17）
  if (!db.prepare('SELECT id FROM classes WHERE is_sandbox = 1 LIMIT 1').get()) {
    db.prepare('INSERT INTO classes(name, invite_code, is_sandbox) VALUES(?, ?, 1)').run('评委沙箱（演示）', `DEMO${crypto.randomBytes(4).toString('hex').toUpperCase()}`);
  }

  // 导师注册表同步到 mentors 表（只补充缺失项，不覆盖教师后续的版本信息）
  const registry = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'agent-registry.json'), 'utf8'));
  const ins = db.prepare(`INSERT OR IGNORE INTO mentors(key, display_name, role, stage_tags_json, current_version, status, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?)`);
  const now = nowLocal();
  for (const a of registry.agents) {
    ins.run(a.key, `${a.name}｜${a.duty}`, a.role || a.group, JSON.stringify([]), 'v1.0', 'published', now);
  }
}

seed();
