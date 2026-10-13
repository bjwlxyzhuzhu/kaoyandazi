// 书房 · 成果铺垫（第9站，M10）：成果目录、我的成果项目
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Achievement, AchievementsResp, AchievementCatalogResp } from '../api/types2';
import { StationShell } from './Road';
import { useToast } from '../components/Toast';
import { EmptyHint } from './StudyShared';

export default function Station9() {
  const toast = useToast();
  const [error, setError] = useState('');

  return (
    <StationShell station={9}>
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}
      <Outcome onError={setError} onToast={toast} />
    </StationShell>
  );
}
// ---------- 成果铺垫（M10） ----------

const STAGE_ORDER = ['了解中', '组队/找导师', '选题', '推进中', '提交', '已完成', '已放弃'];

function Outcome({ onError, onToast }: { onError: (s: string) => void; onToast: (s: string, k?: 'ok' | 'error' | 'warn') => void }) {
  const [data, setData] = useState<AchievementsResp | null>(null);
  const [cat, setCat] = useState<AchievementCatalogResp | null>(null);
  const [busy, setBusy] = useState(false);

  const [type, setType] = useState('竞赛');
  const [name, setName] = useState('');
  const [deadline, setDeadline] = useState('');
  const [notes, setNotes] = useState('');

  const load = useCallback(async () => {
    const [a, c] = await Promise.all([api<AchievementsResp>('/achievements'), api<AchievementCatalogResp>('/achievements/catalog')]);
    setData(a); setCat(c);
  }, []);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  const add = async (t = type, n = name) => {
    onError('');
    if (!n.trim()) { onError('请填写成果名称。'); return; }
    setBusy(true);
    try {
      await api('/achievements', { body: { type: t, name: n, deadline: deadline || undefined, notes } });
      onToast('已登记');
      setName(''); setDeadline(''); setNotes('');
      await load();
    } catch (e) { onError(e instanceof ApiError ? e.message : '登记失败。'); } finally { setBusy(false); }
  };

  const setStage = async (a: Achievement, stage: string) => {
    try {
      await api(`/achievements/${a.id}`, { method: 'PUT', body: { stage } });
      await load();
    } catch (e) { onError(e instanceof ApiError ? e.message : '更新失败。'); }
  };

  const remove = async (a: Achievement) => {
    if (!window.confirm(`删除“${a.name}”？`)) return;
    try { await api(`/achievements/${a.id}`, { method: 'DELETE' }); await load(); } catch (e) { onError((e as Error).message); }
  };

  if (!data || !cat) return <p className="muted" style={{ marginTop: 16 }}>正在载入…</p>;

  const recommended = cat.catalog.filter((x) => x.recommended);

  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <h2>我的成果项目</h2>
        <p className="muted small">
          共 {data.stats.total} 项：推进中 {data.stats.active} 项，已完成 {data.stats.done} 项
          {data.stats.urgent ? `，${data.stats.urgent} 项 7 天内截止` : ''}。
        </p>

        <div className="grid-3" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="ac-type">类型</label>
            <select id="ac-type" className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {cat.types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ac-name">名称</label>
            <input id="ac-name" className="input" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：全国大学生数学建模竞赛" />
          </div>
          <div className="field">
            <label htmlFor="ac-deadline">截止日期（选填）</label>
            <input id="ac-deadline" type="date" className="input" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="ac-notes">备注（选填）</label>
          <input id="ac-notes" className="input" maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="指导老师、组队情况、下一步…" />
        </div>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void add()}>登记成果项目</button>

        {!data.achievements.length ? (
          <EmptyHint>还没有登记任何成果项目。不用等准备好才开始——先从下面目录里挑一个。</EmptyHint>
        ) : (
          <ul className="list">
            {data.achievements.map((a) => (
              <li key={a.id}>
                <div className="row">
                  <span className="badge badge-muted">{a.type}</span>
                  <strong>{a.name}</strong>
                  {a.deadline && (
                    <span className={`badge ${a.overdue ? 'badge-pause' : a.urgent ? 'badge-warn' : 'badge-muted'}`}>
                      {a.deadline}{a.days_left !== null ? `（${a.days_left >= 0 ? `还有${a.days_left}天` : `已过期${-a.days_left}天`}）` : ''}
                    </span>
                  )}
                  <span className="spacer" />
                  <span className="muted small">阶段</span>
                  <select className="select" style={{ width: 'auto' }} value={a.stage} aria-label={`${a.name} 的阶段`} onChange={(e) => void setStage(a, e.target.value)}>
                    {STAGE_ORDER.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button type="button" className="btn btn-text btn-sm" onClick={() => void remove(a)}>删除</button>
                </div>
                {a.notes && <p className="small muted" style={{ margin: '4px 0 0' }}>{a.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <h2>成果目录</h2>
        <p className="muted small">{cat.note}</p>
        {recommended.length > 0 && (
          <>
            <h3>按你的路径推荐</h3>
            <p className="muted small">
              你是<strong>{cat.chosen_path ? `「${cat.chosen_path}」` : '尚未选定路径'}</strong>，
              所以优先显示适合这条路的项目。没有被推荐的也可以做。
            </p>
          </>
        )}
        <ul className="list">
          {[...cat.catalog].sort((a, b) => Number(b.recommended) - Number(a.recommended)).map((x) => (
            <li key={x.name}>
              <div className="row">
                <span className="badge badge-muted">{x.type}</span>
                <strong>{x.name}</strong>
                <span className="badge badge-muted">{cat.tiers[x.tier] || x.tier}</span>
                {x.recommended && <span className="badge badge-ok">适合你</span>}
                <span className="spacer" />
                <button type="button" className="btn btn-sm" onClick={() => { setName(x.name); setType(x.type); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                  登记这个
                </button>
              </div>
              <p className="small" style={{ margin: '4px 0 0' }}>
                <strong>时间规律：</strong>{x.timing}　<span className="muted">以官方通知为准</span>
              </p>
              <p className="small muted" style={{ margin: '2px 0 0' }}>适合谁：{x.who}</p>
              <p className="small muted" style={{ margin: '2px 0 0' }}>AI 能帮：{x.ai_help}</p>
              <p className="small" style={{ margin: '2px 0 0', color: 'var(--c-warn)' }}>注意：{x.caution}</p>
            </li>
          ))}
        </ul>
      </section>

      <p className="muted small">
        成果教练在 <Link to="/mentors">导师团</Link> 里，可以陪你弄清报名条件、怎么找指导老师、材料怎么搭。
        平台<strong>不代写</strong>申报书和作品正文，也会帮你识别代写代发、“包获奖”中介这类风险。
      </p>
    </>
  );
}
