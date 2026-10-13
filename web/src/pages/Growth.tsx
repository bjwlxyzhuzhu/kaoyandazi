// 成长档案（M14 结课考核中心，学生视图；同时是第11站“结课”的工作页）
// 档案袋（五项与缺项）· 行动方案（汇编 + 我的反思）· AI使用与核验说明 · 互评 · 问卷
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { ActionPlanView, PeerAssigned, PeerReceived, PortfolioResp, SurveyCompare, SurveyDef } from '../api/types2';
import { useToast } from '../components/Toast';
import { SurveyForm } from '../components/SurveyForm';

type Tab = 'portfolio' | 'plan' | 'ai' | 'peer' | 'survey';
const STATUS: Record<string, { text: string; cls: string }> = {
  done: { text: '已完成', cls: 'badge-ok' },
  partial: { text: '进行中', cls: 'badge-warn' },
  missing: { text: '还没开始', cls: 'badge-pause' },
};
const ITEM_ROUTE: Record<string, string> = { schools: '/road/4', plan: '/road/6', kb: '/road/7', classroom: '/class' };
const len = (s: string) => [...s.replace(/\s/g, '')].length;

export default function Growth({ asStation = false }: { asStation?: boolean }) {
  const [tab, setTab] = useState<Tab>('portfolio');
  const [error, setError] = useState('');
  return (
    <div className="page">
      {asStation && <p className="muted small"><Link to="/road">← 我的路</Link></p>}
      <h1>{asStation ? '结课' : '成长档案'}</h1>
      <p className="muted">我准备得怎样？这里是结课考核的五项、行动方案、AI使用与核验说明、互评和问卷。平台指标只是参考，最终分数由老师决定。</p>
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}
      <div className="tabs" role="tablist">
        {([['portfolio', '考核档案袋'], ['plan', '行动方案'], ['ai', 'AI使用与核验说明'], ['peer', '互评'], ['survey', '问卷与变化']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => { setTab(k); setError(''); }}>{label}</button>
        ))}
      </div>
      {tab === 'portfolio' && <PortfolioTab onError={setError} goPlan={() => setTab('plan')} />}
      {tab === 'plan' && <PlanTab onError={setError} />}
      {tab === 'ai' && <AiTab onError={setError} />}
      {tab === 'peer' && <PeerTab onError={setError} />}
      {tab === 'survey' && <SurveyTab />}
    </div>
  );
}

function PortfolioTab({ onError, goPlan }: { onError: (s: string) => void; goPlan: () => void }) {
  const [pf, setPf] = useState<PortfolioResp | null>(null);
  useEffect(() => { api<PortfolioResp>('/assess/portfolio').then(setPf).catch((e) => onError((e as Error).message)); }, [onError]);
  if (!pf) return <p className="muted" style={{ marginTop: 16 }}>正在载入…</p>;
  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        {pf.missing_count === 0
          ? <p className="notice notice-ok" style={{ margin: 0 }}><span className="icon">✓</span><span>五项都完成了。</span></p>
          : (
            <div className="notice notice-warn" style={{ margin: 0 }}><span className="icon">!</span>
              <div><strong>还缺 {pf.missing_count} 项</strong><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{pf.summary.map((s) => <li key={s}>{s}</li>)}</ul></div>
            </div>
          )}
        <p className="muted small" style={{ marginBottom: 0 }}>{pf.note}</p>
      </section>
      {pf.items.map((it) => {
        const g = pf.grades.find((x) => x.item === it.key);
        return (
          <section key={it.key} className="section">
            <div className="row">
              <h2 style={{ margin: 0 }}>{it.name}</h2>
              <span className="badge badge-muted">{it.group} {it.weight}%</span>
              <span className={`badge ${STATUS[it.status].cls}`}>{STATUS[it.status].text}</span>
              <span className="spacer" />
              {g && g.score !== null && <span className="badge badge-ok">老师评分 {g.score}</span>}
              {ITEM_ROUTE[it.key] && <Link className="btn btn-sm" to={ITEM_ROUTE[it.key]}>去完善</Link>}
              {it.key === 'final' && <button type="button" className="btn btn-sm" onClick={goPlan}>去写行动方案</button>}
            </div>
            <p className="small" style={{ marginBottom: 4 }}>产物：{it.products.join('；')}</p>
            <p className="small muted" style={{ marginTop: 0 }}>
              平台指标：{Object.entries(it.metrics).map(([k, v]) => `${k} ${typeof v === 'object' ? (Object.entries(v).map(([a, b]) => `${a}${b}`).join('、') || '—') : v}`).join('；')}
            </p>
            {!!it.missing.length && <ul className="small" style={{ color: 'var(--c-warn)', margin: '4px 0' }}>{it.missing.map((m) => <li key={m}>{m}</li>)}</ul>}
            {g?.comment && <p className="small">老师的评语：{g.comment}</p>}
            <details>
              <summary className="small">评分量规</summary>
              <table className="score-table small">
                <tbody>{Object.entries(it.levels).map(([lv, txt]) => <tr key={lv}><th>{lv}</th><td>{txt}</td></tr>)}</tbody>
              </table>
              <p className="muted small">平台参考指标：{it.indicators}</p>
            </details>
          </section>
        );
      })}
    </>
  );
}

