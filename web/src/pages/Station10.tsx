// 第10站 复试准备（M13）：选配置 → 一题一答的模拟 → 每位考官的复盘 → 自评（≥50字）→ 复试问题库
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, streamPost } from '../api/client';
import type { InterviewSession, InterviewStatus, QbankItem } from '../api/types2';
import { StationShell } from './Road';
import { useToast } from '../components/Toast';
import { MentorIcon } from '../components/MentorBadge';
import { getAgent, displayName } from '../registry';

const EXAMINERS = ['格物｜专业考官', '远帆｜英语考官', '守正｜综合考官', '鉴微｜导师视角'];
const SELF_MIN = 50;

export default function Station10() {
  const toast = useToast();
  const [status, setStatus] = useState<InterviewStatus | null>(null);
  const [history, setHistory] = useState<InterviewSession[]>([]);
  const [session, setSession] = useState<InterviewSession | null>(null);
  const [qbank, setQbank] = useState<QbankItem[]>([]);
  const [error, setError] = useState<ApiError | null>(null);

  const load = useCallback(async () => {
    const [s, h, q] = await Promise.all([
      api<InterviewStatus>('/interview/status'),
      api<{ sessions: InterviewSession[] }>('/interview/sessions'),
      api<{ items: QbankItem[] }>('/interview/qbank'),
    ]);
    setStatus(s); setHistory(h.sessions); setQbank(q.items);
  }, []);
  useEffect(() => { load().catch((e) => setError(e as ApiError)); }, [load]);

  const open = async (id: number) => {
    try { setSession((await api<{ session: InterviewSession }>(`/interview/sessions/${id}`)).session); } catch (e) { setError(e as ApiError); }
  };

  return (
    <StationShell station={10}>
      <div className="notice notice-warn" style={{ marginBottom: 16 }}>
        <span className="icon">!</span>
        <span>{status?.disclaimer || 'AI模拟，不代表真实院校考官，题目非真题。'} 课堂上的“复试情境展示”由老师和同学现场评价，这里只是练习。</span>
      </div>
      {error && (
        <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span>
          <span>{error.message}{(error.code === 'NEED_USER_KEY' || error.code?.startsWith('USER_')) && <> <Link to="/me/keys">去设置</Link></>}</span>
        </div>
      )}

      {!session && status && (
        <Setup status={status} onError={setError} onStarted={(s) => { setError(null); setSession(s); }} />
      )}
      {session && (
        <Live key={session.id} initial={session} onError={setError}
          onBack={() => { setSession(null); void load(); }}
          onChanged={(s) => setSession(s)} toast={toast} />
      )}

      {!session && (
        <>
          <section className="section">
            <h2>我的复试问题库（{qbank.filter((q) => q.status === '待重练').length} 道待重练）</h2>
            <p className="muted small">答得不好的问题会自动进来；下一次模拟会优先抽到还没重练的题。练过之后自己标“已重练”。</p>
            <QbankList items={qbank} onChanged={() => void load()} />
          </section>
          {!!history.length && (
            <section className="section">
              <h2>练习记录</h2>
              <ul className="list">
                {history.map((h) => (
                  <li key={h.id} className="row">
                    <span>{h.created_at.slice(0, 16)}</span>
                    <span className="badge badge-muted">{h.config.tier === 'basic' ? '基础版' : '完整考官组'}</span>
                    <span className="muted small">{h.config.target}｜{h.question_count} 题｜{h.config.difficulty}</span>
                    <span className={`badge ${h.status === 'closed' ? 'badge-ok' : 'badge-warn'}`}>{{ running: '进行中', ended: '待复盘', reviewed: '待写自评', closed: '已完成' }[h.status]}</span>
                    <span className="spacer" />
                    <button type="button" className="btn btn-text btn-sm" onClick={() => void open(h.id)}>打开</button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </StationShell>
  );
}

function Setup({ status, onError, onStarted }: { status: InterviewStatus; onError: (e: ApiError | null) => void; onStarted: (s: InterviewSession) => void }) {
  const [tier, setTier] = useState<'basic' | 'full'>('basic');
  const [target, setTarget] = useState(status.suggested_target);
  const [form, setForm] = useState('线下');
  const [duration, setDuration] = useState(20);
  const [examiners, setExaminers] = useState<string[]>(['格物｜专业考官', '远帆｜英语考官']);
  const [difficulty, setDifficulty] = useState('标准');
  const [rehearsal, setRehearsal] = useState(false);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true); onError(null);
    try {
      const r = await api<{ session: InterviewSession }>('/interview/sessions', {
        body: { tier, target, form, difficulty, ...(tier === 'full' ? { duration, examiners, rehearsal } : {}) },
        withKey: tier === 'full',
      });
      onStarted(r.session);
    } catch (e) { onError(e as ApiError); } finally { setBusy(false); }
  };

  return (
    <section className="section">
      <h2>开始一场模拟</h2>
      <div className="chips" role="radiogroup" aria-label="版本">
        <button type="button" className="chip" role="radio" aria-checked={tier === 'basic'} onClick={() => setTier('basic')}>基础版（衡言单考官·10分钟·本周还剩 {status.basic.left} 次）</button>
        <button type="button" className="chip" role="radio" aria-checked={tier === 'full'} onClick={() => setTier('full')}>完整考官组（需自己的 Key）</button>
      </div>
      <p className="muted small" style={{ marginTop: 8 }}>基础版用平台 Key，人人都能练；结课考核不依赖完整考官组。</p>
      <div className="grid-2" style={{ marginTop: 12 }}>
        <div className="field">
          <label htmlFor="iv-target">目标院校与专业（从择校比较表带入，可改）</label>
          <input id="iv-target" className="input" maxLength={60} value={target} onChange={(e) => setTarget(e.target.value)} placeholder="例如：西北大学 学科教学（语文）" />
        </div>
        <div className="field">
          <span className="label">形式</span>
          <div className="chips" role="radiogroup" aria-label="形式">{['线下', '线上'].map((f) => <button key={f} type="button" className="chip" role="radio" aria-checked={form === f} onClick={() => setForm(f)}>{f}</button>)}</div>
        </div>
      </div>
      <div className="field">
        <span className="label">难度</span>
        <div className="chips" role="radiogroup" aria-label="难度">{['温和', '标准', '压力'].map((d) => <button key={d} type="button" className="chip" role="radio" aria-checked={difficulty === d} onClick={() => setDifficulty(d)}>{d}</button>)}</div>
        {difficulty === '压力' && <span className="muted small">压力难度追问会更紧，但考官措辞始终尊重，不会羞辱或人身攻击。</span>}
      </div>
      {tier === 'full' && (
        <>
          <div className="field">
            <span className="label">时长</span>
            <div className="chips" role="radiogroup" aria-label="时长">{[10, 20, 30].map((d) => <button key={d} type="button" className="chip" role="radio" aria-checked={duration === d} onClick={() => setDuration(d)}>{d} 分钟</button>)}</div>
          </div>
          <div className="field">
            <span className="label">考官组合（主考衡言必选）</span>
            <div className="chips">
              {EXAMINERS.map((x) => (
                <button key={x} type="button" className="chip" role="checkbox" aria-checked={examiners.includes(x)}
                  onClick={() => setExaminers((v) => (v.includes(x) ? v.filter((y) => y !== x) : [...v, x]))}>{x}</button>
              ))}
            </div>
          </div>
          <label className="check">
            <input type="checkbox" checked={rehearsal} disabled={!status.twin_ready} onChange={(e) => setRehearsal(e.target.checked)} />
            <span>先让数字分身彩排一遍（分身按你的表达习惯先答，你再亲自作答；结束后并排对照）{!status.twin_ready && <span className="muted small">——需要先在 <Link to="/me/twin">数字分身</Link> 生成档案</span>}</span>
          </label>
        </>
      )}
      {status.qbank_pending > 0 && <p className="muted small">题库里有 {status.qbank_pending} 道待重练的题，这次会优先抽到。</p>}
      <button type="button" className="btn btn-primary" disabled={busy || (tier === 'basic' && status.basic.left <= 0)} onClick={() => void start()}>
        {busy ? '正在准备…' : '开始模拟'} <span className="arrow">→</span>
      </button>
    </section>
  );
}

interface Pending { examiner: string; stage: string; text: string; twin?: string }

function Live({ initial, onError, onBack, onChanged, toast }: {
  initial: InterviewSession; onError: (e: ApiError | null) => void; onBack: () => void; onChanged: (s: InterviewSession) => void; toast: (s: string, k?: 'ok' | 'error' | 'warn') => void;
}) {
  const [s, setS] = useState(initial);
  const [pending, setPending] = useState<Pending | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState('');
  const [ended, setEnded] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(initial.remaining_sec);
  const [stage, setStage] = useState(initial.stages[initial.stage_index] || '');
  const [selfText, setSelfText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const withKey = s.config.tier === 'full';

  const refresh = useCallback(async () => {
    const r = await api<{ session: InterviewSession }>(`/interview/sessions/${s.id}`);
    setS(r.session); onChanged(r.session);
    return r.session;
  }, [s.id, onChanged]);

  useEffect(() => {
    if (s.status !== 'running') return;
    const t = window.setInterval(() => setRemaining((x) => Math.max(0, x - 1)), 1000);
    return () => window.clearInterval(t);
  }, [s.status]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [s.transcript.length, pending?.text]);

  const step = async (text: string) => {
    setBusy('next'); onError(null);
    const p: Pending = { examiner: '', stage: '', text: '' };
    setPending(p);
    try {
      await streamPost(`/interview/sessions/${s.id}/next`, text ? { text } : {}, {
        onEvent: (ev, d) => {
          if (ev === 'meta') { setStage(d.stage); setRemaining(d.remaining_sec); p.stage = d.stage; }
          else if (ev === 'examiner') { p.examiner = d.key; setPending({ ...p }); }
          else if (ev === 'delta') { p.text += d.text; setPending({ ...p }); }
          else if (ev === 'twin_answer') { p.twin = d.text || d.error; setPending({ ...p }); }
          else if (ev === 'ended') setEnded(d.message);
          else if (ev === 'error') { onError(new ApiError(0, d.code, d.message)); if (d.restore_text) setAnswer(d.restore_text); }
        },
      }, { withKey });
      setAnswer('');
      await refresh();
    } catch (e) { onError(e as ApiError); setAnswer(text); } finally { setPending(null); setBusy(''); }
  };

  const finish = async () => {
    setBusy('finish'); onError(null);
    try {
      const r = await api<{ session: InterviewSession }>(`/interview/sessions/${s.id}/finish`, { body: {}, withKey });
      setS(r.session); onChanged(r.session);
      toast(r.session.review?.qbank_added ? `复盘已生成，${r.session.review.qbank_added} 道题进了复试问题库` : '复盘已生成');
    } catch (e) { onError(e as ApiError); } finally { setBusy(''); }
  };

  const closeReview = async () => {
    setBusy('self'); onError(null);
    try {
      const r = await api<{ session: InterviewSession }>(`/interview/sessions/${s.id}/self-review`, { body: { text: selfText } });
      setS(r.session); onChanged(r.session);
      toast('自评已保存，这次复盘关闭了');
    } catch (e) { onError(e as ApiError); } finally { setBusy(''); }
  };

  const last = s.transcript[s.transcript.length - 1];
  const waiting = last?.type === 'q';
  const running = s.status === 'running' && !ended;
  const selfLen = [...selfText.replace(/\s/g, '')].length;

  return (
    <>
      <section className="section">
        <div className="row">
          <button type="button" className="btn btn-text btn-sm" onClick={onBack}>← 返回</button>
          <strong>{s.config.target}</strong>
          <span className="badge badge-muted">{s.config.tier === 'basic' ? '基础版' : '完整考官组'}｜{s.config.difficulty}｜{s.config.duration}分钟</span>
          <span className="spacer" />
          {running && <span className={`badge ${remaining < 60 ? 'badge-warn' : 'badge-muted'}`} aria-live="polite">剩余 {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</span>}
        </div>
        <ol className="steps" aria-label="复试环节">
          {s.stages.map((name) => (
            <li key={name} className={name === stage && running ? 'active' : s.transcript.some((t) => t.stage === name) ? 'done' : ''}>
              <span className="dot sm">{s.stages.indexOf(name) + 1}</span>{name}
            </li>
          ))}
        </ol>
        <div className="row muted small">考官：{s.config.examiners.map((k) => <span key={k} className="row" style={{ gap: 4 }}><MentorIcon agent={getAgent(k)} size={18} />{displayName(getAgent(k))}</span>)}</div>
      </section>

      <section className="section">
        <div className="msgs">
          {s.transcript.map((t, i) => (t.type === 'q' ? (
            <div key={i}>
              <div className="msg msg-ai">
                <div className="msg-meta"><MentorIcon agent={getAgent(t.examiner)} size={22} /><span>{displayName(getAgent(t.examiner))}</span><span className="muted small">{t.stage}</span><span className="ai-tag">AI模拟</span>{t.from_qbank && <span className="badge badge-warn">题库重练</span>}</div>
                <p style={{ margin: 0 }}>{t.text}</p>
              </div>
              {t.twin_answer && <div className="msg msg-twin"><div className="msg-meta"><span>分身彩排</span><span className="twin-tag">分身推测</span></div><p style={{ margin: 0 }}>{t.twin_answer}</p></div>}
            </div>
          ) : <div key={i} className="msg msg-user">{t.text}</div>))}
          {pending && (
            <div className="msg msg-ai">
              <div className="msg-meta">{pending.examiner ? <><MentorIcon agent={getAgent(pending.examiner)} size={22} /><span>{displayName(getAgent(pending.examiner))}</span></> : <span>主考正在安排…</span>}<span className="muted small">{pending.stage}</span></div>
              {pending.text ? <p style={{ margin: 0 }}>{pending.text}</p> : <p className="stream-status">正在想问题…</p>}
            </div>
          )}
          <div ref={endRef} />
        </div>

        {running && !s.transcript.length && !pending && (
          <button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void step('')}>请主考开始提问</button>
        )}
        {running && waiting && !pending && (
          <div className="composer-row">
            <label htmlFor="iv-answer" className="sr-only">我的回答</label>
            <textarea id="iv-answer" className="textarea" rows={3} maxLength={3000} value={answer} onChange={(e) => setAnswer(e.target.value)}
              placeholder="像现场一样作答。不会也可以直说“这题我不会”。" />
            <button type="button" className="btn btn-primary" disabled={!!busy || !answer.trim()} onClick={() => void step(answer.trim())}>回答</button>
          </div>
        )}
        {ended && <p className="notice notice-ok"><span className="icon">✓</span><span>{ended}</span></p>}
        {!s.review && s.transcript.some((t) => t.type === 'a') && (
          <button type="button" className="btn" style={{ marginTop: 12 }} disabled={!!busy} onClick={() => void finish()}>
            {busy === 'finish' ? '考官们正在复盘…' : running ? '提前结束并生成复盘' : '生成复盘'}
          </button>
        )}
      </section>

      {s.review && (
        <section className="section">
          <h2>考官复盘</h2>
          <p className="muted small">{s.review.note}</p>
          <div className="review-grid">
            {s.review.examiners.map((e) => (
              <div key={e.key} className="card">
                <div className="row"><MentorIcon agent={getAgent(e.key)} size={22} /><strong>{e.name}</strong></div>
                <table className="score-table">
                  <tbody>
                    {Object.keys(e.scores).map((k) => (
                      <tr key={k}><th>{k}</th><td className="num">{e.scores[k] ?? '—'}</td><td className="small">{e.reasons[k]}</td></tr>
                    ))}
                  </tbody>
                </table>
                {e.best_moment && <p className="small" style={{ margin: '4px 0' }}>答得最好：{e.best_moment}</p>}
                {e.worst_question && <p className="small" style={{ margin: 0, color: 'var(--c-warn)' }}>最需要重练：{e.worst_question}</p>}
              </div>
            ))}
          </div>
          {s.review.english && (
            <p className="small">英语：清晰度 {String(s.review.english['清晰度'] ?? '—')}，流畅度 {String(s.review.english['流畅度'] ?? '—')}，词汇 {String(s.review.english['词汇'] ?? '—')}。{String(s.review.english.comment || '')}（不打口音分）</p>
          )}
          <h3>主考最优先的三条改进</h3>
          <ol>{s.review.top3.map((t) => <li key={t}>{t}</li>)}</ol>

          {s.twin_rehearsal && (
            <>
              <h3>分身版 vs 本人版</h3>
              <p className="muted small">并排看看：分身按你过往的表达习惯答的，和你现场答的，差在哪里？</p>
              {s.twin_rehearsal.map((p, i) => (
                <div key={i} className="compare-row">
                  <p className="small" style={{ margin: 0 }}><strong>{p.question}</strong></p>
                  <div className="lab-compare">
                    <div className="msg msg-twin"><div className="msg-meta"><span className="twin-tag">分身推测</span></div><p className="small" style={{ margin: 0 }}>{p.twin || '（分身没有作答）'}</p></div>
                    <div className="msg msg-user" style={{ margin: 0 }}>{p.me || '（没有回答）'}</div>
                  </div>
                </div>
              ))}
            </>
          )}

          <h3>我的自评</h3>
          {s.status === 'closed' ? (
            <p style={{ whiteSpace: 'pre-wrap' }}>{s.self_review}</p>
          ) : (
            <>
              <p className="muted small">写下哪题答得不好、为什么、下次怎么改。至少 {SELF_MIN} 字，写完才能关闭这次复盘。</p>
              <textarea className="textarea" rows={4} maxLength={3000} value={selfText} onChange={(e) => setSelfText(e.target.value)} aria-label="我的自评" />
              <div className="row">
                <span className={`small ${selfLen < SELF_MIN ? 'muted' : ''}`}>{selfLen} / {SELF_MIN} 字</span>
                <span className="spacer" />
                <button type="button" className="btn btn-primary" disabled={selfLen < SELF_MIN || busy === 'self'} onClick={() => void closeReview()}>保存自评并关闭复盘</button>
              </div>
            </>
          )}
          <p style={{ marginTop: 12 }}><a href={`/api/interview/sessions/${s.id}/export`}>导出复盘记录（Markdown）</a>，可以作为课堂展示前的准备材料。</p>
        </section>
      )}
    </>
  );
}

function QbankList({ items, onChanged }: { items: QbankItem[]; onChanged: () => void }) {
  const [q, setQ] = useState('');
  if (!items.length) return <p className="muted">还没有题目。做一次模拟，答得不好的问题会自动进来；也可以自己加。</p>;
  return (
    <>
      <ul className="list">
        {items.map((x) => (
          <li key={x.id}>
            <div className="row">
              <span style={{ flex: 1, minWidth: 220 }}>{x.question}</span>
              <span className="muted small">{x.examiner || x.source}</span>
              <span className={`badge ${x.status === '已重练' ? 'badge-ok' : 'badge-warn'}`}>{x.status}</span>
              <button type="button" className="btn btn-text btn-sm" onClick={async () => { await api(`/interview/qbank/${x.id}`, { method: 'PUT', body: { status: x.status === '已重练' ? '待重练' : '已重练' } }); onChanged(); }}>
                {x.status === '已重练' ? '改回待重练' : '标为已重练'}
              </button>
              <button type="button" className="btn btn-text btn-sm" onClick={async () => { await api(`/interview/qbank/${x.id}`, { method: 'DELETE' }); onChanged(); }}>删除</button>
            </div>
          </li>
        ))}
      </ul>
      <div className="row" style={{ marginTop: 8 }}>
        <input className="input" style={{ flex: 1 }} maxLength={300} value={q} onChange={(e) => setQ(e.target.value)} placeholder="自己加一道想练的题" aria-label="添加题目" />
        <button type="button" className="btn btn-sm" disabled={!q.trim()} onClick={async () => { await api('/interview/qbank', { body: { question: q } }); setQ(''); onChanged(); }}>添加</button>
      </div>
    </>
  );
}
