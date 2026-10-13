// M18 导师团会议：司南编排、多导师流式发言、共识/分歧/决定、纪要行动项确认
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, streamPost } from '../api/client';
import { getAgent, displayName } from '../registry';
import { Markdown, visibleStreamText } from '../components/Markdown';
import { MentorIcon } from '../components/MentorBadge';
import { FeedbackBar, SourceTags, type SourceRef } from '../components/Feedback';
import { useToast } from '../components/Toast';
import type { GroupMentor, GroupMode, GroupSession, GroupSummaryResp, SessionsResp } from '../api/types2';

interface Speech { key: string; name: string; text: string; done: boolean; error?: string }

export default function Group() {
  const toast = useToast();
  const [params] = useSearchParams();
  const [modes, setModes] = useState<GroupMode[]>([]);
  const [maxRounds, setMaxRounds] = useState(10);
  const [sessions, setSessions] = useState<GroupSession[]>([]);
  const [session, setSession] = useState<GroupSession | null>(null);
  const [pool, setPool] = useState<GroupMentor[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [mode, setMode] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<{ note: string; speakers: { key: string; name: string; focus: string }[]; degraded: boolean } | null>(null);
  const [speeches, setSpeeches] = useState<Speech[]>([]);
  const [summary, setSummary] = useState<GroupSummaryResp | null>(null);
  const [options, setOptions] = useState<{ key: string; label: string }[]>([]);
  const [pickedActions, setPickedActions] = useState<number[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef(false);

  const loadList = useCallback(async () => {
    const [m, s] = await Promise.all([
      api<{ modes: GroupMode[]; max_rounds: number }>('/group/modes'),
      api<SessionsResp>('/group/sessions'),
    ]);
    setModes(m.modes);
    setMaxRounds(m.max_rounds);
    setSessions(s.sessions);
    return m.modes;
  }, []);

  useEffect(() => {
    loadList().then((list) => {
      const want = params.get('mode');
      setMode(want && list.some((x) => x.key === want) ? want : (list[0]?.key || ''));
    }).catch((e) => setError((e as Error).message));
  }, [loadList, params]);

  const loadMentors = useCallback(async (mk: string) => {
    if (!mk) return;
    const r = await api<{ mentors: GroupMentor[]; defaults: string[] }>(`/group/mentors?mode=${mk}`);
    setPool(r.mentors);
    setPicked(r.defaults.filter((d) => !r.mentors.find((x) => x.key === d)?.muted));
  }, []);

  useEffect(() => { loadMentors(mode).catch(() => {}); }, [mode, loadMentors]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }); }, [speeches, summary]);

  const openSession = async (id: number) => {
    setBusy('open'); setError('');
    try {
      const r = await api<{ session: GroupSession }>(`/group/sessions/${id}`);
      setSession(r.session);
      setSpeeches([]); setSummary(null); setOptions([]); setPlan(null);
      setPickedActions(r.session.action_items?.filter((a) => a.confirmed).map((a) => a.id) || []);
      setShowPicker(false);
    } catch (e) { setError(e instanceof ApiError ? e.message : '打开会议失败。'); } finally { setBusy(''); }
  };

  const start = async () => {
    setBusy('start'); setError('');
    try {
      const r = await api<{ session: GroupSession }>('/group/sessions', { body: { mode, mentors: picked }, withKey: true });
      setSession(r.session);
      setSpeeches([]); setSummary(null); setOptions([]);
      await loadList();
      toast('会议开始了，说说你想聊什么');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '开会失败，请重试。');
    } finally { setBusy(''); }
  };

  const send = async (text: string) => {
    if (!session || sendingRef.current) return;
    const t = text.trim();
    if (!t) return;
    sendingRef.current = true;
    setBusy('send'); setError(''); setPlan(null); setSummary(null); setOptions([]); setSpeeches([]);
    setDraft('');
    const restore = (err: ApiError, keep = t) => { setDraft(keep); setError(err.message); };
    try {
      await streamPost(`/group/sessions/${session.id}/send`, { text: t }, {
        onEvent: (event, data) => {
          if (event === 'host_plan') setPlan({ note: data.note, speakers: data.speakers, degraded: !!data.degraded });
          else if (event === 'speaker_start') {
            setSpeeches((s) => [...s, { key: data.key, name: data.name, text: '', done: false }]);
          } else if (event === 'delta') {
            setSpeeches((s) => s.map((x, i) => (i === s.length - 1 ? { ...x, text: x.text + data.text } : x)));
          } else if (event === 'speaker_end') {
            setSpeeches((s) => s.map((x, i) => (i === s.length - 1 ? { ...x, done: true, error: data.error } : x)));
          } else if (event === 'host_summary') {
            setSummary({ consensus: data.consensus, divergence: data.divergence, decide: data.decide, degraded: !!data.degraded });
          } else if (event === 'options') {
            setOptions(data.options || []);
          } else if (event === 'error') {
            restore(new ApiError(0, data.code, data.message), data.restore_text || t);
          }
        },
      }, { withKey: true });
      // 一轮结束后刷新会议（含司南三行总结的消息）
      const r = await api<{ session: GroupSession }>(`/group/sessions/${session.id}`);
      setSession(r.session);
    } catch (e) {
      restore(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', '网络连接失败，请检查网络后重试。'));
    } finally {
      sendingRef.current = false;
      setBusy('');
    }
  };

  const invite = async (key: string) => {
    setBusy(`inv-${key}`);
    try {
      const r = await api<{ session: GroupSession }>(`/group/sessions/${session!.id}/invite`, { body: { mentor: key } });
      setSession(r.session);
      toast(`${displayName(getAgent(key))} 加入了会议`);
    } catch (e) { setError(e instanceof ApiError ? e.message : '邀请失败。'); } finally { setBusy(''); }
  };

  const mute = async (key: string, muted: boolean, remove = false) => {
    setBusy(`mute-${key}`);
    try {
      const r = await api<{ session: GroupSession }>(`/group/sessions/${session!.id}/mute`, { body: { mentor: key, muted, remove } });
      setSession(r.session);
      await loadMentors(session!.mode);
    } catch (e) { setError(e instanceof ApiError ? e.message : '操作失败。'); } finally { setBusy(''); }
  };

  const close = async () => {
    setBusy('close'); setError('');
    try {
      const r = await api<{ session: GroupSession }>(`/group/sessions/${session!.id}/close`, { body: {}, withKey: true });
      setSession(r.session);
      setPickedActions([]);
      toast('会议纪要已生成，请确认行动项');
      await loadList();
    } catch (e) { setError(e instanceof ApiError ? e.message : '结束会议失败。'); } finally { setBusy(''); }
  };

  const confirmActions = async () => {
    setBusy('confirm'); setError('');
    try {
      const r = await api<{ session: GroupSession; added: { title: string }[] }>(`/group/sessions/${session!.id}/actions/confirm`, { body: { ids: pickedActions } });
      setSession(r.session);
      toast(`已把 ${r.added.length} 条行动项写进学习方案`);
    } catch (e) { setError(e instanceof ApiError ? e.message : '确认失败。'); } finally { setBusy(''); }
  };

  const twinJoin = async () => {
    setBusy('twin'); setError('');
    try {
      const r = await api<{ session: GroupSession }>(`/group/sessions/${session!.id}/twin`, { body: {}, withKey: true });
      setSession(r.session);
      toast('分身已代你发言（草稿）');
    } catch (e) { setError(e instanceof ApiError ? e.message : '分身没能参会。'); } finally { setBusy(''); }
  };

  const [draftDecision, setDraftDecision] = useState('');
  const confirmDraft = async (reject: boolean) => {
    if (reject && !window.confirm('否决这份草稿纪要？所有行动项都会作废。')) return;
    setBusy('draft'); setError('');
    try {
      const r = await api<{ session: GroupSession }>(`/group/sessions/${session!.id}/draft/confirm`, { body: reject ? { reject: true } : { decision: draftDecision } });
      setSession(r.session);
      toast(reject ? '已否决这份纪要' : '纪要已确认，现在可以勾选行动项了');
    } catch (e) { setError(e instanceof ApiError ? e.message : '操作失败。'); } finally { setBusy(''); }
  };

  const round = session ? session.messages.filter((m) => m.speaker_type === 'user').length : 0;

  return (
    <div className="page">
      <p className="muted small"><Link to="/mentors">← 导师团（1:1 搭子）</Link></p>
      <header className="row">
        <div>
          <h1>导师团会议</h1>
          <p className="muted" style={{ margin: 0 }}>几位导师一起聊，司南主持。有不同意见时并排给你看，最后由你自己定。</p>
        </div>
        <span className="spacer" />
        {session && session.status === 'open' && (
          <button type="button" className="btn" disabled={busy === 'close'} onClick={() => void close()}>
            {busy === 'close' ? '正在生成纪要…' : '结束会议并生成纪要'}
          </button>
        )}
      </header>

      {error && <div className="notice notice-error" role="alert" style={{ margin: '16px 0' }}><span className="icon">!</span><span>{error}</span></div>}

      {!session && (
        <section className="section">
          <h2>开一场会议</h2>
          <div className="chips" role="radiogroup" aria-label="会议类型">
            {modes.map((m) => (
              <button key={m.key} type="button" className="chip" role="radio" aria-checked={mode === m.key} disabled={!m.available}
                onClick={() => setMode(m.key)}>
                {m.name}{m.tier === 'basic' ? '' : '（需自己的 Key）'}{!m.available ? '（后续阶段）' : ''}
              </button>
            ))}
          </div>
          {modes.find((m) => m.key === mode) && (
            <p className="muted small">{modes.find((m) => m.key === mode)!.desc}　产出：{modes.find((m) => m.key === mode)!.product}</p>
          )}

          <h3>参会导师（最多4位）</h3>
          <div className="chips">
            {pool.map((m) => (
              <button key={m.key} type="button" className="chip" role="checkbox" aria-checked={picked.includes(m.key)}
                disabled={m.muted}
                onClick={() => setPicked((p) => (p.includes(m.key) ? p.filter((x) => x !== m.key) : p.length >= 4 ? p : [...p, m.key]))}>
                {m.name}｜{m.duty}{m.muted ? '（已静音）' : ''}
              </button>
            ))}
          </div>
          <p className="muted small">静音的导师不会发言；可以在“我 → 提醒设置”所在的偏好里调整，或在会议中静音。</p>
          <button type="button" className="btn btn-primary" disabled={!mode || !picked.length || busy === 'start'} onClick={() => void start()}>
            {busy === 'start' ? '正在开会…' : '开始会议'} <span className="arrow">→</span>
          </button>
          {!!sessions.length && (
            <>
              <h3>以前的会议</h3>
              <ul className="list">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <div className="row">
                      <strong>{s.mode_name}</strong>
                      <span className="badge badge-muted">{s.status === 'open' ? '进行中' : '已结束'}</span>
                      <span className="muted small">{s.mentors.map((k) => displayName(getAgent(k))).join('、')}</span>
                      <span className="spacer" />
                      <button type="button" className="btn btn-text btn-sm" onClick={() => void openSession(s.id)}>打开</button>
                    </div>
                    <span className="muted small">{s.created_at.slice(0, 16)} · 导师发言 {s.mentor_speech_count} 次</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {session && (
        <>
          <section className="section">
            <div className="row">
              <strong>{session.mode_name}</strong>
              <span className={`badge ${session.status === 'open' ? 'badge-ok' : 'badge-muted'}`}>{session.status === 'open' ? `进行中 · 第${round}/${maxRounds}轮` : '已结束'}</span>
              <span className="spacer" />
              <button type="button" className="btn btn-text btn-sm" aria-expanded={showPicker} onClick={() => setShowPicker((v) => !v)}>
                {showPicker ? '收起导师管理' : '管理导师'}
              </button>
              <button type="button" className="btn btn-text btn-sm" onClick={() => { setSession(null); setSpeeches([]); setSummary(null); }}>回到列表</button>
            </div>
            <p className="muted small" style={{ margin: '4px 0 0' }}>
              在场：{session.mentors.map((k) => displayName(getAgent(k))).join('、')}
            </p>

            {showPicker && (
              <div className="section" style={{ background: '#fff', marginTop: 12 }}>
                <h3 style={{ marginTop: 0 }}>邀请 / 静音 / 请出</h3>
                <ul className="list">
                  {pool.map((m) => {
                    const inSession = session.mentors.includes(m.key);
                    return (
                      <li key={m.key}>
                        <div className="row">
                          <span><strong>{m.name}</strong>｜{m.duty} <span className="muted small">{m.summary}</span></span>
                          <span className="spacer" />
                          {m.muted && <span className="badge badge-muted">已静音</span>}
                          {!inSession && !m.muted && (
                            <button type="button" className="btn btn-sm" disabled={busy === `inv-${m.key}`} onClick={() => void invite(m.key)}>邀请</button>
                          )}
                          {inSession && (
                            <>
                              <button type="button" className="btn btn-sm" disabled={busy === `mute-${m.key}`} onClick={() => void mute(m.key, true)}>静音</button>
                              <button type="button" className="btn btn-text btn-sm" disabled={busy === `mute-${m.key}`} onClick={() => void mute(m.key, true, true)}>请出</button>
                            </>
                          )}
                          {m.muted && (
                            <button type="button" className="btn btn-text btn-sm" disabled={busy === `mute-${m.key}`} onClick={() => void mute(m.key, false)}>解除静音</button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>

          <section className="section">
            <h3>会议记录</h3>
            {!session.messages.length && <p className="muted">还没有发言。可以直接说说你的问题，也可以用“@导师名”点名让某位导师先答。</p>}
            {session.messages.map((m) => {
              if (m.speaker_type === 'user') return <div key={m.id} className="msg msg-user">{m.content}</div>;
              if (m.speaker_type === 'host') {
                return (
                  <div key={m.id} className="msg msg-host">
                    <div className="msg-meta"><MentorIcon agent={getAgent('host')} size={20} /><span>司南｜主持</span></div>
                    <Markdown text={m.content} />
                  </div>
                );
              }
              if (m.speaker_type === 'twin') {
                return (
                  <div key={m.id} className="msg msg-twin">
                    <div className="msg-meta">
                      <MentorIcon agent={getAgent('twin')} size={22} />
                      <span>我的数字分身</span>
                      <span className="twin-tag">分身推测</span>
                      <span className="badge badge-muted">草稿</span>
                    </div>
                    <Markdown text={m.content} />
                  </div>
                );
              }
              return (
                <div key={m.id} className="msg msg-ai">
                  <div className="msg-meta">
                    <MentorIcon agent={getAgent(m.speaker_key)} size={22} />
                    <span>{displayName(getAgent(m.speaker_key))}</span>
                    <span className="ai-tag">AI生成</span>
                    <span className="spacer" />
                  </div>
                  <Markdown text={m.content} />
                  <SourceTags sources={m.sources as SourceRef[]} />
                  {m.speaker_key && <FeedbackBar mentorKey={m.speaker_key} messageRef={`gmsg:${m.id}`} sessionId={session.id} />}
                </div>
              );
            })}

            {/* 本轮进行中：司南的发言安排 + 各位导师的流式发言 */}
            {plan && (
              <div className="notice notice-info" role="status">
                <span className="icon">→</span>
                <span>
                  {plan.note}
                  {plan.degraded && <span className="muted small">（司南这次没能编排，已按默认顺序发言）</span>}
                </span>
              </div>
            )}
            {speeches.map((s, i) => (
              <div key={`${s.key}-${i}`} className="msg msg-ai">
                <div className="msg-meta">
                  <MentorIcon agent={getAgent(s.key)} size={22} />
                  <span>{s.name}</span>
                  <span className="ai-tag">AI生成</span>
                  {plan?.speakers.find((x) => x.key === s.key)?.focus && (
                    <span className="muted small">焦点：{plan.speakers.find((x) => x.key === s.key)!.focus}</span>
                  )}
                </div>
                {s.text ? <Markdown text={visibleStreamText(s.text)} /> : <p className="stream-status">正在思考…</p>}
                {s.error && <div className="notice notice-warn"><span className="icon">!</span><span>{s.error}</span></div>}
              </div>
            ))}
            {summary && !options.length && (
              <div className="msg msg-host">
                <div className="msg-meta"><MentorIcon agent={getAgent('host')} size={20} /><span>司南｜主持</span></div>
                <p><strong>共识：</strong>{summary.consensus}</p>
                <p><strong>分歧：</strong>{summary.divergence}</p>
                <p style={{ margin: 0 }}><strong>需要你决定：</strong>{summary.decide}</p>
              </div>
            )}
            <div ref={endRef} />
          </section>

          {session.status === 'open' && (
            <section className="section">
              {options.length > 0 && (
                <div className="chips" role="radiogroup" aria-label="本轮选项">
                  {options.map((o) => (
                    <button key={o.key} type="button" className="chip" onClick={() => void send(`【选择】${o.key}：${o.label}`)}>
                      {o.key}　{o.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="composer-row" style={{ marginTop: options.length ? 12 : 0 }}>
                <label htmlFor="group-input" className="sr-only">输入你想说的话</label>
                <textarea id="group-input" className="textarea" rows={2} maxLength={2000}
                  placeholder="输入你想说的，或用 @导师名 点名（例如 @望岳 你先说说）" value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(draft); } }} />
                <button type="button" className="btn btn-primary" disabled={busy === 'send' || !draft.trim()} onClick={() => void send(draft)}>
                  {busy === 'send' ? '进行中…' : '发言'}
                </button>
              </div>
              <p className="muted small">这一轮是第 {round + 1} / {maxRounds} 轮。到达上限后会提示先把决定落到行动上。</p>
              {session.mode === 'weekly' && (
                <div className="row" style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-sm" disabled={busy === 'twin'} onClick={() => void twinJoin()}>
                    {busy === 'twin' ? '分身正在发言…' : '让分身代我陈述本周情况'}
                  </button>
                  <span className="muted small">需要先在“我 → 数字分身”生成档案，并用你自己的 Key。分身的发言和之后的纪要都是草稿，要你本人确认。</span>
                </div>
              )}
            </section>
          )}

          {session.summary && (
            <section className="section">
              <h2>会议纪要</h2>
              <p className="muted small">纪要和行动项由司南起草，行动项只有你勾选确认后才会写进学习方案。</p>
              {!!session.summary.points?.length && (
                <>
                  <h3>讨论要点</h3>
                  <ul className="list">{session.summary.points.map((p) => <li key={p}>{p}</li>)}</ul>
                </>
              )}
              <p><strong>你的决定：</strong>{session.summary.decision}</p>
              {session.summary.draft && (
                <div className="notice notice-warn" style={{ marginBottom: 16 }}>
                  <span className="icon">!</span>
                  <div style={{ flex: 1 }}>
                    <p style={{ marginTop: 0 }}><strong>这是一份草稿纪要。</strong>你的数字分身参加了这场会议，纪要里“你的决定”可能是分身推测的。请你本人确认或否决；确认前，任何行动项都不会写入方案。</p>
                    <div className="field">
                      <label htmlFor="draft-decision">我本人的决定（可以改，留空就沿用上面的）</label>
                      <input id="draft-decision" className="input" maxLength={300} value={draftDecision} onChange={(e) => setDraftDecision(e.target.value)} />
                    </div>
                    <div className="row">
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'draft'} onClick={() => void confirmDraft(false)}>确认这份纪要</button>
                      <button type="button" className="btn btn-danger btn-sm" disabled={busy === 'draft'} onClick={() => void confirmDraft(true)}>否决</button>
                    </div>
                  </div>
                </div>
              )}
              {session.summary.rejected && <p className="muted small">你否决了这份纪要，行动项已作废。</p>}
              <h3>行动项（勾选后才写入方案）</h3>
              {!session.action_items?.length && <p className="muted">这场会议没有提炼出行动项。</p>}
              {!!session.action_items?.length && (
                <>
                  <ul className="check-list">
                    {session.action_items.map((a) => (
                      <li key={a.id}>
                        <label className="check">
                          <input type="checkbox" checked={pickedActions.includes(a.id)} disabled={a.confirmed}
                            onChange={() => setPickedActions((p) => (p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id]))} />
                          <span>
                            <strong>{a.title}</strong> <span className="badge badge-muted">{a.kind}</span>{' '}
                            <span className="muted small">{a.minutes} 分钟</span>
                            {a.confirmed && <span className="badge badge-ok" style={{ marginLeft: 8 }}>已写入方案</span>}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="btn btn-primary" disabled={!pickedActions.length || busy === 'confirm' || !!session.summary.draft} onClick={() => void confirmActions()}>
                    {busy === 'confirm' ? '正在写入…' : '确认勾选的行动项'}
                  </button>
                  <p className="muted small">没勾选的行动项不会出现在学习方案里。</p>
                </>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
