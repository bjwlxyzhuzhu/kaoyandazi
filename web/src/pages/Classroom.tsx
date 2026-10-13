// M2 课堂：第1章课件（投屏模式 + 方向键翻页 + N 键显示教师备注）与课堂任务
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { ChapterMeta, ChapterTask, CoursewarePage } from '../api/types2';
import { useToast } from '../components/Toast';
import { useAuth } from '../auth';

interface ChapterResp { courseware: { chapter: number; title: string; subtitle: string; pages: CoursewarePage[] }; tasks: ChapterTask[] }

export default function Classroom() {
  const toast = useToast();
  const { me } = useAuth();
  const [meta, setMeta] = useState<ChapterMeta[]>([]);
  const chapter = 1;
  const [data, setData] = useState<ChapterResp | null>(null);
  const [locked, setLocked] = useState('');
  const [error, setError] = useState('');
  const [printing, setPrinting] = useState(false);
  const [idx, setIdx] = useState(0);
  const [showNote, setShowNote] = useState(false);
  const [tab, setTab] = useState<'slides' | 'tasks' | 'roster'>('slides');
  const isTeacher = me?.role === 'teacher';

  const loadMeta = useCallback(async () => {
    const url = isTeacher ? '/teacher/chapters' : '/chapters';
    const r = await api<{ chapters: ChapterMeta[] }>(url);
    setMeta(r.chapters);
    return r.chapters;
  }, [isTeacher]);

  const loadChapter = useCallback(async (no: number) => {
    setError(''); setLocked('');
    try {
      const url = isTeacher ? `/teacher/chapters/${no}` : `/chapters/${no}`;
      const r = await api<ChapterResp>(url);
      setData(r);
      setIdx(0);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'LOCKED' || e.code === 'NO_CHAPTER')) {
        setLocked(e.message);
        setData(null);
      } else setError(e instanceof ApiError ? e.message : '载入失败。');
    }
  }, [isTeacher]);

  useEffect(() => { loadMeta().then(() => loadChapter(1)).catch((e) => setError((e as Error).message)); }, [loadMeta, loadChapter]);

  // 投屏模式：方向键翻页，N 显示/隐藏教师备注，Esc 退出
  useEffect(() => {
    if (!printing) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); setIdx((i) => Math.min(pages.length - 1, i + 1)); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
      else if (e.key === 'n' || e.key === 'N') setShowNote((v) => !v);
      else if (e.key === 'Escape') setPrinting(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pages = data?.courseware.pages || [];
  const page = pages[idx];

  const unlock = async () => {
    try {
      const r = await api<{ chapters: ChapterMeta[] }>(`/teacher/chapters/${chapter}/unlock`, { body: {} });
      setMeta(r.chapters);
      toast(`第${chapter}章已解锁`);
    } catch (e) { setError(e instanceof ApiError ? e.message : '解锁失败。'); }
  };

  if (isTeacher && printing) {
    return (
      <div className="projector">
        <div className="proj-bar">
          <span>第{data?.courseware.chapter}章 · {idx + 1}/{pages.length}</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={() => setShowNote((v) => !v)}>{showNote ? '隐藏备注 (N)' : '显示备注 (N)'}</button>
          <button type="button" className="btn btn-sm" onClick={() => setPrinting(false)}>退出投屏 (Esc)</button>
        </div>
        <div className="proj-stage">{page && <Slide page={page} />}</div>
        {showNote && page?.note && <div className="proj-note"><strong>教师备注：</strong>{page.note}</div>}
        <div className="proj-nav">
          <button type="button" className="btn" disabled={idx === 0} onClick={() => setIdx((i) => i - 1)}>← 上一页</button>
          <span className="muted small">← → 翻页，N 备注，Esc 退出</span>
          <button type="button" className="btn" disabled={idx >= pages.length - 1} onClick={() => setIdx((i) => i + 1)}>下一页 →</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="row">
        <div>
          <h1>课堂・第1章</h1>
          <p className="muted" style={{ margin: 0 }}>考研全流程认知与AI使用边界</p>
        </div>
        <span className="spacer" />
        {isTeacher && <button type="button" className="btn btn-primary" onClick={() => setPrinting(true)} disabled={!pages.length}>投屏模式</button>}
        {isTeacher && !meta.find((m) => m.chapter === chapter)?.unlocked && (
          <button type="button" className="btn" onClick={() => void unlock()}>解锁这一章</button>
        )}
      </header>

      <nav className="tabs" aria-label="课堂分区">
        <button type="button" className={tab === 'slides' ? 'active' : ''} onClick={() => setTab('slides')}>课件</button>
        {!isTeacher && <button type="button" className={tab === 'tasks' ? 'active' : ''} onClick={() => setTab('tasks')}>课堂任务</button>}
        {isTeacher && <button type="button" className={tab === 'roster' ? 'active' : ''} onClick={() => setTab('roster')}>提交情况</button>}
      </nav>

      {tab === 'roster' && isTeacher && <Roster chapter={chapter} />}

      {error && <div className="notice notice-error" role="alert" style={{ margin: '16px 0' }}><span className="icon">!</span><span>{error}</span></div>}

      {locked && (
        <div className="notice notice-warn" role="status" style={{ margin: '16px 0' }}>
          <span className="icon">!</span><span>{locked}</span>
        </div>
      )}

      {tab === 'slides' && data && (
        <>
          <div className="row" style={{ margin: '16px 0' }}>
            <button type="button" className="btn btn-sm" disabled={idx === 0} onClick={() => setIdx((i) => i - 1)}>← 上一页</button>
            <span className="muted small">{idx + 1} / {pages.length}</span>
            <button type="button" className="btn btn-sm" disabled={idx >= pages.length - 1} onClick={() => setIdx((i) => i + 1)}>下一页 →</button>
            <span className="spacer" />
            {isTeacher && <span className="muted small">教师视图：每页下方显示备注</span>}
          </div>
          <div className="slide-wrap">{page && <Slide page={page} />}</div>
          {isTeacher && page?.note && <div className="card" style={{ background: 'var(--c-warn-bg, #FFF6E5)' }}><strong>教师备注：</strong>{page.note}</div>}
        </>
      )}

      {tab === 'tasks' && data && (
        <div style={{ marginTop: 16 }}>
          {data.tasks.map((t) => (
            <TaskCard key={t.id} chapter={data.courseware.chapter} task={t} onDone={() => void loadChapter(data.courseware.chapter)} />
          ))}
        </div>
      )}

      {!data && !locked && <p className="muted" style={{ marginTop: 16 }}>正在载入课件…</p>}
    </div>
  );
}

/** 单页渲染：按 layout 走不同的版面（结构化数据，改内容不用改代码） */
function Slide({ page }: { page: CoursewarePage }) {
  return (
    <article className={`slide slide-${page.layout}`}>
      <h2>{page.title}</h2>
      {page.layout === 'cover' && page.body?.map((b) => <p key={b} className="lead">{b}</p>)}
      {page.layout === 'points' && (
        <ul className="slide-points">{page.body?.map((b) => <li key={b}>{b}</li>)}</ul>
      )}
      {page.layout === 'cards' && (
        <div className="slide-cards">
          {page.cards?.map((c) => (
            <div key={c.title} className="slide-card"><strong>{c.title}</strong><p>{c.text}</p></div>
          ))}
        </div>
      )}
      {page.layout === 'timeline' && (
        <ol className="slide-timeline">
          {page.timeline?.map((t) => (
            <li key={t.when}>
              <span className="when">{t.when}</span>
              <span className="what">{t.what}</span>
              {t.tag && <span className={`badge ${t.tag === '已公告' ? 'badge-ok' : 'badge-muted'}`}>{t.tag}</span>}
            </li>
          ))}
        </ol>
      )}
      {page.layout === 'two-col' && (
        <div className="slide-cols">
          {[page.left, page.right].map((col, i) => col && (
            <div key={i}>
              <h3>{col.title}</h3>
              <ul>{col.items.map((x) => <li key={x}>{x}</li>)}</ul>
            </div>
          ))}
        </div>
      )}
      {page.layout === 'pyramid' && (
        <ol className="slide-pyramid">
          {page.levels?.map((l) => (
            <li key={l.name} data-strength={l.strength}>
              <strong>{l.name}</strong><span>{l.detail}</span>
            </li>
          ))}
        </ol>
      )}
      {page.source && <p className="muted small">来源：{page.source}</p>}
      {page.task && <p className="badge badge-ok">配套任务 {page.task}</p>}
    </article>
  );
}

/** 教师：按“章—任务”看提交与未提交名单，导出 CSV */
interface RosterTask {
  id: string; type: string; title: string; submitted: number; total: number;
  students: { student_no: string; name: string; submitted: boolean; score: number | null; at: string | null }[];
}

function Roster({ chapter }: { chapter: number }) {
  const [tasks, setTasks] = useState<RosterTask[] | null>(null);
  const [open, setOpen] = useState<string>('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [peer, setPeer] = useState<Record<string, { assigned: number; done: number }>>({});
  const loadPeer = useCallback(async () => {
    const r = await api<{ open: { chapter: number; task_id: string; assigned: number; done: number }[] }>('/teacher/peer');
    setPeer(Object.fromEntries(r.open.filter((x) => x.chapter === chapter).map((x) => [x.task_id, x])));
  }, [chapter]);
  useEffect(() => { void loadPeer().catch(() => {}); }, [loadPeer]);

  useEffect(() => {
    api<{ tasks: RosterTask[] }>(`/teacher/submissions?chapter=${chapter}`)
      .then((r) => setTasks(r.tasks))
      .catch((e) => setError(e instanceof ApiError ? e.message : '载入失败。'));
  }, [chapter]);

  if (error) return <div className="notice notice-error" role="alert" style={{ marginTop: 16 }}><span className="icon">!</span><span>{error}</span></div>;
  if (!tasks) return <p className="muted" style={{ marginTop: 16 }}>正在载入…</p>;

  return (
    <section className="section" style={{ marginTop: 16 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>第{chapter}章 提交情况</h2>
        <span className="spacer" />
        <a className="btn" href={`/api/teacher/submissions/export?chapter=${chapter}`}>导出 CSV</a>
      </div>
      <p className="muted small">只统计正式班级的学生，演示账号不计入。填写类任务可以开启匿名互评。</p>
      {note && <p className="notice notice-ok"><span className="icon">✓</span><span>{note}</span></p>}
      <ul className="list">
        {tasks.map((t) => {
          const missing = t.students.filter((s) => !s.submitted);
          return (
            <li key={t.id}>
              <div className="row">
                <strong>{t.id}　{t.title}</strong>
                <span className="badge badge-muted">{t.submitted}/{t.total} 已提交</span>
                {peer[t.id] && <span className="badge badge-ok">互评 {peer[t.id].done}/{peer[t.id].assigned}</span>}
                <span className="spacer" />
                {t.type === 'form' && (
                  <button type="button" className="btn btn-sm" onClick={async () => {
                    try {
                      const r = await api<{ submissions: number; created: number }>('/teacher/peer/open', { body: { chapter, task_id: t.id } });
                      setNote(`「${t.title}」已开启互评：${r.submissions} 份作业，新分配 ${r.created} 份评价任务（每份分给2位同学，不会分给作者本人）。`);
                      await loadPeer();
                    } catch (e) { setError(e instanceof ApiError ? e.message : '开启失败。'); }
                  }}>{peer[t.id] ? '给新提交补分配' : '开启互评'}</button>
                )}
                <button type="button" className="btn btn-text btn-sm" aria-expanded={open === t.id} onClick={() => setOpen(open === t.id ? '' : t.id)}>
                  {open === t.id ? '收起名单' : '看名单'}
                </button>
              </div>
              {open === t.id && (
                <div className="grid-2" style={{ marginTop: 8 }}>
                  <div>
                    <h3 className="small">未提交（{missing.length}）</h3>
                    <p className="small">{missing.map((s) => `${s.name}（${s.student_no}）`).join('、') || '无'}</p>
                  </div>
                  <div>
                    <h3 className="small">已提交（{t.submitted}）</h3>
                    <p className="small">{t.students.filter((s) => s.submitted).map((s) => `${s.name}${s.score !== null ? ` ${s.score}分` : ''}`).join('、') || '无'}</p>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** 课堂任务：投票 / 测验 / 表单 */
function TaskCard({ chapter, task, onDone }: { chapter: number; task: ChapterTask; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [choice, setChoice] = useState('');
  const [extra, setExtra] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [detail, setDetail] = useState<{ no: number; correctAnswer: string; got: string; ok: boolean; why: string }[] | null>(null);
  const [dist, setDist] = useState<{ options: { key: string; label: string; count: number; percent: number }[]; total: number } | null>(null);

  const def = task.def;

  const loadDist = useCallback(async () => {
    try {
      const r = await api<{ options: { key: string; label: string; count: number; percent: number }[]; total: number }>(`/chapters/${chapter}/tasks/${task.id}/distribution`);
      setDist(r);
    } catch { /* 投票分布只是参考 */ }
  }, [chapter, task.id]);

  useEffect(() => { if (def.type === 'poll') void loadDist(); }, [def.type, loadDist]);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const content = def.type === 'poll' ? { choice, extra }
        : def.type === 'quiz' ? { answers }
        : form;
      const r = await api<{ score?: number; correct?: number; total?: number; detail?: typeof detail }>(`/chapters/${chapter}/tasks/${task.id}`, { body: { content } });
      if (r.detail) setDetail(r.detail);
      if (typeof r.score === 'number') toast(`得分 ${r.score} 分（${r.correct}/${r.total}）`);
      else toast('已提交');
      await loadDist();
      onDone();
    } catch (e) { setError(e instanceof ApiError ? e.message : '提交失败，请重试。'); } finally { setBusy(false); }
  };

  return (
    <section className="section">
      <div className="row">
        <h3 style={{ margin: 0 }}>{def.title}</h3>
        <span className="badge badge-muted">{def.type === 'poll' ? '投票' : def.type === 'quiz' ? '测验' : '表单'}</span>
        {task.submitted && <span className="badge badge-ok">已提交{task.score !== null ? ` ${task.score}分` : ''}</span>}
        <span className="spacer" />
        <span className="muted small">{task.id}</span>
      </div>
      {def.prompt && <p>{def.prompt}</p>}

      {def.type === 'poll' && (
        <>
          <div className="chips" role="radiogroup" aria-label={def.title}>
            {def.options?.map((o) => (
              <button key={o.key} type="button" className="chip" role="radio" aria-checked={choice === o.key}
                disabled={task.submitted} onClick={() => setChoice(o.key)}>
                {o.key}　{o.label}
              </button>
            ))}
          </div>
          {def.extra && (
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor={`${task.id}-extra`}>{def.extra.label}</label>
              <input id={`${task.id}-extra`} className="input" maxLength={def.extra.max} value={extra} disabled={task.submitted} onChange={(e) => setExtra(e.target.value)} />
            </div>
          )}
          {dist && dist.total > 0 && (
            <div className="poll-dist" style={{ marginTop: 16 }}>
              <strong>现场分布（{dist.total} 人）</strong>
              {dist.options.map((o) => (
                <div key={o.key} className="poll-row">
                  <span className="poll-label">{o.key}</span>
                  <span className="poll-bar" style={{ width: `${Math.max(2, o.percent)}%` }} aria-hidden="true" />
                  <span className="muted small">{o.count} 人 · {o.percent}%</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {def.type === 'quiz' && (
        <>
          {task.submitted && detail ? (
            <ul className="list">
              {detail.map((d) => (
                <li key={d.no}>
                  <strong>{d.ok ? '✓' : '✗'} 第{d.no}题</strong>
                  你的答案：{d.got || '（空）'}　正确答案：{d.correctAnswer}
                  <p className="muted small" style={{ margin: '2px 0 0' }}>{d.why}</p>
                </li>
              ))}
            </ul>
          ) : (
            <ol className="quiz">
              {def.questions?.map((q) => (
                <li key={q.no}>
                  <p>{q.text}</p>
                  <div className="chips" role="radiogroup" aria-label={`第${q.no}题`}>
                    {def.optionSet?.map((o) => (
                      <button key={o} type="button" className="chip" role="radio" aria-checked={answers[String(q.no)] === o}
                        onClick={() => setAnswers((a) => ({ ...a, [String(q.no)]: o }))}>{o}</button>
                    ))}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {task.submitted && <p className="muted small">测验只能提交一次。</p>}
        </>
      )}

      {def.type === 'form' && (
        <>
          {def.fields?.map((f) => (
            <div className="field" key={f.key}>
              <label htmlFor={`${task.id}-${f.key}`}>{f.label}{f.required && <span className="muted small">（必填）</span>}</label>
              {f.type === 'multi' && (
                <div className="chips" role="group" aria-label={f.label}>
                  {f.options?.map((o) => {
                    const arr = (form[f.key] as string[]) || [];
                    return (
                      <button key={o} type="button" className="chip" role="checkbox" aria-checked={arr.includes(o)}
                        onClick={() => setForm((x) => ({ ...x, [f.key]: arr.includes(o) ? arr.filter((y) => y !== o) : [...arr, o] }))}>{o}</button>
                    );
                  })}
                </div>
              )}
              {f.type === 'select' && (
                <select id={`${task.id}-${f.key}`} className="select" value={String(form[f.key] ?? '')} onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))}>
                  <option value="">请选择</option>
                  {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
              {f.type === 'text' && (
                <input id={`${task.id}-${f.key}`} className="input" maxLength={f.max} value={String(form[f.key] ?? '')} onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))} />
              )}
              {f.type === 'textarea' && (
                <textarea id={`${task.id}-${f.key}`} className="textarea" maxLength={f.max} value={String(form[f.key] ?? '')} onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))} />
              )}
            </div>
          ))}
        </>
      )}

      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 12 }}><span className="icon">!</span><span>{error}</span></div>}
      <button type="button" className="btn btn-primary" disabled={busy || (def.type === 'quiz' && task.submitted)}
        onClick={() => void submit()}>
        {busy ? '正在提交…' : task.submitted ? (def.type === 'quiz' ? '已提交' : '重新提交') : '提交'}
      </button>
    </section>
  );
}