function PlanTab({ onError }: { onError: (s: string) => void }) {
  const toast = useToast();
  const [v, setV] = useState<ActionPlanView | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => { const r = await api<ActionPlanView>('/assess/plan'); setV(r); setEdit(r.reflections); }, []);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  const act = async (label: string, fn: () => Promise<ActionPlanView>, ok?: string) => {
    setBusy(label); onError('');
    try { const r = await fn(); setV(r); setEdit((e) => ({ ...r.reflections, ...Object.fromEntries(Object.entries(e).filter(([k]) => !(k in r.reflections) && e[k])) })); if (ok) toast(ok); }
    catch (e) { onError(e instanceof ApiError ? e.message : '操作失败。'); } finally { setBusy(''); }
  };

  if (!v) return <p className="muted" style={{ marginTop: 16 }}>正在载入…</p>;
  const done = v.sections.filter((s) => (v.reflections[s.key] || '').trim()).length;
  const locked = !!v.submitted_at;

  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>个人考研（升学）行动方案</h2>
          <span className="spacer" />
          {!locked && <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'compile'} onClick={() => void act('compile', () => api('/assess/plan/compile', { body: {} }), '已从你的记录里重新汇编，反思原样保留')}>{v.draft ? '用最新记录重新汇编' : '一键汇编'}</button>}
          {v.draft && <><a className="btn btn-sm" href="/api/assess/plan/export?format=docx">下载 Word</a><a className="btn btn-sm" href="/api/assess/plan/export" target="_blank" rel="noopener">打印 / 存 PDF</a></>}
        </div>
        <p className="muted small">“汇编内容”由平台从你的画像、路径、院校表、方案与复盘、知识库、成果项目和复试准备里整理，<strong>不调用 AI</strong>。每一部分的“我的反思”必须你自己写（至少 {v.reflection_min} 字），平台和 AI 都不能写入。</p>
        {locked && <p className="notice notice-ok"><span className="icon">✓</span><span>已于 {v.submitted_at} 提交，不能再修改。</span></p>}
        {v.draft && <p className="small">反思进度：{done} / {v.sections.length}</p>}
      </section>
      {v.draft?.sections.map((s) => {
        const text = edit[s.key] ?? '';
        const saved = v.reflections[s.key] || '';
        return (
          <section key={s.key} className="section">
            <h3 style={{ marginTop: 0 }}>{s.title}</h3>
            <p className="label">汇编内容</p>
            <pre className="twin-preview">{s.content}</pre>
            <label className="label" htmlFor={`refl-${s.key}`}>我的反思</label>
            {locked ? <p style={{ whiteSpace: 'pre-wrap' }}>{saved}</p> : (
              <>
                <textarea id={`refl-${s.key}`} className="textarea" rows={3} maxLength={3000} value={text} placeholder="做得怎样？哪里没想到？接下来怎么改？" onChange={(e) => setEdit((x) => ({ ...x, [s.key]: e.target.value }))} />
                <div className="row">
                  <span className="muted small">{len(text)} 字{saved && saved === text ? ' · 已保存' : ''}</span>
                  <span className="spacer" />
                  <button type="button" className="btn btn-sm" disabled={busy === s.key || text === saved} onClick={() => void act(s.key, () => api('/assess/plan/reflections', { method: 'PUT', body: { section: s.key, text } }), '反思已保存')}>保存这段反思</button>
                </div>
              </>
            )}
          </section>
        );
      })}
      {v.draft && !locked && (
        <section className="section">
          <h2>提交终结性材料</h2>
          <p className="small">提交前请确认：七个部分都写了“我的反思”，“AI使用与核验说明”写了补充说明。提交后不能再改，老师会据此评分。</p>
          <button type="button" className="btn btn-primary" disabled={busy === 'submit'} onClick={() => { if (window.confirm('提交后不能再修改，确定提交吗？')) void act('submit', () => api('/assess/submit', { body: {} }), '已提交'); }}>提交行动方案与AI使用说明</button>
        </section>
      )}
    </>
  );
}

