// 11站长卷地图（PRD 4.3、M3）：默认只突出当前站与相邻站，点“成长地图”展开全部
import { Link } from 'react-router-dom';
import type { StationRow } from '../api/types2';

/** 2D 山水长卷：用横向路径与节点表达 11 站。所有节点都是真实 DOM 按钮，可键盘操作。 */
export function StationMap({ stations, current, expanded }: { stations: StationRow[]; current: number; expanded: boolean }) {
  const visible = expanded
    ? stations
    : stations.filter((s) => Math.abs(s.station - current) <= 1);

  return (
    <div className="map-wrap">
      <ol className="map" aria-label="成长地图：11站主线">
        {stations.map((s) => {
          const isCurrent = s.station === current;
          const shown = visible.some((v) => v.station === s.station);
          return (
            <li key={s.station} className={`map-node ${s.status} ${isCurrent ? 'current' : ''}`} aria-current={isCurrent ? 'step' : undefined} hidden={!shown}>
              <Link to={s.open ? s.route : '#'} className="map-dot" aria-disabled={!s.open} onClick={(e) => { if (!s.open) e.preventDefault(); }}>
                <span className="dot" aria-hidden="true">{s.status === 'done' ? '✓' : s.station}</span>
                <span className="map-label">
                  <span className="name">{s.name}</span>
                  <span className="muted small">{s.chapter}</span>
                </span>
              </Link>
              {!expanded && isCurrent && (
                <p className="muted small" style={{ margin: '4px 0 0' }}>{s.status === 'done' ? '已完成' : s.goal}</p>
              )}
            </li>
          );
        })}
      </ol>
      {!expanded && (
        <p className="muted small" style={{ marginTop: 12 }}>
          只显示当前站和相邻站。点“成长地图”可以看到完整11站与每站的产物。
        </p>
      )}
    </div>
  );
}

/** 完整地图（抽屉内容） */
export function StationList({ stations, current }: { stations: StationRow[]; current: number }) {
  return (
    <ul className="list">
      {stations.map((s) => (
        <li key={s.station}>
          <div className="row">
            <span className={`dot sm ${s.status}`} aria-hidden="true">{s.status === 'done' ? '✓' : s.station}</span>
            <span>
              <strong>{s.name}</strong>{' '}
              <span className="muted small">{s.chapter}</span>
              {s.station === current && <span className="badge badge-ok" style={{ marginLeft: 8 }}>当前站</span>}
              {!s.open && <span className="badge badge-muted" style={{ marginLeft: 8 }}>后续阶段开放</span>}
            </span>
          </div>
          <p className="muted small" style={{ margin: '4px 0 0 0' }}>{s.full}</p>
          <p className="muted small" style={{ margin: 0 }}>产物：{s.product}</p>
          {s.open && <Link to={s.route} className="btn btn-text">进入这一站</Link>}
        </li>
      ))}
    </ul>
  );
}
