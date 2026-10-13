// 我 · 数字分身（M19）：知情同意 → 数据来源 → 上传（遮盖后确认）→ 生成档案 → 校正与锁定 → 三个用途 → 删除
// 分身发言统一使用虚线描边与“分身推测”标签（PRD 11章）
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, streamPost } from '../api/client';
import type { TwinItem, TwinResp, TwinTalk } from '../api/types2';
import { useToast } from '../components/Toast';
import { MentorGlyph } from '../components/icons';
import { Markdown } from '../components/Markdown';
import { readFileBase64 } from './StudyShared';

const CONF_CLASS: Record<string, string> = { 原话: 'badge-ok', 数据: 'badge-muted', 推测: 'badge-warn' };

export default function TwinPage() {
  const toast = useToast();
  const [data, setData] = useState<TwinResp | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [agreed, setAgreed] = useState(false);

  const load = useCallback(async () => setData(await api<TwinResp>('/twin')), []);
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  const run = async (label: string, fn: () => Promise<TwinResp | void>, ok?: string) => {
    setBusy(label); setError('');
    try {
      const r = await fn();
      if (r) setData(r);
      if (ok) toast(ok);
    } catch (e) { setError(e instanceof ApiError ? e.message : '操作失败，请重试。'); } finally { setBusy(''); }
  };

  if (!data) return <div className="page-narrow">{error ? <p className="notice notice-error"><span className="icon">!</span><span>{error}</span></p> : <p className="muted">正在载入…</p>}</div>;
  const t = data.twin;

  return (
    <div className="page-narrow">
      <p className="muted small"><Link to="/me">← 我</Link></p>
      <h1>数字分身</h1>
      <p className="muted">平台根据你同意使用的资料整理出的“学习者模型”。用来照镜子、预演复盘和复试、对话未来的自己。它只是草稿的作者，<strong>不能替你确认、提交、打卡或参加考核</strong>。</p>
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}

      {!t.consented && (
        <section className="section">
          <h2>第1步 · 知情同意</h2>
          <ul>
            <li><strong>会用到哪些资料：</strong>你在下一步逐项开启的平台数据（访谈与画像、路径、打卡、长期记忆、阅读卡、复试记录、会议纪要），以及你自己上传并确认过的资料。</li>
            <li><strong>谁能看到：</strong>只有你本人。教师、同学、评委都看不到，也不用于任何评分。</li>
            <li><strong>敏感信息：</strong>上传的文字会先自动遮盖身份证号、手机号、住址、家庭经济和健康信息，原文不入库；你核对后才会被使用。</li>
            <li><strong>怎么删除：</strong>随时可以点“删除分身”，档案、上传资料、校正记录和分身对话都会被清除，不可恢复；你的长期记忆和其他学习数据不受影响。</li>
            <li><strong>它是什么：</strong>它是 AI 根据资料整理的模型，不是另一个人。它说的话都标着“分身推测”，资料不足时会说“不确定”。</li>
          </ul>
          <label className="check"><input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /><span>我已了解并同意以上说明</span></label>
          <button type="button" className="btn btn-primary" disabled={!agreed || busy === 'consent'} onClick={() => void run('consent', () => api<TwinResp>('/twin/consent', { body: { agreed: true } }), '已同意，可以开始建立分身')}>
            开始建立分身
          </button>
        </section>
      )}

      {t.consented && (
        <>
          <NameSection data={data} busy={busy} run={run} />
          <SourcesSection data={data} busy={busy} run={run} />
          <UploadSection data={data} run={run} busy={busy} onError={setError} />
          <ProfileSection data={data} busy={busy} run={run} />
          {t.built && <TalkSection name={t.name || '镜中我'} purposes={data.purposes} />}
          <CorrectionsSection data={data} />
          <section className="section">
            <h2>删除分身</h2>
            <p className="muted small">删除档案、上传资料、校正记录和分身对话（含会议里分身的发言），不可恢复。长期记忆和其他学习数据不受影响。</p>
            <button type="button" className="btn btn-text btn-danger" disabled={busy === 'delete'}
              onClick={() => {
                const word = window.prompt('删除后无法恢复。确认删除请输入：删除分身');
                if (word !== '删除分身') { if (word !== null) toast('输入不一致，没有删除', 'warn'); return; }
                void run('delete', async () => { await api('/twin', { method: 'DELETE', body: { confirm: '删除分身' } }); return api<TwinResp>('/twin'); }, '分身已删除');
              }}>
              删除分身
            </button>
          </section>
        </>
      )}
      <p className="muted small">{data.note}</p>
    </div>
  );
}