function AiTab({ onError }: { onError: (s: string) => void }) {
  const toast = useToast();
  const [v, setV] = useState<ActionPlanView['ai_statement'] | null>(null);
  const [note, setNote] = useState('');
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    Promise.all([api<ActionPlanView['ai_statement']>('/assess/ai-statement'), api<ActionPlanView>('/assess/plan')])
      .then(([a, p]) => { setV(a); setNote(a.note); setSubmitted(!!p.submitted_at); })
      .catch((e) => onError((e as Error).message));
  }, [onError]);
  if (!v) return <p className="muted" style={{ marginTop: 16 }}>正在载入…</p>;
  const s = v.stats;
  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <h2>使用统计</h2>
        <p className="muted small">数字全部来自平台的调用日志（每一次 AI 调用都留了痕），不是估计。被平台边界拦下、没有调用模型的请求不计入。</p>
        <div className="stat-row">
          <div className="stat"><span className="num">{s.total_calls}</span><span className="lbl">AI 调用次数</span></div>
          <div className="stat"><span className="num">{s.total_tokens}</span><span className="lbl">token 用量</span></div>
          <div className="stat"><span className="num">{s.verification.school_facts_verified}/{s.verification.school_facts}</span><span className="lbl">院校数据已核验</span></div>
          <div className="stat"><span className="num">{s.adoption.modify_rate === null ? '—' : `${s.adoption.modify_rate}%`}</span><span className="lbl">AI产物修改率</span></div>
        </div>
        <table className="score-table small" style={{ marginTop: 16 }}>
          <thead><tr><th>用途</th><th>次数</th><th>平台 Key / 自己的 Key</th><th>token</th><th>时间</th></tr></thead>
          <tbody>{s.categories.map((c) => <tr key={c.category}><td>{c.category}</td><td className="num">{c.calls}</td><td>{c.platform} / {c.own}</td><td className="num">{c.tokens}</td><td>{c.first_at.slice(5, 10)} — {c.last_at.slice(5, 10)}</td></tr>)}</tbody>
        </table>
      </section>
      <section className="section">
        <h2>说明草稿</h2>
        <pre className="twin-preview">{v.draft}</pre>
        <label className="label" htmlFor="ai-note">我的补充说明（至少 {v.note_min} 字）：你是怎么用 AI 的、改过哪些、怎么核验的</label>
        {submitted ? <p style={{ whiteSpace: 'pre-wrap' }}>{v.note}</p> : (
          <>
            <textarea id="ai-note" className="textarea" rows={4} maxLength={3000} value={note} onChange={(e) => setNote(e.target.value)} />
            <div className="row">
              <span className="muted small">{len(note)} 字</span>
              <span className="spacer" />
              <button type="button" className="btn btn-sm" disabled={note === v.note} onClick={async () => {
                try { const r = await api<ActionPlanView['ai_statement']>('/assess/ai-statement', { method: 'PUT', body: { note } }); setV(r); toast('已保存'); } catch (e) { onError(e instanceof ApiError ? e.message : '保存失败。'); }
              }}>保存补充说明</button>
            </div>
          </>
        )}
      </section>
    </>
  );
}

