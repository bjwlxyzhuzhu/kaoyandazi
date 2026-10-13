// 统一弹层宿主（PRD 4.4、10.3）
// - 状态机：closed → opening → open → closing → closed
// - 同一时间至多一个模态面板；相同入口再次点击收起；快速连点不产生重复实例
// - 打开时焦点进入面板标题，Tab 限制在面板内，Esc 关闭，关闭后焦点回到触发按钮
// - 面板首次打开后保持挂载（关闭时隐藏），因此未提交的草稿和滚动位置都会保留
// - 点击背景不做破坏性操作：有未保存内容时只提示，不关闭
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

type Phase = 'closed' | 'opening' | 'open' | 'closing';

interface OverlayState {
  activeId: string | null;
  phase: Phase;
}

interface OverlayApi extends OverlayState {
  open: (id: string, trigger?: HTMLElement | null) => void;
  close: (id?: string) => void;
  toggle: (id: string, trigger?: HTMLElement | null) => void;
  isOpen: (id: string) => boolean;
}

const Ctx = createContext<OverlayApi | null>(null);

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const CLOSE_MS = () => (reducedMotion() ? 100 : 200);

export function OverlayHost({ children }: { children: ReactNode }) {
  const [state, setState] = useState<OverlayState>({ activeId: null, phase: 'closed' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const triggers = useRef(new Map<string, HTMLElement | null>());
  const pendingFocus = useRef<HTMLElement | null>(null);
  const timer = useRef<number | null>(null);

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const finishClose = useCallback((id: string) => {
    pendingFocus.current = triggers.current.get(id) ?? null;
    triggers.current.delete(id);
    setState({ activeId: null, phase: 'closed' });
  }, []);

  const close = useCallback((id?: string) => {
    const s = stateRef.current;
    if (!s.activeId || (id && id !== s.activeId) || s.phase === 'closing' || s.phase === 'closed') return;
    const closing = s.activeId;
    clearTimer();
    setState({ activeId: closing, phase: 'closing' });
    timer.current = window.setTimeout(() => finishClose(closing), CLOSE_MS());
  }, [finishClose]);

  const open = useCallback((id: string, trigger?: HTMLElement | null) => {
    const s = stateRef.current;
    if (s.activeId === id && (s.phase === 'opening' || s.phase === 'open')) return;
    clearTimer();
    if (trigger !== undefined) triggers.current.set(id, trigger);
    // 已有其他面板时直接替换，不叠加
    setState({ activeId: id, phase: 'opening' });
    timer.current = window.setTimeout(() => setState({ activeId: id, phase: 'open' }), 16);
  }, []);

  const toggle = useCallback((id: string, trigger?: HTMLElement | null) => {
    const s = stateRef.current;
    if (s.activeId === id && (s.phase === 'opening' || s.phase === 'open')) close(id);
    else open(id, trigger);
  }, [open, close]);

  const isOpen = useCallback((id: string) => state.activeId === id && (state.phase === 'opening' || state.phase === 'open'), [state]);

  useEffect(() => clearTimer, []);

  // 模态打开时让底层页面不可聚焦、不可操作；关闭后把焦点还给触发按钮。
  // 顺序很关键：先去 inert，再抢焦点，否则底层还不可聚焦，focus() 会落到 body 上。
  useEffect(() => {
    const root = document.getElementById('root');
    if (root) {
      if (state.activeId && state.phase !== 'closed') root.setAttribute('inert', '');
      else root.removeAttribute('inert');
    }
    const back = pendingFocus.current;
    if (!back) return;
    pendingFocus.current = null;
    if (document.contains(back) && document.activeElement !== back) back.focus();
  }, [state]);

  const api = useMemo<OverlayApi>(() => ({ ...state, open, close, toggle, isOpen }), [state, open, close, toggle, isOpen]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {state.activeId && state.phase !== 'closed' && createPortal(
        <div className="scrim" data-state={state.phase} onClick={() => window.dispatchEvent(new CustomEvent('overlay:scrim', { detail: state.activeId }))} />,
        document.getElementById('overlay-root') || document.body,
      )}
    </Ctx.Provider>
  );
}

export function useOverlay(): OverlayApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOverlay 必须在 OverlayHost 内使用');
  return v;
}

interface PanelProps {
  id: string;
  title: string;
  kind?: 'drawer' | 'dialog';
  /** 是否有未保存内容：点背景时不关闭，只提示 */
  isDirty?: () => boolean;
  footer?: ReactNode;
  children: ReactNode;
}

export function OverlayPanel({ id, title, kind = 'drawer', isDirty, footer, children }: PanelProps) {
  const ov = useOverlay();
  const active = ov.activeId === id && ov.phase !== 'closed';
  const [mounted, setMounted] = useState(false);
  const [blockedHint, setBlockedHint] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = `ov-title-${id}`;

  if (active && !mounted) setMounted(true);

  // 打开后焦点定位到标题（或带 data-autofocus 的控件）
  useLayoutEffect(() => {
    if (ov.activeId !== id || ov.phase !== 'opening') return;
    setBlockedHint(false);
    const auto = panelRef.current?.querySelector<HTMLElement>('[data-autofocus]');
    (auto || titleRef.current)?.focus();
  }, [ov.activeId, ov.phase, id]);

  // 点击背景
  useEffect(() => {
    const onScrim = (e: Event) => {
      if ((e as CustomEvent).detail !== id) return;
      if (isDirty?.()) setBlockedHint(true);
      else ov.close(id);
    };
    window.addEventListener('overlay:scrim', onScrim);
    return () => window.removeEventListener('overlay:scrim', onScrim);
  }, [id, isDirty, ov]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      ov.close(id);
      return;
    }
    if (e.key !== 'Tab' || !panelRef.current) return;
    const focusables = Array.from(panelRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((el) => el.offsetParent !== null);
    if (!focusables.length) { e.preventDefault(); return; }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === titleRef.current)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  };

  if (!mounted) return null;
  return createPortal(
    <div
      ref={panelRef}
      className={`panel panel-${kind}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-state={active ? ov.phase : 'closed'}
      hidden={!active}
      onKeyDown={onKeyDown}
    >
      <div className="panel-head">
        <h2 id={titleId} ref={titleRef} tabIndex={-1}>{title}</h2>
        <button type="button" className="panel-close" aria-label="关闭" onClick={() => ov.close(id)}>×</button>
      </div>
      <div className="panel-body">
        {blockedHint && (
          <div className="notice notice-warn" role="status" style={{ marginBottom: 12 }}>
            <span className="icon">!</span>
            <span>这里还有没保存的内容。请先保存，或点右上角“×”关闭（草稿会保留）。</span>
          </div>
        )}
        {children}
      </div>
      {footer && <div className="panel-foot">{footer}</div>}
    </div>,
    document.getElementById('overlay-root') || document.body,
  );
}