type Run = (label: string, fn: () => Promise<TwinResp | void>, ok?: string) => Promise<void>;

function NameSection({ data, busy, run }: { data: TwinResp; busy: string; run: Run }) {
  const [name, setName] = useState(data.twin.name || '镜中我');
  return (
    <section className="section">
      <h2>名字与图标</h2>
      <div className="row">
        <span className="twin-avatar" aria-hidden="true"><MentorGlyph icon={data.twin.icon || 'mirror'} /></span>
        <input className="input" style={{ maxWidth: 200 }} maxLength={12} aria-label="分身名字" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" className="btn btn-sm" disabled={busy === 'name' || name === data.twin.name} onClick={() => void run('name', () => api<TwinResp>('/twin', { method: 'PUT', body: { name } }), '已改名')}>保存名字</button>
      </div>
      <div className="chips" style={{ marginTop: 12 }} role="radiogroup" aria-label="分身图标">
        {data.icons.map((ic) => (
          <button key={ic} type="button" className="chip" role="radio" aria-checked={data.twin.icon === ic} aria-label={`图标 ${ic}`}
            onClick={() => void run('icon', () => api<TwinResp>('/twin', { method: 'PUT', body: { icon: ic } }))}>
            <span className="twin-avatar sm" aria-hidden="true"><MentorGlyph icon={ic} /></span>
          </button>
        ))}
      </div>
      <p className="muted small">只能选原创抽象图标，不使用真人照片。</p>
    </section>
  );
}

