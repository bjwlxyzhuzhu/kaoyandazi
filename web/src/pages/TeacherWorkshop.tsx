// 教师 · 导师工坊（M20）：角色卡（草稿 → 测试集对照 → 发布 / 回滚）、资料库、反馈与改进建议、经验库与经验案例
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import { useToast } from '../components/Toast';
import { MentorIcon } from '../components/MentorBadge';
import { getAgent } from '../registry';
import { readFileBase64 } from './StudyShared';

interface Persona { tone: string; style_notes: string[]; boundaries: string[]; negatives: string[]; examples: { q: string; a: string }[]; doc_ids: number[] }
interface EvalResult { ran_at: string; published_version: string; coverage_before: number; coverage_after: number; rows: { question: string; points: string[]; before: string; after: string; covered_before: boolean[]; covered_after: boolean[] }[] }
interface Proposal { id: string; type: string; change: string; reason: string; risk: string; status: string }
interface Detail {
  mentor: { key: string; name: string; duty: string; summary: string };
  published: { version: string; persona: Persona };
  draft: { persona: Persona; change_note: string; eval: EvalResult | null } | null;
  versions: { version: string; change_note: string; published_at: string | null; eval: EvalResult | null }[];
  docs: { id: number; title: string; source: string; level: string; license_note: string; enabled: boolean; chunks: number; in_published: boolean }[];
  evalset: { id: number; question: string; points: string[] }[];
  proposals: { items: Proposal[]; patterns: { issue: string; evidence_count: number; examples: string[] }[]; eval_questions: string[]; at: string | null };
  levels: string[];
}

