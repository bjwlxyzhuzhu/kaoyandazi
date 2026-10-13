// 第4站 选定目标：择校工作台（M6）。AI 对话与联网检索为高阶模块，用学生自己的 Key。
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { Candidate, SchoolFact, SchoolRow, SchoolsResp } from '../api/types2';
import type { MenuDef } from '../api/types2';
import { ChatPanel } from '../components/ChatPanel';
import { MenuForm } from '../components/MenuForm';
import { StationShell } from './Road';
import { useToast } from '../components/Toast';
import { useAuth } from '../auth';

const LEVEL_CLASS: Record<string, string> = { 官方: 'lv-1', 院校: 'lv-2', 经验帖: 'lv-3', AI推断: 'lv-4' };

export default function Station4() {
  const toast = useToast();
  const { me } = useAuth();
  const [menu, setMenu] = useState<MenuDef | null>(null);
  const [data, setData] = useState<SchoolsResp | null>(null);
  const [status, setStatus] = useState<{ search_enabled: boolean; daily_limit: number } | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showMenu, setShowMenu] = useState(false);

  const load = useCallback(async () => {
    const [m, s, st] = await Promise.all([
      api<MenuDef>('/menus/school'),
      api<SchoolsResp>('/schools'),
      api<{ search_enabled: boolean; daily_limit: number }>('/schools/status'),
    ]);
    setMenu(m); setData(s); setStatus(st);
    setShowMenu(!m.answers);
  }, []);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  const saveMenu = async (answers: Record<string, unknown>) => {
    setBusy('menu'); setError('');
    try {
      await api('/menus/school', { body: { answers } });
      await load();
      setShowMenu(false);
      toast('筛选条件已保存');
    } catch (e) { setError(e instanceof ApiError ? e.message : '保存失败，请重试。'); } finally { setBusy(''); }
  };

  const generate = async () => {
    setBusy('gen'); setError(''); setCandidates(null);
    try {
      const r = await api<{ candidates: Candidate[]; note: string }>('/schools/generate', { body: {}, withKey: true });
      setCandidates(r.candidates);
      setNote(r.note || '');
      toast('候选已生成，请逐条核验');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '生成失败，请重试。');
    } finally { setBusy(''); }
  };

  const addCandidate = async (c: Candidate) => {
    setBusy(`add-${c.school}`);
    setError('');
    try {
      await api('/schools', { body: { school: c.school, major: c.major, tier: c.tier, facts: c.facts } });
      await load();
      toast(`已加入比较表：${c.school}`);
    } catch (e) { setError(e instanceof ApiError ? e.message : '加入失败。'); } finally { setBusy(''); }
  };

  const exportCsv = async () => {
    setError('');
    try {
      const res = await fetch('/api/schools/export', { credentials: 'include' });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || '导出失败。');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${me?.name || '我'}-目标院校信息分析表.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast('已导出CSV，可用Excel打开');
    } catch (e) { setError((e as Error).message); }
  };

  return (
    <StationShell station={4}>
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}

      {!status?.search_enabled && (
        <div className="notice notice-warn" role="status" style={{ marginBottom: 16 }}>
          <span className="icon">!</span>
          <span>
            平台暂时没有接入联网检索，所以AI不会给出分数线、报录比这类具体数字。你可以自己在官网查好，把链接贴到下面的对话框里，AI 能帮你读页面、提炼要点。
          </span>
        </div>
      )}

      <section className="section">
        <div className="row">
          <h2 style={{ margin: 0 }}>第一步　筛选条件</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={() => setShowMenu((v) => !v)}>{showMenu ? '收起' : '修改条件'}</button>
        </div>
        {showMenu && menu && <MenuForm def={menu} submitting={busy === 'menu'} submitLabel="保存条件" onSubmit={(a) => void saveMenu(a)} />}
        {!showMenu && menu?.answers && (
          <ul className="list">
            {Object.entries(menu.answers).map(([k, v]) => (
              <li key={k}><span className="muted">{menuLabel(k)}：</span>{Array.isArray(v) ? v.join('、') : String(v)}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <h2>第二步　让AI给三层候选</h2>
        <p className="muted">每个候选都会标出来源和证据等级。没有来源的数字一律标“待核实”，请你自己去官网核对。</p>
        <button type="button" className="btn btn-primary" disabled={busy === 'gen' || !menu?.answers} onClick={() => void generate()}>
          {busy === 'gen' ? '正在生成…' : '生成冲刺 / 稳妥 / 保底候选'}
        </button>
        {!menu?.answers && <p className="muted small">先保存筛选条件再生成。</p>}
        {note && <p className="notice notice-warn" style={{ marginTop: 16 }}><span className="icon">!</span><span>{note}</span></p>}

        {candidates && (
          <div className="grid-3" style={{ marginTop: 16 }}>
            {['冲刺', '稳妥', '保底'].map((tier) => (
              <div key={tier}>
                <h3>{tier}</h3>
                {candidates.filter((c) => c.tier === tier).map((c) => (
                  <article key={c.school} className="card">
                    <strong>{c.school}</strong>
                    <p className="muted small" style={{ margin: '4px 0' }}>{c.major}</p>
                    <p className="small">{c.reason}</p>
                    <ul className="list small">
                      {c.facts.map((f) => (
                        <li key={f.item + f.value}>
                          {f.item}：{f.value} <span className={`badge ${LEVEL_CLASS[f.level]}`}>{f.level}</span>
                          {f.url && <a href={f.url} target="_blank" rel="noreferrer noopener" className="small"> 来源</a>}
                        </li>
                      ))}
                    </ul>
                    <button type="button" className="btn btn-sm" disabled={busy === `add-${c.school}`} onClick={() => void addCandidate(c)}>
                      {busy === `add-${c.school}` ? '正在加入…' : '加入比较表'}
                    </button>
                  </article>
                ))}
                {!candidates.some((c) => c.tier === tier) && <p className="muted small">这一层还没有候选。</p>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <h2>第三步　和AI一起核验</h2>
        <p className="muted">把官网链接贴进对话，AI 会读页面并帮你提炼。它读到的内容不代表你已经核验过。</p>
        <ChatPanel kind="school" agentKey="school" convId={undefined} />
      </section>

      <section className="section">
        <h2>第四步　比较表</h2>
        {!data?.schools.length && <p className="muted">还是空的。可以从上面的候选里点“加入比较表”，也可以手动添加。</p>}
        {!!data?.schools.length && (
          <>
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="badge badge-muted">共 {data.stats.total} 所</span>
              <span className="badge badge-muted">数据 {data.stats.facts_verified}/{data.stats.facts} 条已核验</span>
              {data.stats.missing_basis > 0 && <span className="badge badge-warn">{data.stats.missing_basis} 所还缺“选择依据/不确定之处”</span>}
            </div>
            {data.schools.map((s) => <SchoolEditor key={s.id} row={s} onChanged={() => void load()} />)}
            <div className="row" style={{ marginTop: 16 }}>
              <button type="button" className="btn" onClick={() => void exportCsv()}>导出 CSV（Excel可打开）</button>
              <button type="button" className="btn btn-text" onClick={() => window.print()}>打印版</button>
            </div>
          </>
        )}
        <ManualAdd onAdded={() => void load()} />
      </section>
    </StationShell>
  );
}

function menuLabel(k: string) {
  const map: Record<string, string> = {
    subject: '目标专业', region: '地域偏好', level: '层次倾向', degree: '学硕/专硕', cross: '是否跨考', risk: '风险偏好',
  };
  return map[k] || k;
}

function SchoolEditor({ row, onChanged }: { row: SchoolRow; onChanged: () => void }) {
  const toast = useToast();
  const [basis, setBasis] = useState(row.basis);
  const [uncertainty, setUncertainty] = useState(row.uncertainty);
  const [busy, setBusy] = useState('');

  const save = async () => {
    setBusy('save');
    try {
      await api(`/schools/${row.id}`, { method: 'PUT', body: { basis, uncertainty } });
      toast('已保存');
      onChanged();
    } catch (e) { toast(e instanceof ApiError ? e.message : '保存失败。'); } finally { setBusy(''); }
  };

  const toggleVerify = async (index: number, verified: boolean) => {
    setBusy(`v-${index}`);
    try {
      await api(`/schools/${row.id}/verify`, { body: { index, verified } });
      onChanged();
    } catch (e) { toast(e instanceof ApiError ? e.message : '操作失败。'); } finally { setBusy(''); }
  };

  const remove = async () => {
    if (!window.confirm(`确定从比较表里删除「${row.school}」吗？`)) return;
    setBusy('del');
    try {
      await api(`/schools/${row.id}`, { method: 'DELETE' });
      onChanged();
    } catch (e) { toast(e instanceof ApiError ? e.message : '删除失败。'); } finally { setBusy(''); }
  };

  const allVerified = row.facts.length > 0 && row.facts.every((f) => f.verified);

  return (
    <article className="section" style={{ background: '#fff' }}>
      <div className="row">
        <h3 style={{ margin: 0 }}>{row.school}</h3>
        <span className={`badge ${allVerified ? 'badge-ok' : 'badge-muted'}`}>{allVerified ? '数据已全部核验' : '有未核验数据'}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-text" disabled={busy === 'del'} onClick={() => void remove()}>删除</button>
      </div>
      <p className="muted small">{row.major} · {row.tier}</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>数据项</th><th>数值</th><th>来源</th><th>等级</th><th>核验</th></tr></thead>
          <tbody>
            {row.facts.map((f: SchoolFact, i) => (
              <tr key={`${f.item}-${i}`} style={{ opacity: f.verified ? 1 : 0.62 }}>
                <td>{f.item}</td>
                <td>{f.value}</td>
                <td>{f.url ? <a href={f.url} target="_blank" rel="noreferrer noopener">{f.source || f.url.slice(0, 40)}</a> : (f.source || '—')}</td>
                <td><span className={`badge ${LEVEL_CLASS[f.level]}`}>{f.level}</span></td>
                <td>
                  <label className="check small">
                    <input type="checkbox" checked={!!f.verified} disabled={busy === `v-${i}`} onChange={(e) => void toggleVerify(i, e.target.checked)} />
                    <span>我已核验</span>
                  </label>
                </td>
              </tr>
            ))}
            {!row.facts.length && <tr><td colSpan={5} className="muted">还没有数据，可以在对话里让AI帮你整理，或手动补上。</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="grid-2" style={{ marginTop: 12 }}>
        <div className="field">
          <label htmlFor={`basis-${row.id}`}>选择依据（考核点）</label>
          <textarea id={`basis-${row.id}`} className="textarea" maxLength={500} value={basis} onChange={(e) => setBasis(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`unc-${row.id}`}>不确定之处（考核点）</label>
          <textarea id={`unc-${row.id}`} className="textarea" maxLength={500} value={uncertainty} onChange={(e) => setUncertainty(e.target.value)} />
        </div>
      </div>
      <button type="button" className="btn" disabled={busy === 'save'} onClick={() => void save()}>{busy === 'save' ? '正在保存…' : '保存依据与不确定之处'}</button>
    </article>
  );
}

function ManualAdd({ onAdded }: { onAdded: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [school, setSchool] = useState('');
  const [major, setMajor] = useState('');
  const [tier, setTier] = useState<'冲刺' | '稳妥' | '保底'>('稳妥');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true);
    try {
      await api('/schools', { body: { school, major, tier, facts: [] } });
      setSchool(''); setMajor('');
      setOpen(false);
      toast('已手动添加');
      onAdded();
    } catch (e) { toast(e instanceof ApiError ? e.message : '添加失败。'); } finally { setBusy(false); }
  };

  if (!open) return <button type="button" className="btn btn-text" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>+ 手动添加一所</button>;

  return (
    <div className="section" style={{ background: '#fff', marginTop: 16 }}>
      <div className="grid-3">
        <div className="field">
          <label htmlFor="ma-school">院校名称</label>
          <input id="ma-school" className="input" value={school} onChange={(e) => setSchool(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ma-major">专业（代码）</label>
          <input id="ma-major" className="input" value={major} onChange={(e) => setMajor(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ma-tier">层次</label>
          <select id="ma-tier" className="select" value={tier} onChange={(e) => setTier(e.target.value as '冲刺' | '稳妥' | '保底')}>
            <option value="冲刺">冲刺</option><option value="稳妥">稳妥</option><option value="保底">保底</option>
          </select>
        </div>
      </div>
      <div className="row">
        <button type="button" className="btn btn-primary" disabled={!school.trim() || busy} onClick={() => void add()}>{busy ? '正在添加…' : '添加'}</button>
        <button type="button" className="btn btn-text" onClick={() => setOpen(false)}>取消</button>
      </div>
    </div>
  );
}