function PeerTab({ onError }: { onError: (s: string) => void }) {
  const toast = useToast();
  const [a, setA] = useState<PeerAssigned | null>(null);
  const [rcv, setRcv] = useState<PeerReceived | null>(null);
  const [form, setForm] = useState<Record<number, { rubric: Record<string, number>; comment: string }>>({});
  const load = useCallback(async () => {
    const [x, y] = await Promise.all([api<PeerAssigned>('/peer/assigned'), api<PeerReceived>('/peer/received')]);
    setA(x); setRcv(y);
  }, []);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);
  if (!a || !rcv) return <p className="muted" style={{ marginTop: 16 }}>正在载入…</p>;
  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <h2>我要评的作业（{a.items.filter((x) => x.done).length}/{a.items.length}）</h2>
        <p className="muted small">互评双向匿名：你看不到作者是谁，作者也看不到是你评的。按量规点选，再写一句具体建议。互评完成率计入“课堂任务与互评（10%）”。</p>
        {!a.items.length && <p className="muted">老师还没有开启互评，或者这次没有分给你。</p>}
        {a.items.map((it) => {
          const f = form[it.id] || { rubric: it.rubric || {}, comment: it.comment };
          return (
            <div key={it.id} className="card">
              <div className="row"><strong>{it.anonymous_label}</strong><span className="muted small">第{it.chapter}章 · {it.task_title}</span><span className="spacer" />{it.done && <span className="badge badge-ok">已评</span>}</div>
              <ul className="small">{it.fields.map((fl) => <li key={fl.label}><span className="muted">{fl.label}：</span>{fl.value || '（未填）'}</li>)}</ul>
              {a.criteria.map((c) => (
                <div key={c.key} className="row small" style={{ marginBottom: 4 }}>
                  <span style={{ minWidth: 72 }}>{c.label}</span>
                  <div className="chips" role="radiogroup" aria-label={c.label}>
                    {Array.from({ length: a.max - a.min + 1 }, (_, i) => a.min + i).map((n) => (
                      <button key={n} type="button" className="chip" role="radio" aria-checked={f.rubric[c.key] === n} disabled={it.done}
                        onClick={() => setForm((x) => ({ ...x, [it.id]: { ...f, rubric: { ...f.rubric, [c.key]: n } } }))}>{n}</button>
                    ))}
                  </div>
                </div>
              ))}
              {it.done ? <p className="small">我的建议：{it.comment}</p> : (
                <div className="row">
                  <input className="input" style={{ flex: 1 }} maxLength={300} value={f.comment} placeholder="一句具体的建议" aria-label="建议"
                    onChange={(e) => setForm((x) => ({ ...x, [it.id]: { ...f, comment: e.target.value } }))} />
                  <button type="button" className="btn btn-primary btn-sm" onClick={async () => {
                    try { await api(`/peer/${it.id}`, { body: f }); toast('互评已提交'); await load(); } catch (e) { onError(e instanceof ApiError ? e.message : '提交失败。'); }
                  }}>提交</button>
                </div>
              )}
            </div>
          );
        })}
      </section>
      <section className="section">
        <h2>同学对我的评价</h2>
        {!rcv.items.length && <p className="muted">还没有收到互评。</p>}
        {rcv.items.map((x) => (
          <div key={`${x.chapter}-${x.task_title}`} className="card">
            <div className="row"><strong>第{x.chapter}章 · {x.task_title}</strong><span className="muted small">收到 {x.received}/{x.assigned} 份</span></div>
            <p className="small">{Object.entries(x.averages).map(([k, v]) => `${k} ${v ?? '—'}`).join('　')}</p>
            <ul className="small">{x.comments.map((c, i) => <li key={i}>{c}</li>)}</ul>
          </div>
        ))}
      </section>
    </>
  );
}

function SurveyTab() {
  const [cmp, setCmp] = useState<SurveyCompare | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [def, setDef] = useState<SurveyDef | null>(null);
  const load = useCallback(async () => setCmp(await api<SurveyCompare>('/surveys/compare')), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (kind) api<SurveyDef>(`/surveys/${kind}`).then(setDef).catch(() => {}); else setDef(null); }, [kind]);
  if (!cmp) return <p className="muted" style={{ marginTop: 16 }}>正在载入…</p>;
  const names: Record<string, string> = { mid: '中测（第4周）', post: '后测（第8周）', satisfaction: '满意度（第8周）' };
  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <h2>问卷</h2>
        <div className="row">
          {Object.entries(names).map(([k, label]) => (
            <button key={k} type="button" className="btn btn-sm" onClick={() => setKind(k)}>
              {label}{cmp.done[k as keyof SurveyCompare['done']] ? '（已填，可以再填一次）' : ''}
            </button>
          ))}
        </div>
        {def && kind && (
          <div className="kb-form">
            <h3 style={{ marginTop: 0 }}>{def.title}</h3>
            <p className="muted small">{def.desc}</p>
            <SurveyForm def={def} onSubmitted={() => { setKind(null); void load(); }} />
          </div>
        )}
      </section>
      <section className="section">
        <h2>我和起点相比</h2>
        <p className="muted small">{cmp.note}（1 非常不同意 — 5 非常同意）</p>
        <table className="score-table small">
          <thead><tr><th>能力自评</th><th>前测</th><th>中测</th><th>后测</th></tr></thead>
          <tbody>{cmp.items.map((x) => (
            <tr key={x.key}><td>{x.label}</td><td className="num">{x.pre ?? '—'}</td><td className="num">{x.mid ?? '—'}</td>
              <td className="num">{x.post ?? '—'}{x.pre !== null && x.post !== null && x.post !== x.pre && <span className={x.post > x.pre ? 'badge badge-ok' : 'badge badge-muted'} style={{ marginLeft: 6 }}>{x.post > x.pre ? `+${x.post - x.pre}` : x.post - x.pre}</span>}</td></tr>
          ))}</tbody>
        </table>
      </section>
    </>
  );
}