export function TeacherWorkshop() {
  const [d, setD] = useState<{ note: string; mentors: { key: string; name: string; duty: string; version: string; helpful_rate_7d: number | null; feedback_7d: number; calls_7d: number; pending_proposals: number; doc_count: number; has_draft: boolean }[] } | null>(null);
  const [tab, setTab] = useState<'mentors' | 'insights'>('mentors');
  useEffect(() => { api<NonNullable<typeof d>>('/teacher/mentors').then(setD).catch(() => {}); }, []);
  if (!d) return <p className="muted">正在载入…</p>;
  return (
    <div className="page">
      <h1>导师工坊</h1>
      <p className="muted">{d.note}</p>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'mentors'} className={tab === 'mentors' ? 'active' : ''} onClick={() => setTab('mentors')}>导师</button>
        <button type="button" role="tab" aria-selected={tab === 'insights'} className={tab === 'insights' ? 'active' : ''} onClick={() => setTab('insights')}>经验库与经验案例</button>
      </div>
      {tab === 'mentors' ? (
        <section className="section" style={{ marginTop: 16 }}>
          <table className="score-table small">
            <thead><tr><th>导师</th><th>当前版本</th><th>近7天有帮助率</th><th>近7天回复</th><th>资料</th><th>待审建议</th><th /></tr></thead>
            <tbody>{d.mentors.map((m) => (
              <tr key={m.key}>
                <td><span className="row" style={{ gap: 6 }}><MentorIcon agent={getAgent(m.key)} size={20} />{m.name}｜{m.duty}</span></td>
                <td>{m.version}{m.has_draft && <span className="badge badge-warn" style={{ marginLeft: 6 }}>有草稿</span>}</td>
                <td className="num">{m.helpful_rate_7d === null ? '—' : `${m.helpful_rate_7d}%（${m.feedback_7d}条）`}</td>
                <td className="num">{m.calls_7d}</td><td className="num">{m.doc_count}</td>
                <td className="num">{m.pending_proposals || ''}</td>
                <td><Link to={`/teacher/mentors/${m.key}`}>进入</Link></td>
              </tr>
            ))}</tbody>
          </table>
        </section>
      ) : <Insights />}
    </div>
  );
}

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export function TeacherMentor() {
  const { key } = useParams();
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [tab, setTab] = useState<'card' | 'docs' | 'eval' | 'feedback' | 'versions'>('card');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(async () => setD(await api<Detail>(`/teacher/mentors/${key}`)), [key]);
  useEffect(() => { load().catch((e) => setErr((e as Error).message)); }, [load]);
  const act = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label); setErr('');
    try { await fn(); if (ok) toast(ok); await load(); } catch (e) { setErr(e instanceof ApiError ? e.message : '操作失败。'); } finally { setBusy(''); }
  };
  if (!d) return <p className="muted">{err || '正在载入…'}</p>;
  const p = d.draft?.persona || d.published.persona;
  return (
    <div className="page">
      <p className="muted small"><Link to="/teacher/mentors">← 导师工坊</Link></p>
      <div className="row">
        <MentorIcon agent={getAgent(d.mentor.key)} size={36} />
        <h1 style={{ margin: 0 }}>{d.mentor.name}｜{d.mentor.duty}</h1>
        <span className="badge badge-muted">学生端当前：{d.published.version}</span>
        {d.draft && <span className="badge badge-warn">有未发布的草稿</span>}
        <span className="spacer" />
        {d.draft && <button type="button" className="btn btn-primary" disabled={busy === 'pub'} onClick={() => { const note = window.prompt('这次发布改了什么？（会记进版本记录）', d.draft?.change_note || ''); if (note !== null) void act('pub', () => api(`/teacher/mentors/${key}/publish`, { body: { change_note: note } }), '已发布，学生从下一条消息起使用新版本'); }}>发布草稿</button>}
      </div>
      <p className="muted small">{d.mentor.summary}　草稿怎么改都不影响学生，发布后才生效，可以随时回滚。</p>
      {err && <p className="notice notice-error"><span className="icon">!</span><span>{err}</span></p>}
      <div className="tabs" role="tablist">
        {([['card', '角色卡'], ['docs', `资料（${d.docs.length}）`], ['eval', `测试集（${d.evalset.length}）`], ['feedback', '反馈与改进建议'], ['versions', '版本']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'card' && <CardEditor key={JSON.stringify(p)} persona={p} isDraft={!!d.draft} onSave={(patch) => act('save', () => api(`/teacher/mentors/${key}`, { method: 'PUT', body: patch }), '草稿已保存（还没发布）')} />}
      {tab === 'docs' && <Docs d={d} busy={busy} act={act} />}
      {tab === 'eval' && <Eval d={d} busy={busy} act={act} />}
      {tab === 'feedback' && <Feedback mentorKey={d.mentor.key} d={d} busy={busy} act={act} />}
      {tab === 'versions' && (
        <section className="section" style={{ marginTop: 16 }}>
          <ul className="list">
            {d.versions.slice().reverse().map((v) => (
              <li key={v.version} className="row">
                <strong>{v.version}</strong>
                {v.version === d.published.version && <span className="badge badge-ok">学生端当前</span>}
                <span className="small">{v.change_note}</span>
                <span className="muted small">{v.published_at || ''}</span>
                {v.eval && <span className="muted small">测试集覆盖率 {v.eval.coverage_before}% → {v.eval.coverage_after}%</span>}
                <span className="spacer" />
                {v.version !== d.published.version && <button type="button" className="btn btn-sm" onClick={() => { if (window.confirm(`回滚到 ${v.version}？学生的记忆不受影响。`)) void act('rb', () => api(`/teacher/mentors/${key}/rollback`, { body: { version: v.version } }), `已回滚到 ${v.version}`); }}>回滚到这个版本</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CardEditor({ persona, isDraft, onSave }: { persona: Persona; isDraft: boolean; onSave: (p: Record<string, unknown>) => void }) {
  const [tone, setTone] = useState(persona.tone);
  const [style, setStyle] = useState(persona.style_notes.join('\n'));
  const [bound, setBound] = useState(persona.boundaries.join('\n'));
  const [neg, setNeg] = useState(persona.negatives.join('\n'));
  const [ex, setEx] = useState(persona.examples.map((e) => `学生：${e.q}\n导师：${e.a}`).join('\n\n'));
  const [note, setNote] = useState('');
  const parseEx = () => ex.split(/\n\s*\n/).map((blk) => { const m = blk.match(/学生[:：]([\s\S]+?)\n导师[:：]([\s\S]+)/); return m ? { q: m[1].trim(), a: m[2].trim() } : null; }).filter(Boolean);
  return (
    <section className="section" style={{ marginTop: 16 }}>
      <p className="muted small">{isDraft ? '正在编辑草稿。' : '当前显示的是发布版；保存后会生成一份草稿。'}每行一条。</p>
      <div className="field"><label htmlFor="wk-tone">语气</label><textarea id="wk-tone" className="textarea" rows={2} value={tone} onChange={(e) => setTone(e.target.value)} /></div>
      <div className="grid-2">
        <div className="field"><label htmlFor="wk-style">表达要求</label><textarea id="wk-style" className="textarea" value={style} onChange={(e) => setStyle(e.target.value)} /></div>
        <div className="field"><label htmlFor="wk-bound">职责边界</label><textarea id="wk-bound" className="textarea" value={bound} onChange={(e) => setBound(e.target.value)} /></div>
      </div>
      <div className="field"><label htmlFor="wk-neg">负面清单（不要这样做）</label><textarea id="wk-neg" className="textarea" value={neg} onChange={(e) => setNeg(e.target.value)} /></div>
      <div className="field"><label htmlFor="wk-ex">示例对话（“学生：……”换行“导师：……”，组与组之间空一行）</label><textarea id="wk-ex" className="textarea" rows={6} value={ex} onChange={(e) => setEx(e.target.value)} /></div>
      <div className="row">
        <input className="input" style={{ flex: 1 }} placeholder="修改说明（选填）" value={note} onChange={(e) => setNote(e.target.value)} aria-label="修改说明" />
        <button type="button" className="btn btn-primary" onClick={() => onSave({ tone, style_notes: lines(style), boundaries: lines(bound), negatives: lines(neg), examples: parseEx(), change_note: note })}>保存草稿</button>
      </div>
    </section>
  );
}

type Act = (label: string, fn: () => Promise<unknown>, ok?: string) => Promise<void>;

function Docs({ d, busy, act }: { d: Detail; busy: string; act: Act }) {
  const [f, setF] = useState({ title: '', source: '', level: d.levels[0], license_note: '', text: '', url: '' });
  const [file, setFile] = useState<File | null>(null);
  const [ok, setOk] = useState(false);
  const upload = () => act('up', async () => {
    const body: Record<string, unknown> = { ...f, confirm_rules: ok };
    if (file) { body.data = await readFileBase64(file); body.filename = file.name; delete body.text; }
    if (!f.url) delete body.url;
    await api(`/teacher/mentors/${d.mentor.key}/docs`, { body });
    setF({ ...f, title: '', text: '', url: '' }); setFile(null);
  }, '资料已加入草稿，发布后学生才检索得到');
  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <h2>上传资料</h2>
        <p className="muted small">招生简章与政策文件、上岸经验访谈（经本人同意并匿名）、导师招生讲座稿、学习方法资料、教师自编复试题。平台按约500字切片建索引，回答前检索最相关的3片并标注来源。</p>
        <div className="grid-2">
          <div className="field"><label htmlFor="d-title">资料名称</label><input id="d-title" className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></div>
          <div className="field"><label htmlFor="d-src">来源</label><input id="d-src" className="input" value={f.source} placeholder="例如：教育部官网" onChange={(e) => setF({ ...f, source: e.target.value })} /></div>
          <div className="field"><label htmlFor="d-level">证据等级</label><select id="d-level" className="select" value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })}>{d.levels.map((l) => <option key={l}>{l}</option>)}</select></div>
          <div className="field"><label htmlFor="d-lic">来源与授权说明（必填）</label><input id="d-lic" className="input" value={f.license_note} placeholder="例如：公开文件 / 经本人书面同意，已匿名" onChange={(e) => setF({ ...f, license_note: e.target.value })} /></div>
        </div>
        <div className="field"><label htmlFor="d-file">文件（PDF / Word / TXT / Markdown）</label><input id="d-file" type="file" className="input" accept=".pdf,.docx,.txt,.md" onChange={(e) => setFile(e.target.files?.[0] || null)} /></div>
        <div className="field"><label htmlFor="d-url">或网页链接（只读这一页）</label><input id="d-url" className="input" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></div>
        <div className="field"><label htmlFor="d-text">或直接粘贴文字</label><textarea id="d-text" className="textarea" rows={5} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} /></div>
        <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /><span>我确认：不是未公开试题、不是受版权保护的完整书籍、不含学生个人信息。</span></label>
        <button type="button" className="btn btn-primary" disabled={busy === 'up' || !f.title || !f.license_note} onClick={() => void upload()}>上传到草稿</button>
      </section>
      <section className="section">
        <h2>已有资料</h2>
        <ul className="list">{d.docs.map((x) => (
          <li key={x.id} className="row">
            <strong>{x.title}</strong><span className="badge badge-muted">{x.level || '未标注'}</span>
            <span className="muted small">{x.source}｜{x.license_note}｜{x.chunks} 片</span>
            <span className={`badge ${x.in_published ? 'badge-ok' : 'badge-warn'}`}>{x.in_published ? '已发布' : '仅草稿'}</span>
            {!x.enabled && <span className="badge badge-pause">已禁用</span>}
            <span className="spacer" />
            <button type="button" className="btn btn-text btn-sm" onClick={() => void act('en', () => api(`/teacher/mentors/${d.mentor.key}/docs/${x.id}`, { method: 'PUT', body: { enabled: !x.enabled } }), x.enabled ? '已禁用，立即不再被检索' : '已启用')}>{x.enabled ? '禁用' : '启用'}</button>
          </li>
        ))}{!d.docs.length && <li className="muted">还没有资料。</li>}</ul>
      </section>
    </>
  );
}

function Eval({ d, busy, act }: { d: Detail; busy: string; act: Act }) {
  const [q, setQ] = useState('');
  const [pts, setPts] = useState('');
  const [res, setRes] = useState<EvalResult | null>(d.draft?.eval || null);
  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <h2>测试问题（10—30个）</h2>
        <ul className="list">{d.evalset.map((e) => (
          <li key={e.id} className="row"><span style={{ flex: 1 }}>{e.question}<span className="muted small" style={{ display: 'block' }}>应答要点：{e.points.join('；')}</span></span>
            <button type="button" className="btn btn-text btn-sm" onClick={() => void act('del', () => api(`/teacher/mentors/${d.mentor.key}/evalset`, { body: { delete_id: e.id } }))}>删除</button></li>
        ))}</ul>
        <div className="grid-2">
          <input className="input" placeholder="测试问题" value={q} onChange={(e) => setQ(e.target.value)} aria-label="测试问题" />
          <input className="input" placeholder="应答要点，用分号隔开" value={pts} onChange={(e) => setPts(e.target.value)} aria-label="应答要点" />
        </div>
        <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} disabled={!q || !pts} onClick={() => void act('add', () => api(`/teacher/mentors/${d.mentor.key}/evalset`, { body: { question: q, points: pts } }).then(() => { setQ(''); setPts(''); }))}>添加</button>
      </section>
      <section className="section">
        <div className="row"><h2 style={{ margin: 0 }}>回归测试：发布版 vs 草稿</h2><span className="spacer" />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'eval' || !d.draft || !d.evalset.length} onClick={() => void act('eval', async () => setRes(await api<EvalResult>(`/teacher/mentors/${d.mentor.key}/eval`, { body: {} })), '测试完成')}>{busy === 'eval' ? '正在逐题回答…' : '一键运行'}</button></div>
        {!d.draft && <p className="muted small">没有草稿时不需要对照。</p>}
        {res && (
          <>
            <p>要点覆盖率：发布版（{res.published_version}）<strong>{res.coverage_before}%</strong> → 草稿 <strong>{res.coverage_after}%</strong>　<span className="muted small">{res.ran_at}</span></p>
            {res.rows.map((r, i) => (
              <div key={i} className="card">
                <strong>{r.question}</strong>
                <p className="small muted">要点：{r.points.map((pt, k) => `${pt}（${r.covered_before[k] ? '✓' : '✗'}→${r.covered_after[k] ? '✓' : '✗'}）`).join('；')}</p>
                <div className="lab-compare">
                  <div><p className="label">发布版</p><p className="small" style={{ whiteSpace: 'pre-wrap' }}>{r.before}</p></div>
                  <div><p className="label">草稿</p><p className="small" style={{ whiteSpace: 'pre-wrap' }}>{r.after}</p></div>
                </div>
              </div>
            ))}
            <p className="muted small">覆盖率只是参考，是否发布由您判断。</p>
          </>
        )}
      </section>
    </>
  );
}

function Feedback({ mentorKey, d, busy, act }: { mentorKey: string; d: Detail; busy: string; act: Act }) {
  const [fb, setFb] = useState<{ summary: { total: number; helpful: number; unhelpful: number; tags: Record<string, number> }; items: { id: number; rating: string; tags: string[]; comment: string; reply: string; created_at: string }[]; note: string } | null>(null);
  useEffect(() => { api<NonNullable<typeof fb>>(`/teacher/mentors/${mentorKey}/feedback`).then(setFb).catch(() => {}); }, [mentorKey]);
  const pr = d.proposals;
  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <h2>学生反馈（近30天）</h2>
        {fb && <>
          <p className="muted small">{fb.note}</p>
          <p>有帮助 {fb.summary.helpful}，没帮助 {fb.summary.unhelpful}　{Object.entries(fb.summary.tags).map(([k, v]) => `${k} ${v}`).join('　')}</p>
          <ul className="list small">{fb.items.slice(0, 20).map((x) => (
            <li key={x.id}><span className={`badge ${x.rating === 'helpful' ? 'badge-ok' : 'badge-warn'}`}>{x.rating === 'helpful' ? '有帮助' : `没帮助：${x.tags.join('、') || '未选原因'}`}</span> <span className="muted">{x.created_at.slice(5, 16)}</span>{x.reply && <p style={{ margin: '4px 0 0' }}>被评价的回复：{x.reply.slice(0, 160)}…</p>}</li>
          ))}</ul>
        </>}
        <button type="button" className="btn btn-primary" disabled={busy === 'distill'} onClick={() => void act('distill', () => api(`/teacher/mentors/${mentorKey}/distill`, { body: {} }), '已生成改进建议')}>{busy === 'distill' ? '正在分析…' : '生成改进建议'}</button>
      </section>
      {pr.at && (
        <section className="section">
          <h2>改进建议 <span className="muted small">{pr.at}</span></h2>
          {pr.patterns.map((x, i) => <p key={i}><strong>{x.issue}</strong>（{x.evidence_count} 条反馈）</p>)}
          <ul className="list">{pr.items.map((x) => (
            <li key={x.id}>
              <div className="row"><span className="badge badge-muted">{x.type}</span><span style={{ flex: 1 }}>{x.change}</span>
                {x.status === 'pending' ? <>
                  <button type="button" className="btn btn-sm" onClick={() => void act('ad', () => api(`/teacher/mentors/${mentorKey}/proposals/${x.id}`, { body: { action: 'adopt' } }), '已采纳，写进了草稿')}>采纳</button>
                  <button type="button" className="btn btn-text btn-sm" onClick={() => void act('rj', () => api(`/teacher/mentors/${mentorKey}/proposals/${x.id}`, { body: { action: 'reject' } }))}>拒绝</button>
                </> : <span className="badge badge-muted">{x.status === 'adopted' ? '已采纳' : '已拒绝'}</span>}
              </div>
              <p className="muted small" style={{ margin: '4px 0 0' }}>理由：{x.reason}；可能的副作用：{x.risk}</p>
            </li>
          ))}</ul>
          {!!pr.eval_questions.length && <p className="small">建议加入测试集：{pr.eval_questions.join('；')}</p>}
        </section>
      )}
    </>
  );
}

