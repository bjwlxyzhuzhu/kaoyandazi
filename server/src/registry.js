// agent-registry 与模块分级表（PRD 7.4、5.2）
import fs from 'node:fs';
import path from 'node:path';
import { SHARED_DIR } from './config.js';
import { getSettingJson, setSetting } from './db.js';

const registry = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'agent-registry.json'), 'utf8'));
const tiers = JSON.parse(fs.readFileSync(path.join(SHARED_DIR, 'module-tiers.json'), 'utf8'));

export const agents = registry.agents;
export const DEFAULT_COMPANION = registry.defaultCompanion;

const byKey = new Map(agents.map((a) => [a.key, a]));

export function getAgent(key) {
  return byKey.get(key) || null;
}

export function displayName(agent) {
  return agent ? `${agent.name}｜${agent.duty}` : '';
}

export const companions = agents.filter((a) => a.role === 'companion');

/**
 * 兼容旧人设：users.persona 可能保存旧中文名或旧英文值。
 * 返回陪伴导师稳定键；无法识别时返回默认陪伴导师。
 */
export function resolvePersona(raw) {
  if (!raw) return DEFAULT_COMPANION;
  const s = String(raw).trim();
  if (byKey.has(s) && byKey.get(s).role === 'companion') return s;
  for (const a of companions) {
    if (a.name === s || `${a.name}｜${a.duty}` === s || a.aliases.includes(s)) return a.key;
  }
  return DEFAULT_COMPANION;
}

/** 面向前端的公开字段（不含内部提示词以外的任何权限信息） */
export function publicAgent(a) {
  return {
    key: a.key, role: a.role || null, name: a.name, duty: a.duty, module: a.module,
    group: a.group, icon: a.icon, aliases: a.aliases, summary: a.summary,
    chat: !!a.chat, worker: !!a.worker,
  };
}

// ---------- 模块分级 ----------
export const moduleDefs = tiers.modules;
export const noKeyFeatures = tiers.noKey;

/** 教师调整后的分级（只允许 basic/advanced） */
export function moduleTier(id) {
  const overrides = getSettingJson('module_tiers', {});
  const def = moduleDefs.find((m) => m.id === id);
  if (!def) return null;
  const o = overrides[id];
  return o === 'basic' || o === 'advanced' ? o : def.tier;
}

export function allModuleTiers() {
  return moduleDefs.map((m) => ({ ...m, tier: moduleTier(m.id), defaultTier: m.tier }));
}

export function setModuleTiers(map) {
  const clean = {};
  for (const m of moduleDefs) {
    const v = map?.[m.id];
    if ((v === 'basic' || v === 'advanced') && v !== m.tier) clean[m.id] = v;
  }
  setSetting('module_tiers', clean);
  return allModuleTiers();
}
