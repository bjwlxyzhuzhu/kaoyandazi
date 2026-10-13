// 导师注册表（与后端共用 shared/agent-registry.json）
import registry from '@shared/agent-registry.json';
import type { AgentInfo } from './api/types';

export const agents = registry.agents as unknown as AgentInfo[];
export const DEFAULT_COMPANION: string = registry.defaultCompanion;

const byKey = new Map(agents.map((a) => [a.key, a]));

export function getAgent(key: string | null | undefined): AgentInfo | null {
  return key ? byKey.get(key) || null : null;
}

/** 显示格式统一为“名字｜职责” */
export function displayName(a: AgentInfo | null): string {
  return a ? `${a.name}｜${a.duty}` : 'AI导师';
}

export const companions = agents.filter((a) => a.role === 'companion');