function Insights() {
  const toast = useToast();
  const [ins, setIns] = useState<{ items: { id: number; mentor: string; insight: string; evidence_count: number; status: string }[]; note: string } | null>(null);
  const [cases, setCases] = useState<{ id: number; title: string; content: string; consent_note: string; anonymized: boolean; approved: boolean }[]>([]);
  const [nc, setNc] = useState({ title: '', content: '', consent_note: '', anonymized: false });
  const load = useCallback(async () => {
    setIns(await api('/teacher/insights'));
    setCases((await api<{ items: typeof cases }>('/teacher/experience-cases')).items);
  }, []);
  useEffect(() => { void load(); }, [load]);
  const go = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok); await load(); } catch (e) { toast(e instanceof ApiError ? e.message : '操作失败', 'error'); } };
  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <div className="row"><h2 style={{ margin: 0 }}>经验库</h2><span className="spacer" /><button type="button" className="btn btn-sm" onClick={() => void go(() => api('/teacher/insights/generate', { body: {} }), '已汇总')}>从匿名数据汇总一次</button></div>
        <p className="muted small">{ins?.note}</p>
        <ul className="list">{ins?.items.map((x) => (
          <li key={x.id} className="row"><span className="badge badge-muted">{x.mentor}</span><span style={{ flex: 1 }}>{x.insight}</span>
            <span className={`badge ${x.status === 'approved' ? 'badge-ok' : x.status === 'rejected' ? 'badge-muted' : 'badge-warn'}`}>{{ approved: '已批准', rejected: '已拒绝', pending: '待审' }[x.status]}</span>
            {x.status !== 'approved' && <button type="button" className="btn btn-sm" onClick={() => void go(() => api('/teacher/insights', { method: 'PUT', body: { id: x.id, status: 'approved' } }), '已批准')}>批准</button>}
            {x.status !== 'rejected' && <button type="button" className="btn btn-text btn-sm" onClick={() => void go(() => api('/teacher/insights', { method: 'PUT', body: { id: x.id, status: 'rejected' } }), '已拒绝')}>拒绝</button>}
          </li>
        ))}{!ins?.items.length && <li className="muted">还没有。</li>}</ul>
      </section>
      <section className="section">
        <h2>渡舟的经验案例</h2>
        <p className="muted small">上岸经验访谈，必须经本人同意并匿名；批准后渡舟才会引用，并说明“这是一位学长/学姐的经历，不一定适用于你”。</p>
        <ul className="list">{cases.map((c) => (
          <li key={c.id}><div className="row"><strong>{c.title}</strong>{c.approved ? <span className="badge badge-ok">已批准</span> : <span className="badge badge-warn">待审</span>}<span className="spacer" />
            {!c.approved && <button type="button" className="btn btn-sm" onClick={() => void go(() => api('/teacher/experience-cases', { method: 'PUT', body: { id: c.id, approve: true } }), '已批准')}>批准</button>}</div>
            <p className="small" style={{ margin: '4px 0' }}>{c.content}</p><p className="muted small" style={{ margin: 0 }}>同意说明：{c.consent_note || '（未填）'}｜{c.anonymized ? '已匿名' : '未确认匿名'}</p></li>
        ))}</ul>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <input className="input" placeholder="标题" value={nc.title} onChange={(e) => setNc({ ...nc, title: e.target.value })} aria-label="案例标题" />
          <input className="input" placeholder="同意说明，例如：经本人书面同意，2026-09" value={nc.consent_note} onChange={(e) => setNc({ ...nc, consent_note: e.target.value })} aria-label="同意说明" />
        </div>
        <textarea className="textarea" style={{ marginTop: 8 }} placeholder="经历内容（不要写姓名、学号、联系方式）" value={nc.content} onChange={(e) => setNc({ ...nc, content: e.target.value })} aria-label="案例内容" />
        <label className="check"><input type="checkbox" checked={nc.anonymized} onChange={(e) => setNc({ ...nc, anonymized: e.target.checked })} /><span>内容已匿名</span></label>
        <button type="button" className="btn btn-sm" disabled={!nc.title || !nc.content} onClick={() => void go(() => api('/teacher/experience-cases', { body: nc }).then(() => setNc({ title: '', content: '', consent_note: '', anonymized: false })), '已保存为待审')}>保存</button>
      </section>
    </>
  );
}
