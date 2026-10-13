// 今日（M3）：2D山水长卷 + 一个主动作 + 至多3个摘要 + 底部悬浮工具条
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { FlowResp, InterventionsResp, TodayResp } from '../api/types2';
import { useAuth } from '../auth';
import { getAgent, DEFAULT_COMPANION } from '../registry';
import { StationMap } from '../components/StationMap';
import { MentorLabel } from '../components/MentorBadge';
import { OverlayPanel, useOverlay } from '../overlay/OverlayHost';
import { StationList } from '../components/StationMap';
import { InterventionCard } from '../components/InterventionCard';
import { Landscape, ImmersionToggle } from '../scene/Landscape';

function greeting() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 11) return '早上好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

export default function Today() {
  const { me } = useAuth();
  const ov = useOverlay();
  const [today, setToday] = useState<TodayResp | null>(null);
  const [flow, setFlow] = useState<FlowResp | null>(null);
  const [iv, setIv] = useState<InterventionsResp | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [t, f, i] = await Promise.all([
      api<TodayResp>('/today'),
      api<FlowResp>('/flow'),
      api<InterventionsResp>('/interventions'),
    ]);
    setToday(t); setFlow(f); setIv(i);
  }, []);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);
  // 站点抽屉关上后镜头回到全景
  useEffect(() => { if (ov.activeId !== 'station-detail') setFocus(null); }, [ov.activeId]);

  const dismissHandoff = () => {
    if (!today?.handoff) return;
    api('/today/handoff-seen', { body: { station: today.current } }).catch(() => {});
    setToday((t) => (t ? { ...t, handoff: null } : t));
  };

  const companion = getAgent(me?.persona || DEFAULT_COMPANION);

  if (error) return <div className="notice notice-error" role="alert"><span className="icon">!</span><span>{error}</span></div>;
  if (!today || !flow) return <p className="muted">正在载入…</p>;

  const s = today.stats;
  const pending = iv?.pending || [];
  const cur = flow.stations.find((x) => x.station === flow.current)!;
  const allDone = s.done_stations === s.total_stations;

  return (
    <div className="page-narrow">
      <Notices />
      <section className="today-stage">
        <Landscape stations={flow.stations} current={flow.current} focus={focus} />
        <div className="today-hero">
        <p className="muted">{greeting()}，{me?.name}</p>
        <h1>{s.done_stations === 0 ? '今天，从一个小问题开始。' : allDone ? '11站都走完了。' : `你已经走过 ${s.done_stations} 站了。`}</h1>
        <p className="muted">{allDone ? '可以在“成长档案”里回看每一站的产物，也可以继续练复试。' : today.next_step}</p>
        <div className="row" style={{ marginTop: 24 }}>
          <Link to={allDone ? '/growth' : today.action_route} className="btn btn-primary">
            {allDone ? '回看成长档案' : today.action} <span className="arrow">→</span>
          </Link>
          <button type="button" className="btn" onClick={(e) => { setFocus(flow.current); ov.open('station-detail', e.currentTarget); }}>
            看看{allDone ? '最后一' : '这一'}站：{cur.name}
          </button>
          {s.today_tasks > 0 && !s.today_checked && (
            <Link to="/road/6" className="btn">去打卡</Link>
          )}
          <span className="spacer" />
          <ImmersionToggle />
        </div>
        </div>
      </section>

      {/* 7.6 站点交接：进入新站时主讲导师说一次 */}
      {today.handoff && (
        <section className="section handoff">
          <div className="row">
            <span className="badge badge-ok">交接 · 来自{today.handoff.from}</span>
            <span className="spacer" />
            <button type="button" className="btn btn-text btn-sm" onClick={dismissHandoff}>知道了</button>
          </div>
          <p style={{ margin: '8px 0 0' }}>{today.handoff.text}</p>
        </section>
      )}

      {/* M8 干预：待处理提醒优先出现在下一步区域 */}
      {pending.length > 0 && (
        <>
          <h2 className="section-title">需要你决定的事（{pending.length}）</h2>
          {pending.map((card) => (
            <InterventionCard
              key={card.id}
              card={card}
              onTalk={() => { window.location.href = `/mentors?from=${card.rule}`; }}
              onDone={() => void load()}
            />
          ))}
        </>
      )}

      {/* 至多三个摘要 */}
      <section className="section stat-row" aria-label="今天的摘要">
        <div className="stat">
          <strong>{s.done_stations}/{s.total_stations}</strong>
          <span className="muted small">已完成站数</span>
        </div>
        <div className="stat">
          <strong>{s.today_tasks ? `${s.today_tasks_done}/${s.today_tasks}` : '—'}</strong>
          <span className="muted small">今日任务</span>
        </div>
        <div className="stat">
          <strong>{s.pending_interventions}</strong>
          <span className="muted small">待处理提醒</span>
        </div>
      </section>

      <section className="section">
        <div className="row">
          <h3 style={{ margin: 0 }}>今天谁陪你</h3>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={(e) => ov.toggle('today-map', e.currentTarget)}>看完整11站</button>
        </div>
        <MentorLabel agent={companion} />
        <p className="muted small" style={{ marginTop: 8 }}>
          {companion?.summary} 这一站主要陪你的是 {today.mentors.primaryLabel}。可以在“导师团”里随时换一位。
        </p>
      </section>

      <section className="section">
        <div className="row">
          <h3 style={{ margin: 0 }}>成长地图</h3>
          <span className="spacer" />
          <button type="button" className="btn btn-text" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : '展开全部'}
          </button>
        </div>
        <StationMap stations={flow.stations} current={flow.current} expanded={expanded} />
      </section>

      {/* 底部悬浮工具条：四个入口 */}
      <nav className="float-bar" aria-label="快捷入口">
        <Link to="/mentors">找搭子</Link>
        <Link to="/class">课堂</Link>
        <Link to="/road/6">打卡</Link>
        <Link to="/memories">它记得什么</Link>
      </nav>

      <OverlayPanel id="station-detail" title={`第${cur.station}站 · ${cur.name}`}>
        <p className="muted small">{cur.chapter} · {cur.status === 'done' ? '已完成' : cur.status === 'in_progress' ? '进行中' : '还没开始'}</p>
        <p>{cur.goal}</p>
        <p className="small">这一站的产物：{cur.product}</p>
        <p className="small muted">{cur.full}</p>
        {cur.open && <Link to={cur.route} className="btn btn-primary">进入这一站 <span className="arrow">→</span></Link>}
      </OverlayPanel>

      <OverlayPanel id="today-map" title="完整的11站">
        <StationList stations={flow.stations} current={flow.current} />
      </OverlayPanel>
    </div>
  );
}

/** 老师发布的站内通知（最近一条） */
function Notices() {
  const [n, setN] = useState<{ id: number; title: string; text: string; at: string } | null>(null);
  const [hidden, setHidden] = useState(() => localStorage.getItem('swz.noticeSeen') || '');
  useEffect(() => { api<{ notices: { id: number; title: string; text: string; at: string }[] }>('/notices').then((r) => setN(r.notices[0] || null)).catch(() => {}); }, []);
  if (!n || hidden === String(n.id)) return null;
  return (
    <div className="notice notice-ok" role="status" style={{ marginBottom: 16 }}>
      <span className="icon">✉</span>
      <span style={{ flex: 1 }}><strong>老师通知：{n.title}</strong> <span className="muted small">{n.at.slice(5, 16)}</span><br />{n.text}</span>
      <button type="button" className="btn btn-text btn-sm" onClick={() => { localStorage.setItem('swz.noticeSeen', String(n.id)); setHidden(String(n.id)); }}>知道了</button>
    </div>
  );
}
