// 第3站 选择方向：路径对比打分 → 选定并写理由（≥30字）→ 一个苏格拉底问题（M5）
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { PathCard, ProfileResp } from '../api/types2';
import { StationShell } from './Road';
import { useToast } from '../components/Toast';

const DIMS = ['兴趣', '可行性', '回报', '风险', '时间'];

export default function Station3() {
  const toast = useToast();
  const [prof, setProf] = useState<ProfileResp | null>(null);
  const [pathId, setPathId] = useState('');
  const [reason, setReason] = useState('');
  const [scores, setScores] = useState<Record<string, Record<string, number>>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [socraticAnswer, setSocraticAnswer] = useState('');

  const load = useCallback(async () => {
    const p = await api<ProfileResp>('/profile');
    setProf(p);
    setPathId(p.chosen_path || '');
    setReason(p.choice_reason || '');
    const init: Record<string, Record<string, number>> = {};
    for (const path of p.paths || []) {
      init[path.id] = { ...(p.path_scores?.[path.id] || {}) };
      for (const d of (p.compare_dims?.length ? p.compare_dims : DIMS)) if (!init[path.id][d]) init[path.id][d] = 3;
    }
    setScores(init);
  }, []);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  const saveScores = async () => {
    setBusy('scores'); setError('');
    try {
      await api('/profile/scores', { method: 'PUT', body: { scores } });
      toast('对比打分已保存');
    } catch (e) { setError(e instanceof ApiError ? e.message : '保存失败，请重试。'); } finally { setBusy(''); }
  };

  const choose = async () => {
    setBusy('choose'); setError('');
    try {
      await api('/profile/choose', { body: { path_id: pathId, reason } });
      toast('路径已选定，进入第4站');
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : '保存失败，请重试。'); } finally { setBusy(''); }
  };

  if (!prof) return <StationShell station={3}>{error ? <div className="notice notice-error"><span className="icon">!</span><span>{error}</span></div> : <p className="muted">正在载入…</p>}</StationShell>;

  if (!prof.profile) {
    return (
      <StationShell station={3}>
        <section className="section">
          <p>还没有画像和候选路径。请先完成第2站。</p>
          <Link className="btn btn-primary" to="/road/2">去第2站</Link>
        </section>
      </StationShell>
    );
  }

  const dims = prof.compare_dims?.length ? prof.compare_dims : DIMS;

  return (
    <StationShell station={3}>
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}

      <section className="section">
        <h2>第一步　把几条路放在一起比一比</h2>
        <p className="muted">按你自己在意的维度打分（1—5分）。分数只是帮你比较，怎么选由你决定。</p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>路径</th>{dims.map((d) => <th key={d}>{d}</th>)}</tr>
            </thead>
            <tbody>
              {(prof.paths || []).map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  {dims.map((d) => (
                    <td key={d}>
                      <label className="sr-only" htmlFor={`${p.id}-${d}`}>{p.name} {d}</label>
                      <select id={`${p.id}-${d}`} className="select" style={{ minWidth: 72 }}
                        value={scores[p.id]?.[d] ?? 3}
                        onChange={(e) => setScores((s) => ({ ...s, [p.id]: { ...s[p.id], [d]: Number(e.target.value) } }))}>
                        {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="button" className="btn" style={{ marginTop: 12 }} disabled={busy === 'scores'} onClick={() => void saveScores()}>
          {busy === 'scores' ? '正在保存…' : '保存对比打分'}
        </button>
      </section>

      <section className="section">
        <h2>第二步　选定一条路，写下理由</h2>
        <div className="chips" role="radiogroup" aria-label="选择一条路径">
          {(prof.paths || []).map((p) => (
            <button key={p.id} type="button" className="chip" role="radio" aria-checked={pathId === p.id} onClick={() => setPathId(p.id)}>
              {p.name}
            </button>
          ))}
        </div>
        <PathDetail path={(prof.paths || []).find((x) => x.id === pathId) || null} />
        <div className="field" style={{ marginTop: 16 }}>
          <label htmlFor="reason">我选这条路的理由（不少于30字，这是考核点）</label>
          <textarea id="reason" className="textarea" maxLength={800} value={reason} onChange={(e) => setReason(e.target.value)} />
          <span className="muted small" style={{ color: reason.trim().length < 30 ? 'var(--c-danger)' : 'var(--c-brand-strong)' }}>
            已写 {reason.trim().length} 字{reason.trim().length < 30 ? '，还不够' : ''}
          </span>
        </div>
        <p className="muted small">可以说说：为什么这条路适合你、你愿意付出什么代价、如果走不通你怎么办。</p>
        <button type="button" className="btn btn-primary" disabled={!pathId || reason.trim().length < 30 || busy === 'choose'} onClick={() => void choose()}>
          {busy === 'choose' ? '正在保存…' : prof.chosen_path ? '重新确认这条路径' : '确认选择'} <span className="arrow">→</span>
        </button>
        {prof.chosen_path && <p className="muted small">当前已选：{(prof.paths || []).find((x) => x.id === prof.chosen_path)?.name}（可以随时重新选择，历史会保留）</p>}
      </section>

      <section className="section">
        <h2>做决定前，先想一个问题</h2>
        <p style={{ fontSize: 18 }}>{prof.profile.socratic_question || '如果三年后发现这条路走不通，你的B计划是什么？'}</p>
        <div className="field">
          <label htmlFor="soc">我的想法（写给自己的，不会计入考核）</label>
          <textarea id="soc" className="textarea" value={socraticAnswer} onChange={(e) => setSocraticAnswer(e.target.value)} />
        </div>
        <p className="muted small">写下来，过几个月再回看，你会知道自己想清楚了没有。</p>
      </section>
    </StationShell>
  );
}

function PathDetail({ path }: { path: PathCard | null }) {
  if (!path) return null;
  return (
    <article className="section" style={{ background: '#fff', marginTop: 16 }}>
      <h3 style={{ marginTop: 0 }}>{path.name}</h3>
      <p><strong>适合的理由：</strong>{path.fit}</p>
      <p><strong>代价与风险：</strong>{path.cost}</p>
      <p><strong>关键节点：</strong>{path.milestones.join(' → ')}</p>
      <p><strong>成果铺垫建议：</strong>{path.achievements.join('、') || '暂无'}</p>
      <p><strong>AI能帮什么：</strong>{path.ai_leverage}</p>
      <p style={{ margin: 0 }}><strong>本周第一步：</strong>{path.first_step}</p>
    </article>
  );
}
