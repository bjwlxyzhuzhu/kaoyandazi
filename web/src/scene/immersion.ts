// 沉浸效果（3D 山水）的开关与降级判断（PRD 11.5、13.2）
// 顺序：用户手动简洁 → 不支持 WebGL → 运行中失败（上下文丢失、持续低帧率）→ 都没问题才用 3D。
// 只在本机保存“简洁模式”这一个非敏感偏好。
import { useSyncExternalStore } from 'react';

export type FallbackReason = 'manual' | 'nowebgl' | 'contextlost' | 'lowfps' | 'error' | 'timeout' | null;

const KEY = 'swz.immersive';
let runtimeFail: FallbackReason = null;
const listeners = new Set<() => void>();
const emit = () => { applyBodyClass(); listeners.forEach((l) => l()); };

export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

let webglCache: boolean | null = null;
export function webglSupported(): boolean {
  if (webglCache !== null) return webglCache;
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    webglCache = !!gl;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    webglCache = false;
  }
  return webglCache;
}

export function manualSimple(): boolean {
  try { return localStorage.getItem(KEY) === 'off'; } catch { return false; }
}

export function setManualSimple(simple: boolean) {
  try { localStorage.setItem(KEY, simple ? 'off' : 'on'); } catch { /* 隐私模式 */ }
  if (!simple) runtimeFail = null;
  emit();
}

/** 运行中失败：本次会话改用 2D，不写入偏好（下次进入再试一次） */
export function reportFailure(reason: Exclude<FallbackReason, null | 'manual' | 'nowebgl'>) {
  if (runtimeFail) return;
  runtimeFail = reason;
  emit();
}

export interface ImmersionState { use3d: boolean; reason: FallbackReason; reduced: boolean }

function snapshot(): ImmersionState {
  const reduced = reducedMotion();
  let reason: FallbackReason = null;
  if (manualSimple()) reason = 'manual';
  else if (!webglSupported()) reason = 'nowebgl';
  else if (runtimeFail) reason = runtimeFail;
  return { use3d: reason === null, reason, reduced };
}

let cached = typeof window !== 'undefined' ? snapshot() : { use3d: false, reason: null, reduced: false };
function refresh() { cached = snapshot(); }

/** 简洁模式（手动或降级）时，所有毛玻璃表面换成不透明纸白（11.3） */
function applyBodyClass() {
  refresh();
  if (typeof document === 'undefined') return;
  document.body.classList.toggle('simple-mode', manualSimple());
  document.body.classList.toggle('scene-2d', !cached.use3d);
}

export function useImmersion(): ImmersionState {
  return useSyncExternalStore(
    (l) => { listeners.add(l); const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)'); const h = () => { refresh(); l(); }; mq?.addEventListener?.('change', h); return () => { listeners.delete(l); mq?.removeEventListener?.('change', h); }; },
    () => cached,
    () => cached,
  );
}

export const REASON_TEXT: Record<Exclude<FallbackReason, null>, string> = {
  manual: '你选择了简洁模式。',
  nowebgl: '这台设备或浏览器不支持 3D 显示，已改用简洁的平面山水。',
  contextlost: '3D 显示意外中断，已改用平面山水，内容和功能不受影响。',
  lowfps: '这台设备运行 3D 有些吃力，已自动改用平面山水。',
  error: '3D 场景加载出错，已改用平面山水。',
  timeout: '3D 场景加载较慢，先用平面山水。',
};

if (typeof window !== 'undefined') queueMicrotask(applyBodyClass);
