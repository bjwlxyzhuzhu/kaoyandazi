// 我的路：11站长卷地图 + 当前站工作页入口（PRD 10.1、10.2）
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { FlowResp } from '../api/types2';
import { StationList, StationMap } from '../components/StationMap';
import { OverlayPanel, useOverlay } from '../overlay/OverlayHost';
import { getAgent } from '../registry';

export default function Road() {
  const ov = useOverlay();
  const [flow, setFlow] = useState<FlowResp | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<FlowResp>('/flow').then(setFlow).catch((e) => setError((e as Error).message));
  }, []);

  if (error) return <div className="notice notice-error" role="alert"><span className="icon">!</span><span>{error}</span></div>;
  if (!flow) return <p className="muted">正在载入…</p>;

  const cur = flow.stations.find((s) => s.station === flow.current)!;

  return (
    <div className="page">
      <header className="row">
        <div>
          <h1>我的路</h1>
          <p className="muted" style={{ margin: 0 }}>11站主线，每站都留下一个产物，进入结课考核档案袋。</p>
        </div>
        <span className="spacer" />
        <button type="button" className="btn" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起地图' : '成长地图'}
        </button>
      </header>

      <section className="section" style={{ marginTop: 24 }}>
        <h2>我现在在这里</h2>
        <div className="row">
          <span className="dot" aria-hidden="true">{cur.station}</span>
          <div>
            <strong style={{ fontSize: 20 }}>{cur.name}</strong>{' '}
            <span className="muted small">{cur.chapter}</span>
            <p className="muted" style={{ margin: '4px 0 0' }}>{cur.goal}</p>
          </div>
        </div>
        <p className="muted small">这一站的产物：{cur.product}</p>
        {cur.open ? (
          <Link to={cur.route} className="btn btn-primary">
            {cur.status === 'done' ? '回看这一站' : '完成本站当前一步'} <span className="arrow">→</span>
          </Link>
        ) : (
          <p className="notice notice-warn"><span className="icon">!</span><span>这一站将在后续阶段开放。</span></p>
        )}
      </section>

      <section className="section">
        <div className="row">
          <h2 style={{ margin: 0 }}>成长地图</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={(e) => ov.toggle('map-list', e.currentTarget)}>完整11站清单</button>
        </div>
        <StationMap stations={flow.stations} current={flow.current} expanded={expanded} />
      </section>

      <OverlayPanel id="map-list" title="完整的11站">
        <StationList stations={flow.stations} current={flow.current} />
      </OverlayPanel>
    </div>
  );
}

/** 站点工作页外壳：统一的标题、目标、导师与返回 */
export function StationShell({
  station, children, extra,
}: { station: number; children: React.ReactNode; extra?: React.ReactNode }) {
  const [row, setRow] = useState<import('../api/types2').StationRow | null>(null);

  useEffect(() => {
    api<FlowResp>('/flow')
      .then((f) => setRow(f.stations.find((s) => s.station === station) || null))
      .catch(() => {});
  }, [station]);

  return (
    <div className="page">
      <p className="muted small"><Link to="/road">← 我的路</Link></p>
      <header>
        <h1>{row ? row.name : `第${station}站`}</h1>
        <p className="muted">{row ? `${row.chapter} · 产物：${row.product}` : ''}</p>
        {row && <p>{row.goal}</p>}
      </header>
      {extra}
      {children}
    </div>
  );
}

/** 显示本站主讲导师（7.6） */
export function StationMentorLine({ primaryLabel, coLabel, primaryKey }: { primaryLabel: string; coLabel: string; primaryKey: string | null }) {
  const a = primaryKey ? getAgent(primaryKey) : null;
  return <p className="muted small">这一站主要陪你的是：<strong>{a ? `${a.name}｜${a.duty}` : primaryLabel}</strong>{coLabel && <>，{coLabel} 也会参与</>}</p>;
}
