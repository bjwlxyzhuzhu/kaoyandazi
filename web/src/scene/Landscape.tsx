// 首页山水：先画平面山水（立即可见、不阻塞点击），3D 分包加载完成后 600ms 淡入。
// 5 秒没就绪：继续用平面山水，并提供“使用简洁模式”；任何失败都退回平面，站点与数据不变。
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { StationRow } from '../api/types2';
import { reportFailure, setManualSimple, useImmersion, REASON_TEXT } from './immersion';

const Landscape3D = lazy(() => import('./Landscape3D'));
export const SCENE_TIMEOUT_MS = Number(import.meta.env.VITE_SCENE_TIMEOUT_MS || 5000);

/** 平面山水：纯 SVG，几 KB，作为占位与降级 */
export function Landscape2D({ current, total = 11 }: { current: number; total?: number }) {
  const ridges = [
    { c: '#c9dbd1', d: 'M0,150 C120,110 200,135 300,105 C420,70 520,120 640,95 C760,70 860,110 1000,85 L1000,260 L0,260 Z' },
    { c: '#a8c7b7', d: 'M0,175 C110,150 230,170 340,140 C470,105 560,160 690,135 C800,115 900,150 1000,130 L1000,260 L0,260 Z' },
    { c: '#7fa595', d: 'M0,205 C140,185 250,200 380,178 C500,160 610,195 730,180 C850,165 930,190 1000,178 L1000,260 L0,260 Z' },
  ];
  const pts = Array.from({ length: total }, (_, i) => ({ x: 80 + (840 * i) / (total - 1), y: 222 - (i / (total - 1)) * 40 - Math.sin((i / (total - 1)) * Math.PI * 2) * 8 }));
  return (
    <svg className="scene-2d-svg" viewBox="0 0 1000 260" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      {ridges.map((r) => <path key={r.c} d={r.d} fill={r.c} />)}
      <polyline points={pts.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#9a8054" strokeWidth="2" strokeDasharray="4 5" />
      {pts.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={i + 1 === current ? 7 : 4.5} fill={i + 1 < current ? '#2f6f62' : i + 1 === current ? '#255a4f' : '#c9d3cd'} stroke={i + 1 === current ? '#fff' : 'none'} strokeWidth="2" />)}
    </svg>
  );
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { reportFailure('error'); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function Landscape({ stations, current, focus }: { stations: StationRow[]; current: number; focus: number | null }) {
  const im = useImmersion();
  const [ready, setReady] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!im.use3d || ready) return;
    const t = window.setTimeout(() => setSlow(true), SCENE_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [im.use3d, ready]);

  const sceneStations = stations.map((s) => ({ station: s.station, status: s.status }));

  return (
    <div className={`scene ${ready && im.use3d ? 'scene-ready' : ''}`} data-scene={im.use3d ? (ready ? '3d' : 'loading') : '2d'} data-reason={im.reason || ''}>
      <Landscape2D current={current} />
      {im.use3d && (
        <SceneBoundary>
          <Suspense fallback={null}>
            <div className="scene-3d">
              <Landscape3D stations={sceneStations} current={current} focus={focus} reduced={im.reduced} onReady={() => setReady(true)} />
            </div>
          </Suspense>
        </SceneBoundary>
      )}
      {im.use3d && slow && !ready && (
        <p className="scene-note" role="status">3D 山水还在加载，不影响使用。<button type="button" className="btn btn-text btn-sm" onClick={() => setManualSimple(true)}>使用简洁模式</button></p>
      )}
      {!im.use3d && im.reason && im.reason !== 'manual' && <p className="scene-note" role="status">{REASON_TEXT[im.reason]}</p>}
    </div>
  );
}

/** 首页的沉浸效果开关（11.5：可在首页关闭沉浸效果） */
export function ImmersionToggle() {
  const im = useImmersion();
  const simple = im.reason === 'manual';
  return (
    <button type="button" className="btn btn-text btn-sm" aria-pressed={!simple} onClick={() => setManualSimple(!simple)} disabled={im.reason === 'nowebgl'}>
      {simple ? '开启沉浸效果' : '简洁模式'}
    </button>
  );
}