function SourcesSection({ data, busy, run }: { data: TwinResp; busy: string; run: Run }) {
  const s = data.twin.sources || {};
  return (
    <section className="section">
      <h2>第2步 · 数据来源</h2>
      <p className="muted small">逐项决定分身能看到什么。关掉的来源一个字都不会交给分身整理器。改动后重新生成档案才生效。</p>
      <ul className="check-list">
        {data.sources.map((x) => (
          <li key={x.key}>
            <label className="check">
              <input type="checkbox" checked={s[x.key] !== false} disabled={busy === `src-${x.key}`}
                onChange={(e) => void run(`src-${x.key}`, () => api<TwinResp>('/twin/sources', { method: 'PUT', body: { [x.key]: e.target.checked } }))} />
              <span>{x.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

function UploadSection({ data, busy, run, onError }: { data: TwinResp; busy: string; run: Run; onError: (s: string) => void }) {
  const toast = useToast();
  const [kind, setKind] = useState(data.upload_kinds[0]);
  const [pasted, setPasted] = useState('');
  const [preview, setPreview] = useState<{ id: number; text: string; note: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const send = async (body: Record<string, unknown>) => {
    onError('');
    try {
      const r = await api<{ upload: { id: number }; preview: string; note: string }>('/twin/uploads', { body: { ...body, kind } });
      setPreview({ id: r.upload.id, text: r.preview, note: r.note });
      setPasted('');
      if (fileRef.current) fileRef.current.value = '';
      await run('reload', () => api<TwinResp>('/twin'));
    } catch (e) { onError(e instanceof ApiError ? e.message : '上传失败。'); }
  };

  return (
    <section className="section">
      <h2>第3步 · 上传个人资料（可选）</h2>
      <p className="muted small">简历、自我介绍稿、学习日志、成绩概况、获奖与项目经历、课程论文片段（只用于学习表达风格）。支持 PDF、Word（.docx）、TXT、Markdown；图片暂不支持，请改传文字。建议上传前自己先打码。</p>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="tw-kind">资料类型</label>
          <select id="tw-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value)}>
            {data.upload_kinds.map((k) => <option key={k}>{k}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tw-file">选择文件</label>
          <input id="tw-file" ref={fileRef} type="file" className="input" accept=".pdf,.docx,.txt,.md" disabled={busy === 'upload'}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              await send({ data: await readFileBase64(f), filename: f.name });
            }} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="tw-paste">或者直接粘贴文字</label>
        <textarea id="tw-paste" className="textarea" maxLength={20000} value={pasted} onChange={(e) => setPasted(e.target.value)} />
      </div>
      <button type="button" className="btn btn-sm" disabled={!pasted.trim()} onClick={() => void send({ text: pasted, filename: `${kind}.txt` })}>上传这段文字</button>

      {preview && (
        <div className="kb-form">
          <p className="small" style={{ marginTop: 0 }}>{preview.note}</p>
          <pre className="twin-preview">{preview.text}</pre>
          <div className="row">
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void run('confirm', async () => { const r = await api<TwinResp>(`/twin/uploads/${preview.id}/confirm`, { body: {} }); setPreview(null); toast('已确认，下次生成档案时会用到'); return r; })}>确认使用</button>
            <button type="button" className="btn btn-text btn-sm" onClick={() => void run('del', async () => { const r = await api<TwinResp>(`/twin/uploads/${preview.id}`, { method: 'DELETE' }); setPreview(null); return r; })}>删掉这份</button>
          </div>
        </div>
      )}

      {!!data.uploads.length && (
        <ul className="list" style={{ marginTop: 12 }}>
          {data.uploads.map((u) => (
            <li key={u.id} className="row">
              <strong>{u.filename}</strong>
              <span className="badge badge-muted">{u.kind}</span>
              <span className={`badge ${u.confirmed ? 'badge-ok' : 'badge-warn'}`}>{u.confirmed ? '已确认' : '待确认'}</span>
              <span className="muted small">{u.chars} 字{u.redaction_log.length ? `；已遮盖 ${u.redaction_log.map((l) => `${l.type}${l.count}处`).join('、')}` : ''}</span>
              <span className="spacer" />
              {!u.confirmed && (
                <button type="button" className="btn btn-text btn-sm" onClick={async () => {
                  const r = await api<{ preview: string }>(`/twin/uploads/${u.id}`);
                  setPreview({ id: u.id, text: r.preview, note: '请核对遮盖后的内容，没问题再确认。' });
                }}>核对</button>
              )}
              <button type="button" className="btn btn-text btn-sm" onClick={() => void run('del', () => api<TwinResp>(`/twin/uploads/${u.id}`, { method: 'DELETE' }))}>删除</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ProfileSection({ data, busy, run }: { data: TwinResp; busy: string; run: Run }) {
  const p = data.twin.profile;
  const [showGuess, setShowGuess] = useState(false);
  const [editing, setEditing] = useState<{ section: string; id: string; text: string } | null>(null);
  const [adding, setAdding] = useState<{ section: string; text: string } | null>(null);
  const correct = (body: Record<string, unknown>, ok?: string) => run('corr', () => api<TwinResp>('/twin/corrections', { body }), ok);

  return (
    <section className="section">
      <div className="row">
        <h2 style={{ margin: 0 }}>第4步 · 分身档案（照镜子）</h2>
        <span className="spacer" />
        <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'build'} onClick={() => void run('build', () => api<TwinResp>('/twin/build', { body: {} }), '档案已更新，锁定的条目没有被改动')}>
          {busy === 'build' ? '正在整理…' : data.twin.built ? '重新生成档案' : '生成分身档案'}
        </button>
      </div>
      {data.suggestion && <p className="notice notice-ok" style={{ marginTop: 12 }}><span className="icon">→</span><span>{data.suggestion.text}</span></p>}
      {!data.twin.built && <p className="muted">还没有档案。点右上角生成，大约需要十几秒。</p>}
      {data.twin.built && p && (
        <>
          <p className="muted small">每一条都标着来源和可信度（原话 / 数据 / 推测）。你可以确认、修改、删除或锁定；<strong>锁定的条目重新生成时不会被覆盖</strong>。版本 {data.twin.version}，更新于 {data.twin.updated_at}。</p>
          <label className="check"><input type="checkbox" checked={showGuess} onChange={(e) => setShowGuess(e.target.checked)} /><span>显示“推测”条目（默认折叠）</span></label>
          {data.sections.map((s) => {
            const items = (p[s.key] || []).filter((it: TwinItem) => showGuess || it.confidence !== '推测');
            const hidden = (p[s.key] || []).length - items.length;
            return (
              <div key={s.key} className="twin-section">
                <div className="row">
                  <h3 style={{ margin: 0 }}>{s.label}</h3>
                  {hidden > 0 && <span className="muted small">（另有 {hidden} 条推测已折叠）</span>}
                  <span className="spacer" />
                  <button type="button" className="btn btn-text btn-sm" onClick={() => setAdding({ section: s.key, text: '' })}>＋ 补充一条</button>
                </div>
                {!items.length && <p className="muted small">资料里还看不出来。</p>}
                <ul className="list">
                  {items.map((it: TwinItem) => (
                    <li key={it.id}>
                      {editing?.id === it.id ? (
                        <div className="row">
                          <input className="input" style={{ flex: 1 }} maxLength={200} value={editing.text} aria-label="修改档案条目" onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => void correct({ action: 'edit', section: s.key, id: it.id, text: editing.text }, '已修改').then(() => setEditing(null))}>保存</button>
                          <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing(null)}>取消</button>
                        </div>
                      ) : (
                        <div className="row">
                          <span style={{ flex: 1, minWidth: 200 }}>{it.text}</span>
                          <span className={`badge ${CONF_CLASS[it.confidence] || 'badge-muted'}`}>{it.confidence}</span>
                          <span className="muted small">来源：{it.source}</span>
                          {it.locked && <span className="badge badge-ok">已锁定</span>}
                          {!it.locked && it.confirmed && <span className="badge badge-ok">已确认</span>}
                          {!it.confirmed && <button type="button" className="btn btn-text btn-sm" onClick={() => void correct({ action: 'confirm', section: s.key, id: it.id })}>确认</button>}
                          <button type="button" className="btn btn-text btn-sm" onClick={() => setEditing({ section: s.key, id: it.id, text: it.text })}>修改</button>
                          <button type="button" className="btn btn-text btn-sm" onClick={() => void correct({ action: it.locked ? 'unlock' : 'lock', section: s.key, id: it.id }, it.locked ? '已解锁' : '已锁定，重新生成时不会改它')}>{it.locked ? '解锁' : '锁定'}</button>
                          <button type="button" className="btn btn-text btn-sm" onClick={() => void correct({ action: 'delete', section: s.key, id: it.id }, '已删除')}>删除</button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {adding?.section === s.key && (
                  <div className="row">
                    <input className="input" style={{ flex: 1 }} maxLength={200} value={adding.text} placeholder="用一句话补充" aria-label={`补充${s.label}`} onChange={(e) => setAdding({ ...adding, text: e.target.value })} />
                    <button type="button" className="btn btn-primary btn-sm" disabled={!adding.text.trim()} onClick={() => void correct({ action: 'add', section: s.key, text: adding.text, lock: true }, '已补充并锁定').then(() => setAdding(null))}>添加</button>
                    <button type="button" className="btn btn-text btn-sm" onClick={() => setAdding(null)}>取消</button>
                  </div>
                )}
              </div>
            );
          })}
          {!!p.open_questions?.length && (
            <div className="twin-section">
              <h3>还需要你本人补充的</h3>
              <ul>{p.open_questions.map((q) => <li key={q}>{q}</li>)}</ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function TalkSection({ name, purposes }: { name: string; purposes: Record<string, string> }) {
  const [purpose, setPurpose] = useState('future');
  const [convId, setConvId] = useState<number | null>(null);
  const [lines, setLines] = useState<{ role: 'user' | 'twin'; content: string }[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ conversations: TwinTalk[] }>(`/twin/talks?purpose=${purpose}`).then((r) => {
      const c = r.conversations[0];
      setConvId(c?.id ?? null);
      setLines(c ? c.transcript.map((x) => ({ role: x.role, content: x.content })) : []);
    }).catch(() => {});
  }, [purpose]);

  const send = async () => {
    const t = draft.trim();
    if (!t) return;
    setError(null); setDraft('');
    setLines((x) => [...x, { role: 'user', content: t }]);
    setStreaming('');
    try {
      await streamPost('/twin/talk', { purpose, text: t, conv_id: convId }, {
        onEvent: (ev, d) => {
          if (ev === 'delta') setStreaming((s) => (s ?? '') + d.text);
          else if (ev === 'done') { setConvId(d.conv_id); setLines((x) => [...x, { role: 'twin', content: d.reply }]); }
          else if (ev === 'error') { setError(new ApiError(0, d.code, d.message)); setDraft(d.restore_text || t); setLines((x) => x.slice(0, -1)); }
        },
      }, { withKey: true });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', '网络连接失败。'));
      setDraft(t); setLines((x) => x.slice(0, -1));
    } finally { setStreaming(null); }
  };

  const hint: Record<string, string> = {
    future: '和“已经达成目标的我”对话，帮你想清楚动机和当下该做的小事。全程是想象，不是承诺。',
    meeting: '预演一下：如果分身替你在周复盘会上发言，它会怎么说？看看它说得对不对。',
    rehearsal: '复试彩排：你扮演考官提问，分身按你过往的表达习惯作答，帮你看见自己的习惯性弱点。',
  };

  return (
    <section className="section">
      <h2>第5步 · 让分身说说话</h2>
      <div className="tabs" role="tablist">
        {Object.entries(purposes).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={purpose === k} className={purpose === k ? 'active' : ''} onClick={() => setPurpose(k)}>
            {k === 'future' ? '对话未来的自己' : k === 'meeting' ? '预演复盘会' : '复试彩排'}
            <span className="sr-only">（{label}）</span>
          </button>
        ))}
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>{hint[purpose]} 需要你自己的 Key。分身说的一切都是草稿。</p>
      <div className="msgs">
        {lines.map((l, i) => (l.role === 'user'
          ? <div key={i} className="msg msg-user">{l.content}</div>
          : <div key={i} className="msg msg-twin"><div className="msg-meta"><span>{name}</span><span className="twin-tag">分身推测</span><span className="badge badge-muted">草稿</span></div><Markdown text={l.content} /></div>))}
        {streaming !== null && <div className="msg msg-twin"><div className="msg-meta"><span>{name}</span><span className="twin-tag">分身推测</span></div>{streaming ? <Markdown text={streaming} /> : <p className="stream-status">正在想…</p>}</div>}
      </div>
      {error && (
        <div className="notice notice-error" role="alert"><span className="icon">!</span>
          <span>{error.message}{error.code === 'NEED_USER_KEY' && <> <Link to="/me/keys">去设置</Link></>}</span>
        </div>
      )}
      <div className="composer-row">
        <label htmlFor="twin-input" className="sr-only">对分身说</label>
        <textarea id="twin-input" className="textarea" rows={2} maxLength={1000} value={draft} onChange={(e) => setDraft(e.target.value)}
          placeholder={purpose === 'rehearsal' ? '以考官身份提一个问题，比如：请介绍一下你的研究兴趣' : '想对分身说什么'}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} />
        <button type="button" className="btn btn-primary" disabled={streaming !== null || !draft.trim()} onClick={() => void send()}>发送</button>
      </div>
      <p className="muted small">如果你感到很难受，请联系辅导员、学校心理咨询中心，或拨打 12356 心理援助热线。</p>
    </section>
  );
}

function CorrectionsSection({ data }: { data: TwinResp }) {
  if (!data.corrections.length) return null;
  return (
    <section className="section">
      <h2>校正记录</h2>
      <ul className="list small">
        {data.corrections.map((c) => (
          <li key={c.id}><span className="muted">{c.created_at}</span>　【{c.field}】{c.before_text ? `“${c.before_text}” → ` : ''}{c.after_text}</li>
        ))}
      </ul>
    </section>
  );
}
