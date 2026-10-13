// 书房 · 学术进阶（第8站，M11）：检索 → 阅读 → 分类 → 选题
// 四位导师各有工作台；检索与核验人人可用，四类对话需要学生自己的 Key
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type {
  CardsResp, ClassifySuggestion, IdeasResp, MenuDef, PapersResp, PaperRow, PdfExtractResp,
  ReadingCard, ReadingLogResp, SearchResp, TopicIdea, TopicsResp,
} from '../api/types2';
import { StationShell } from './Road';
import { ChatPanel, type ConvSummary } from '../components/ChatPanel';
import { MenuForm } from '../components/MenuForm';
import { useToast } from '../components/Toast';
import { EmptyHint, VerifyBadge, readFileBase64 } from './StudyShared';
import { getAgent } from '../registry';

type Tab = 'search' | 'read' | 'classify' | 'topic' | 'library';

const MENTORS: { key: Tab; agent: string; label: string; duty: string }[] = [
  { key: 'search', agent: 'research_search', label: '寻源', duty: '检索导师' },
  { key: 'read', agent: 'research_read', label: '照卷', duty: '阅读导师' },
  { key: 'classify', agent: 'research_classify', label: '织理', duty: '分类导师' },
  { key: 'topic', agent: 'research_topic', label: '问枢', duty: '选题导师' },
];

export default function Station8() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('search');
  const [error, setError] = useState('');
  const onError = setError;
  const [papers, setPapers] = useState<PaperRow[]>([]);
  const [reload, setReload] = useState(0);
  const bump = () => setReload((n) => n + 1);

  const loadPapers = useCallback(async () => {
    const r = await api<PapersResp>('/papers');
    setPapers(r.papers);
  }, []);

  useEffect(() => { loadPapers().catch((e) => onError((e as Error).message)); }, [loadPapers, reload, onError]);

  return (
    <StationShell station={8}>
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}

      <div className="notice notice-warn" style={{ marginBottom: 16 }}>
        <span className="icon">!</span>
        <span>
          这一站<strong>不做</strong>论文写作、润色、改写、翻译成稿、排版和投稿。平台只帮你检索、读懂、理清、收敛问题——
          文字和判断必须是你自己的。需要帮忙时，先去 <Link to="/me/keys">我 → 高阶模型 Key</Link> 填一次自己的 Key。
        </span>
      </div>

      <div className="tabs" role="tablist">
        {MENTORS.map((m) => (
          <button key={m.key} type="button" role="tab" aria-selected={tab === m.key} className={tab === m.key ? 'active' : ''} onClick={() => { setTab(m.key); onError(''); }}>
            {m.label}·{m.duty}
          </button>
        ))}
        <button type="button" role="tab" aria-selected={tab === 'library'} className={tab === 'library' ? 'active' : ''} onClick={() => setTab('library')}>
          我的文献（{papers.length}）
        </button>
      </div>

      {tab === 'search' && <SearchDesk papers={papers} onError={onError} onToast={toast} onChanged={bump} />}
      {tab === 'read' && <ReadDesk papers={papers} onError={onError} onToast={toast} onChanged={bump} />}
      {tab === 'classify' && <ClassifyDesk papers={papers} onError={onError} onToast={toast} onChanged={bump} />}
      {tab === 'topic' && <TopicDesk papers={papers} onError={onError} onToast={toast} onChanged={bump} />}
      {tab === 'library' && <LibraryDesk papers={papers} onError={onError} onToast={toast} onChanged={bump} />}
    </StationShell>
  );
}

/** 菜单阶段 + 对话：四位导师共用的外壳。菜单先点选，再进入对话。 */
function MentorDesk({
  menuFlow, kind, agentKey, onError, extra, children,
}: {
  menuFlow: string; kind: string; agentKey: string;
  onError: (s: string) => void;
  extra?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const [menu, setMenu] = useState<MenuDef | null>(null);
  const [saved, setSaved] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [convId, setConvId] = useState<number | null | undefined>(undefined);
  const [chatKey, setChatKey] = useState(0);
  const [list, setList] = useState<ConvSummary[]>([]);

  const load = useCallback(async () => {
    const m = await api<MenuDef>(`/menus/${menuFlow}`);
    setMenu(m);
    setSaved(m.answers);
  }, [menuFlow]);

  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  const submitMenu = async (answers: Record<string, unknown>) => {
    setBusy(true); onError('');
    try {
      await api(`/menus/${menuFlow}`, { body: { answers } });
      setSaved(answers);
      setConvId(null);
      setChatKey((k) => k + 1);
    } catch (e) { onError(e instanceof ApiError ? e.message : '保存失败，请重试。'); } finally { setBusy(false); }
  };

  const agent = getAgent(agentKey);

  return (
    <>
      {agent && (
        <section className="section" style={{ marginTop: 16 }}>
          <p className="muted small">{agent.summary}</p>
        </section>
      )}

      {extra}

      <section className="section">
        <div className="row">
          <h2 style={{ margin: 0 }}>{saved ? '你想调整什么' : '先点选几个问题'}</h2>
          <span className="spacer" />
          {!!list.length && (
            <select
              className="select" style={{ width: 'auto' }}
              value={convId ?? list[0]?.id ?? ''}
              aria-label="历史对话"
              onChange={(e) => { setConvId(Number(e.target.value)); setChatKey((k) => k + 1); }}
            >
              {list.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          )}
          <button type="button" className="btn btn-text" onClick={() => { setConvId(null); setChatKey((k) => k + 1); }}>新对话</button>
        </div>
        {menu ? (
          <MenuForm def={{ ...menu, answers: saved }} submitting={busy} submitLabel={saved ? '保存并继续对话' : '开始对话'} onSubmit={(a) => void submitMenu(a)} />
        ) : (
          <p className="muted">正在载入…</p>
        )}
      </section>

      {children}

      {(saved || children) && (
        <section className="section">
          <h2>和{agent?.name || agentKey}讨论</h2>
          <ChatPanel key={chatKey} kind={kind} agentKey={agentKey} convId={convId} onListChange={(l) => setList(l)} />
        </section>
      )}
    </>
  );
}

// ---------- 寻源：检索导师 ----------

function SearchDesk({ papers, onError, onToast, onChanged }: DeskProps) {
  const [adding, setAdding] = useState<string | null>(null);

  const addPaper = async (w: PaperRow) => {
    const k = w.work_id || w.doi || w.title;
    setAdding(k);
    onError('');
    try {
      const r = await api<{ paper: PaperRow; duplicated: boolean }>('/papers', {
        body: {
          title: w.title, authors: w.authors, year: w.year, venue: w.venue, doi: w.doi,
          url: w.url, abstract: w.abstract, lang: w.lang, source: 'openalex',
        },
      });
      onToast(r.duplicated ? '这篇已经在知识库里了' : '已加入知识库');
      onChanged();
    } catch (e) { onError(e instanceof ApiError ? e.message : '加入失败。'); } finally { setAdding(null); }
  };

  return (
    <MentorDesk menuFlow="research" kind="research_search" agentKey="research_search" onError={onError}
      extra={<QuickSearch inLibrary={(t, d) => papers.some((p) => (d && p.doi.toLowerCase() === d.toLowerCase()) || p.title === t)} onAdd={addPaper} adding={adding} onError={onError} />}
    />
  );
}

/** 关键词检索：不调用大模型，不绑定 Key 也能用 */
function QuickSearch({ inLibrary, onAdd, adding, onError }: {
  inLibrary: (title: string, doi: string) => boolean;
  onAdd: (w: PaperRow) => void;
  adding: string | null;
  onError: (s: string) => void;
}) {
  const [q, setQ] = useState('');
  const [lang, setLang] = useState('');
  const [yearFrom, setYearFrom] = useState('');
  const [out, setOut] = useState<SearchResp | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!q.trim()) { onError('先填要检索的关键词。'); return; }
    setBusy(true); onError('');
    try {
      setOut(await api<SearchResp>('/papers/search', { body: { query: q.trim(), limit: 10, lang, year_from: yearFrom || null } }));
    } catch (e) { onError(e instanceof ApiError ? e.message : '检索失败，请稍后再试。'); } finally { setBusy(false); }
  };

  return (
    <section className="section">
      <h2>关键词检索</h2>
      <p className="muted small">
        检索结果来自 <strong>OpenAlex</strong>，是真实存在的文献，不是模型生成的。中文文献覆盖有限，
        找不到时平台会提示你去知网检索后导出。
      </p>
      <div className="grid-3">
        <div className="field">
          <label htmlFor="qs-q">关键词</label>
          <input id="qs-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="例如：生成式人工智能 教育评价"
            onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} />
        </div>
        <div className="field">
          <label htmlFor="qs-lang">语言</label>
          <select id="qs-lang" className="select" value={lang} onChange={(e) => setLang(e.target.value)}>
            <option value="">不限</option>
            <option value="zh">中文</option>
            <option value="en">英文</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="qs-year">起始年份</label>
          <input id="qs-year" className="input" inputMode="numeric" maxLength={4} value={yearFrom} onChange={(e) => setYearFrom(e.target.value.replace(/\D/g, ''))} placeholder="留空不限" />
        </div>
      </div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run()}>{busy ? '正在检索…' : '检索'}</button>

      {out?.zh_coverage_low && (
        <div className="notice notice-warn" style={{ marginTop: 12 }}>
          <span className="icon">!</span>
          <span>中文文献覆盖不足。建议去<strong>知网</strong>检索，导出 RIS 或 EndNote 文件，回 <Link to="/road/7">建知识库</Link> 里导入。平台不会为了凑数编造中文文献。</span>
        </div>
      )}

      {out && (
        <>
          <p className="muted small" style={{ marginTop: 12 }}>
            关键词「{out.query}」共 {out.total} 条，下面显示前 {out.works.length} 条。{out.mock_hint}
          </p>
          {!out.works.length && <EmptyHint>没有找到结果。换一组更宽的关键词再试，或去知网检索。</EmptyHint>}
          <ul className="list">
            {out.works.map((w) => (
              <li key={w.work_id}>
                <div className="row">
                  <strong>{w.title}</strong>
                  <span className="spacer" />
                  {inLibrary(w.title, w.doi) ? (
                    <span className="badge badge-ok">已在知识库</span>
                  ) : (
                    <button type="button" className="btn btn-sm" disabled={adding === (w.work_id || w.doi || w.title)} onClick={() => onAdd(w)}>
                      {adding === (w.work_id || w.doi || w.title) ? '加入中…' : '加入知识库'}
                    </button>
                  )}
                </div>
                <p className="small muted" style={{ margin: '4px 0 0' }}>
                  {w.authors.slice(0, 3).join('、')}{w.authors.length > 3 ? ' 等' : ''}｜{w.year || '年份不详'}｜{w.venue || '来源未标注'}
                  {w.cited_by !== null && w.cited_by !== undefined ? `｜被引 ${w.cited_by}` : ''}
                </p>
                {w.doi && <p className="small muted" style={{ margin: '2px 0 0' }}>DOI: {w.doi}</p>}
                {w.abstract && <p className="small" style={{ margin: '4px 0 0' }}>{w.abstract.slice(0, 240)}{w.abstract.length > 240 ? '…' : ''}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ---------- 照卷：阅读导师 ----------

function ReadDesk({ papers, onError, onToast, onChanged }: DeskProps) {
  const [pdf, setPdf] = useState<PdfExtractResp | null>(null);
  const [filename, setFilename] = useState('');
  const [busy, setBusy] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [cards, setCards] = useState<ReadingCard[]>([]);
  const [log, setLog] = useState<ReadingLogResp | null>(null);
  const [editing, setEditing] = useState<ReadingCard | null>(null);

  const load = useCallback(async () => {
    const [c, l] = await Promise.all([api<CardsResp>('/cards'), api<ReadingLogResp>('/reading-log')]);
    setCards(c.cards); setLog(l);
  }, []);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  const upload = async (file: File | null) => {
    if (!file) return;
    setBusy(true); onError('');
    try {
      const data = await readFileBase64(file);
      const r = await api<PdfExtractResp>('/papers/pdf', { body: { data, filename: file.name } });
      setPdf(r);
      setFilename(file.name);
      if (!r.hasText) onError('这个 PDF 里没有可提取的文字（可能是扫描件）。可以改用摘要精读。');
    } catch (e) { onError(e instanceof ApiError ? e.message : 'PDF 读取失败。'); } finally { setBusy(false); }
  };

  const attach = async () => {
    if (!pdf || !targetId) { onError('先上传 PDF，再选一篇要挂上去的文献。'); return; }
    setBusy(true); onError('');
    try {
      await api(`/papers/${targetId}`, { method: 'PUT', body: { fulltext: pdf.text } });
      onToast('全文已挂到这篇文献上，照卷看得更准了');
      setPdf(null); setFilename('');
      onChanged();
    } catch (e) { onError(e instanceof ApiError ? e.message : '保存失败。'); } finally { setBusy(false); }
  };

  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <h2>上传 PDF（选填）</h2>
        <p className="muted small">
          上传后平台<strong>只提取文字，不留存原件</strong>。提取的正文会挂到你选的那篇文献上，供照卷精读时参考。
          没有 PDF 也能读——照卷会只依据摘要追问，看不到的地方他会明说。
        </p>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="rd-file">选择 PDF</label>
            <input id="rd-file" type="file" className="input" accept="application/pdf,.pdf" disabled={busy} onChange={(e) => void upload(e.target.files?.[0] || null)} />
          </div>
          <div className="field">
            <label htmlFor="rd-target">挂到哪篇文献</label>
            <select id="rd-target" className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">请选择…</option>
              {papers.map((p) => <option key={p.id} value={p.id}>{p.title.slice(0, 40)}</option>)}
            </select>
          </div>
        </div>
        {pdf && (
          <div className="notice notice-ok" style={{ marginTop: 4 }}>
            <span className="icon">✓</span>
            <span>
              {filename}：{pdf.page_count} 页，提取 {pdf.chars} 字。
              {pdf.suggested_title && <> 推测题名「{pdf.suggested_title}」。</>}
              {pdf.note}
            </span>
          </div>
        )}
        {pdf && (
          <div className="field">
            <label htmlFor="rd-preview">提取正文（前 400 字，核对一下有没有乱码）</label>
            <textarea id="rd-preview" className="textarea" readOnly value={pdf.text.slice(0, 400)} />
          </div>
        )}
        <button type="button" className="btn" disabled={busy || !pdf || !targetId} onClick={() => void attach()}>挂到这篇文献</button>
      </section>

      <MentorDesk menuFlow="research_read" kind="research_read" agentKey="research_read" onError={onError} />

      <section className="section">
        <div className="row">
          <h2 style={{ margin: 0 }}>我的阅读卡（{cards.length}）</h2>
          <span className="spacer" />
          {log && <span className="badge badge-muted">近7天 {log.last7.entries} 次，{log.last7.minutes} 分钟</span>}
        </div>
        <p className="muted small">
          <strong>“我的判断”只能由你自己写。</strong>AI 起草的部分会单独标出来，需要你核对后再定稿。
        </p>
        {!cards.length ? (
          <EmptyHint>还没有阅读卡。和照卷精读完一篇，他就会帮你起草第一张。</EmptyHint>
        ) : (
          <ul className="list">
            {cards.map((c) => (
              <li key={c.id}>
                <div className="row">
                  <strong>{c.paper?.title || `阅读卡 ${c.id}`}</strong>
                  {c.paper && <VerifyBadge status={c.paper.verify_status as PaperRow['verify_status']} />}
                  <span className="spacer" />
                  <span className="muted small">{c.created_at}</span>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(editing?.id === c.id ? null : c)}>
                    {editing?.id === c.id ? '收起' : '编辑'}
                  </button>
                </div>
                {editing?.id === c.id ? (
                  <CardEditor card={c} onError={onError} onToast={onToast} onSaved={() => { setEditing(null); void load(); }} />
                ) : (
                  <>
                    <p className="small" style={{ margin: '4px 0 0' }}><strong>研究问题：</strong>{c.question || '（空）'}</p>
                    {c.my_judgment ? (
                      <p className="small" style={{ margin: '2px 0 0' }}><strong>我的判断：</strong>{c.my_judgment}</p>
                    ) : (
                      <p className="small" style={{ margin: '2px 0 0', color: 'var(--c-warn)' }}>⚠️ “我的判断”还是空的——点编辑，用自己的话写一句。</p>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function CardEditor({ card, onError, onToast, onSaved }: {
  card: ReadingCard; onError: (s: string) => void; onToast: (s: string) => void; onSaved: () => void;
}) {
  const [f, setF] = useState({
    question: card.question, method: card.method, evidence: card.evidence,
    conclusion: card.conclusion, limitation: card.limitation, my_judgment: card.my_judgment,
  });
  const [doubts, setDoubts] = useState(card.doubts.join('\n'));
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const save = async () => {
    setBusy(true); onError('');
    try {
      await api(`/cards/${card.id}`, { method: 'PUT', body: { ...f, doubts: doubts.split('\n').map((s) => s.trim()).filter(Boolean) } });
      onToast('阅读卡已保存');
      onSaved();
    } catch (e) { onError(e instanceof ApiError ? e.message : '保存失败。'); } finally { setBusy(false); }
  };

  const fields: { k: keyof typeof f; label: string; hint?: string }[] = [
    { k: 'question', label: '研究问题' },
    { k: 'method', label: '方法' },
    { k: 'evidence', label: '证据' },
    { k: 'conclusion', label: '结论' },
    { k: 'limitation', label: '局限' },
    { k: 'my_judgment', label: '我的判断', hint: '这一栏必须是你自己的话，AI 不许代写' },
  ];

  return (
    <div className="kb-form" style={{ marginTop: 8 }}>
      {card.ai_note && <p className="muted small">AI 说明：{card.ai_note}</p>}
      {fields.map((x) => (
        <div className="field" key={x.k}>
          <label htmlFor={`card-${x.k}`}>{x.label}{x.hint && <span className="muted small">（{x.hint}）</span>}</label>
          <textarea id={`card-${x.k}`} className="textarea" maxLength={2000} value={f[x.k]} onChange={(e) => set(x.k, e.target.value)} />
        </div>
      ))}
      <div className="field">
        <label htmlFor="card-doubts">我的疑问（一行一条）</label>
        <textarea id="card-doubts" className="textarea" value={doubts} onChange={(e) => setDoubts(e.target.value)} />
      </div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存阅读卡'}</button>
    </div>
  );
}

// ---------- 织理：分类导师 ----------

function ClassifyDesk({ papers, onError, onToast, onChanged }: DeskProps) {
  const [sug, setSug] = useState<ClassifySuggestion | null>(null);
  const [busy, setBusy] = useState(false);
  const [topics, setTopics] = useState<TopicsResp['topics']>([]);
  const [checked, setChecked] = useState<Record<string, number[]>>({});
  const [granularity, setGranularity] = useState('细');
  const [basis, setBasis] = useState('主题');

  const loadTopics = useCallback(async () => {
    const r = await api<TopicsResp>('/topics');
    setTopics(r.topics);
  }, []);
  useEffect(() => { loadTopics().catch((e) => onError((e as Error).message)); }, [loadTopics, onError]);

  const suggest = async () => {
    setBusy(true); onError('');
    try {
      // 织理的分类粒度与依据走菜单记录（不调用大模型），再交给分类接口
      await api('/menus/research_classify', { body: { answers: { granularity, basis } } }).catch(() => {});
      const r = await api<ClassifySuggestion>('/topics/suggest', { body: { granularity, basis }, withKey: true });
      setSug(r);
      const init: Record<string, number[]> = {};
      for (const t of r.topics) init[t.name] = t.paper_ids;
      setChecked(init);
    } catch (e) { onError(e instanceof ApiError ? e.message : '分类失败，请重试。'); } finally { setBusy(false); }
  };

  const apply = async () => {
    if (!sug) return;
    setBusy(true); onError('');
    try {
      const r = await api<{ topics: number; tagged: number }>('/topics/apply', {
        body: {
          topics: sug.topics.map((t) => ({ name: t.name, parent: t.parent, desc: t.desc, paper_ids: checked[t.name] || [] })),
          tags: sug.tags,
        },
      });
      onToast(`已建 ${r.topics} 个主题，${r.tagged} 篇文献归位`);
      setSug(null);
      await loadTopics();
      onChanged();
    } catch (e) { onError(e instanceof ApiError ? e.message : '保存失败。'); } finally { setBusy(false); }
  };

  const togglePaper = (topic: string, id: number) => {
    setChecked((x) => {
      const cur = x[topic] || [];
      return { ...x, [topic]: cur.includes(id) ? cur.filter((y) => y !== id) : [...cur, id] };
    });
  };

  const paperTitle = (id: number) => papers.find((p) => p.id === id)?.title || `#${id}`;

  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <h2>一键理主题</h2>
        <p className="muted small">
          织理读你知识库里的文献和阅读卡，给出主题树、标签和研究空白。<strong>空白必须有依据</strong>——
          它会指出是哪几篇文献让你看到这个空白的。建议先由你确认，再落库。
        </p>
        <div className="grid-3">
          <div className="field">
            <label htmlFor="cl-gran">分类粒度</label>
            <select id="cl-gran" className="select" value={granularity} onChange={(e) => setGranularity(e.target.value)}>
              <option value="粗">粗</option>
              <option value="细">细</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="cl-basis">按什么分</label>
            <select id="cl-basis" className="select" value={basis} onChange={(e) => setBasis(e.target.value)}>
              <option value="主题">主题</option>
              <option value="方法">方法</option>
              <option value="对象">对象</option>
            </select>
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <button type="button" className="btn btn-primary" disabled={busy || !papers.length} onClick={() => void suggest()}>
              {busy ? '正在整理…' : '让织理理一遍'}
            </button>
          </div>
        </div>
        {!papers.length && <p className="muted small">知识库里还没有文献。先去“寻源”检索并加入几篇。</p>}

        {sug && (
          <div style={{ marginTop: 16 }}>
            <h3>织理的建议（你可以改）</h3>
            <p className="muted small">点文献可以把它从主题里移进移出，改好再落库。</p>
            <ul className="list">
              {sug.topics.map((t) => (
                <li key={t.name}>
                  <div className="row">
                    <strong>{t.parent ? `└ ${t.name}` : t.name}</strong>
                    {t.parent && <span className="badge badge-muted">属于 {t.parent}</span>}
                    <span className="spacer" />
                    <span className="muted small">{(checked[t.name] || []).length} 篇</span>
                  </div>
                  {t.desc && <p className="small muted" style={{ margin: '4px 0' }}>{t.desc}</p>}
                  <div className="chips">
                    {papers.map((p) => (
                      <button key={p.id} type="button" className="chip"
                        aria-pressed={(checked[t.name] || []).includes(p.id)}
                        onClick={() => togglePaper(t.name, p.id)}>
                        {p.title.slice(0, 22)}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>

            {!!sug.gaps.length && (
              <>
                <h3>有依据的研究空白</h3>
                <ul className="list">
                  {sug.gaps.map((g, i) => (
                    <li key={i}>
                      <p className="small" style={{ margin: 0 }}>{g.desc}</p>
                      {!!g.evidence_ids.length && (
                        <p className="muted small" style={{ margin: '4px 0 0' }}>依据：{g.evidence_ids.map(paperTitle).join('；')}</p>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void apply()}>确认并落库</button>
              <button type="button" className="btn btn-text" onClick={() => setSug(null)}>先不落库</button>
            </div>
          </div>
        )}
      </section>

      <section className="section">
        <h2>现有主题（{topics.length}）</h2>
        {!topics.length ? (
          <EmptyHint>还没有主题。用上面的“让织理理一遍”，或自己在建知识库页里手动建。</EmptyHint>
        ) : (
          <ul className="list">
            {topics.map((t) => (
              <li key={t.id}>
                <div className="row">
                  <strong>{t.parent_id ? '└ ' : ''}{t.name}</strong>
                  <span className="badge badge-muted">{t.paper_count} 篇</span>
                  <span className="spacer" />
                  <button type="button" className="btn btn-text btn-sm"
                    onClick={async () => {
                      if (!window.confirm(`删除主题“${t.name}”？文献不会丢，只是取消归类。`)) return;
                      try { await api(`/topics/${t.id}`, { method: 'DELETE' }); await loadTopics(); onChanged(); } catch (e) { onError((e as Error).message); }
                    }}>删除</button>
                </div>
                {t.description && <p className="small muted" style={{ margin: '4px 0 0' }}>{t.description}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ---------- 问枢：选题导师 ----------

function TopicDesk({ papers, onError, onToast, onChanged }: DeskProps) {
  const [ideas, setIdeas] = useState<TopicIdea[]>([]);
  const [form, setForm] = useState({ question: '', significance: '', feasibility: '', method: '', risks: '' });
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await api<IdeasResp>('/ideas');
    setIdeas(r.ideas);
  }, []);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  const create = async () => {
    if (!form.question.trim()) { onError('请填写研究问题。'); return; }
    setBusy(true); onError('');
    try {
      await api('/ideas', { body: { ...form, paper_ids: picked } });
      onToast('选题卡已保存');
      setForm({ question: '', significance: '', feasibility: '', method: '', risks: '' });
      setPicked([]);
      await load(); onChanged();
    } catch (e) { onError(e instanceof ApiError ? e.message : '保存失败。'); } finally { setBusy(false); }
  };

  const setStatus = async (idea: TopicIdea, status: string) => {
    try { await api(`/ideas/${idea.id}`, { method: 'PUT', body: { status } }); await load(); onChanged(); } catch (e) { onError((e as Error).message); }
  };

  return (
    <>
      <MentorDesk menuFlow="research_topic" kind="research_topic" agentKey="research_topic" onError={onError} />

      <section className="section" style={{ marginTop: 16 }}>
        <h2>选题卡</h2>
        <p className="muted small">
          问枢会陪你追问，但<strong>最后由你选</strong>。题目宁小勿大——大到“一个学期做不完”的，就不叫可做的问题。
          平台不写研究计划书，只帮你把问题想清楚。
        </p>

        <div className="field">
          <label htmlFor="id-q">研究问题（一句话）</label>
          <input id="id-q" className="input" maxLength={500} value={form.question} onChange={(e) => setForm({ ...form, question: e.target.value })} placeholder="例如：多智能体评估在多大程度上优于单一模型？" />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="id-sig">意义：这个问题对谁重要</label>
            <textarea id="id-sig" className="textarea" maxLength={1000} value={form.significance} onChange={(e) => setForm({ ...form, significance: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="id-feas">可行性：你凭什么能做</label>
            <textarea id="id-feas" className="textarea" maxLength={1000} value={form.feasibility} onChange={(e) => setForm({ ...form, feasibility: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="id-method">方法</label>
            <textarea id="id-method" className="textarea" maxLength={1000} value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="id-risk">风险与局限</label>
            <textarea id="id-risk" className="textarea" maxLength={1000} value={form.risks} onChange={(e) => setForm({ ...form, risks: e.target.value })} />
          </div>
        </div>

        <div className="field">
          <label>关联到哪些文献（可多选）</label>
          {!papers.length ? <p className="muted small">知识库里还没有文献。</p> : (
            <div className="chips">
              {papers.map((p) => (
                <button key={p.id} type="button" className="chip" aria-pressed={picked.includes(p.id)}
                  onClick={() => setPicked((x) => (x.includes(p.id) ? x.filter((y) => y !== p.id) : [...x, p.id]))}>
                  {p.title.slice(0, 22)}
                </button>
              ))}
            </div>
          )}
        </div>

        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()}>{busy ? '保存中…' : '保存选题卡'}</button>
      </section>

      <section className="section">
        <h2>我的选题（{ideas.length}）</h2>
        {!ideas.length ? (
          <EmptyHint>还没有选题卡。和问枢聊几轮，收敛出一个再填上来。</EmptyHint>
        ) : (
          <ul className="list">
            {ideas.map((x) => (
              <li key={x.id}>
                <div className="row">
                  <strong>{x.question}</strong>
                  <span className={`badge ${x.status === 'chosen' ? 'badge-ok' : x.status === 'dropped' ? 'badge-muted' : 'badge-muted'}`}>
                    {{ candidate: '候选', chosen: '已选定', dropped: '已放弃' }[x.status]}
                  </span>
                  <span className="spacer" />
                  {x.status !== 'chosen' && <button type="button" className="btn btn-sm" onClick={() => void setStatus(x, 'chosen')}>就选这个</button>}
                  {x.status !== 'dropped' && <button type="button" className="btn btn-text btn-sm" onClick={() => void setStatus(x, 'dropped')}>放弃</button>}
                </div>
                {x.significance && <p className="small" style={{ margin: '4px 0 0' }}><strong>意义：</strong>{x.significance}</p>}
                {x.feasibility && <p className="small muted" style={{ margin: '2px 0 0' }}><strong>可行性：</strong>{x.feasibility}</p>}
                {!!x.paper_ids.length && <p className="muted small" style={{ margin: '4px 0 0' }}>关联文献：{x.paper_ids.map((id) => papers.find((p) => p.id === id)?.title || `#${id}`).join('；')}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

// ---------- 我的文献 ----------

function LibraryDesk({ papers, onError, onToast, onChanged }: DeskProps) {
  const [topics, setTopics] = useState<TopicsResp['topics']>([]);
  const [busy, setBusy] = useState(0);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'verified' | 'unverified' | 'failed'>('all');

  useEffect(() => { api<TopicsResp>('/topics').then((r) => setTopics(r.topics)).catch(() => {}); }, [papers.length]);

  const shown = useMemo(() => papers.filter((p) => {
    if (filter !== 'all' && p.verify_status !== filter) return false;
    if (!q.trim()) return true;
    const n = q.trim().toLowerCase();
    return p.title.toLowerCase().includes(n) || p.authors.join(' ').toLowerCase().includes(n) || (p.venue || '').toLowerCase().includes(n);
  }), [papers, filter, q]);

  const verify = async (p: PaperRow) => {
    setBusy(p.id); onError('');
    try {
      const r = await api<{ result: { status: string; reason?: string } }>(`/papers/${p.id}/verify`, {});
      onToast(r.result.status === 'verified' ? '核验通过：这个 DOI 能解析到真实页面' : r.result.reason || '核验完成，请看状态');
      onChanged();
    } catch (e) { onError(e instanceof ApiError ? e.message : '核验失败。'); } finally { setBusy(0); }
  };

  const verifyAll = async () => {
    const ids = shown.filter((p) => p.verify_status === 'unverified').map((p) => p.id);
    if (!ids.length) { onToast('这批都已经核验过了', 'warn'); return; }
    setBusy(-1); onError('');
    try {
      const r = await api<{ results: { status: string }[] }>('/papers/verify-batch', { body: { ids } });
      const ok = r.results.filter((x) => x.status === 'verified').length;
      onToast(`核验 ${r.results.length} 篇：通过 ${ok} 篇`);
      onChanged();
    } catch (e) { onError(e instanceof ApiError ? e.message : '批量核验失败。'); } finally { setBusy(0); }
  };

  const setTopic = async (p: PaperRow, topicId: string) => {
    try {
      await api(`/papers/${p.id}`, { method: 'PUT', body: { topic_id: topicId ? Number(topicId) : null } });
      onChanged();
    } catch (e) { onError((e as Error).message); }
  };

  const remove = async (p: PaperRow) => {
    if (!window.confirm(`从知识库移除“${p.title}”？`)) return;
    try { await api(`/papers/${p.id}`, { method: 'DELETE' }); onToast('已移除'); onChanged(); } catch (e) { onError((e as Error).message); }
  };

  return (
    <section className="section" style={{ marginTop: 16 }}>
      <div className="row">
        <h2 style={{ margin: 0 }}>我的文献</h2>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" disabled={busy !== 0} onClick={() => void verifyAll()}>
          {busy === -1 ? '正在核验…' : '核验这一批'}
        </button>
      </div>
      <p className="muted small">
        <strong>核验</strong>是判断一篇文献是不是真的存在：平台拿 DOI 去 doi.org 解析，能跳到真实页面才算通过。
        中文期刊的 DOI 大多不在 Crossref 注册，只看 Crossref 会把真文献误判成编造的，所以以解析结果为准。
      </p>

      <div className="row">
        <div className="chips">
          {([['all', '全部'], ['verified', '已核验'], ['unverified', '待核验'], ['failed', '核验失败']] as const).map(([k, label]) => (
            <button key={k} type="button" className="chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        <span className="spacer" />
        <input className="input" style={{ maxWidth: 260 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索题名、作者、期刊…" aria-label="搜索文献" />
      </div>

      {!shown.length ? (
        <EmptyHint>{papers.length ? '没有符合条件的文献。' : '知识库还是空的。去“寻源”检索，或到建知识库页导入知网导出文件。'}</EmptyHint>
      ) : (
        <ul className="list">
          {shown.map((p) => (
            <li key={p.id}>
              <div className="row">
                <strong>{p.title}</strong>
                <VerifyBadge status={p.verify_status} info={p.verify_info} />
                {p.has_fulltext && <span className="badge badge-ok">有全文</span>}
                <span className="spacer" />
                <select className="select" style={{ width: 'auto' }} value={p.topic_id || ''} aria-label={`${p.title} 的主题`} onChange={(e) => void setTopic(p, e.target.value)}>
                  <option value="">未归类</option>
                  {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <button type="button" className="btn btn-sm" disabled={busy === p.id} onClick={() => void verify(p)}>
                  {busy === p.id ? '核验中…' : '核验'}
                </button>
                <button type="button" className="btn btn-text btn-sm" onClick={() => void remove(p)}>移除</button>
              </div>
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                {p.authors.slice(0, 3).join('、')}{p.authors.length > 3 ? ' 等' : ''}｜{p.year || '年份不详'}｜{p.venue || '来源未标注'}
                {p.doi && `｜DOI: ${p.doi}`}
                ｜{p.read_status === 'read' ? '已读' : '未读'}
              </p>
              {p.verify_status === 'failed' && p.verify_info?.reason && (
                <p className="small" style={{ margin: '4px 0 0', color: 'var(--c-danger)' }}>{p.verify_info.reason}</p>
              )}
              {p.verify_status === 'unverified' && p.verify_info?.reason && (
                <p className="small" style={{ margin: '4px 0 0', color: 'var(--c-warn)' }}>{p.verify_info.reason}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface DeskProps {
  papers: PaperRow[];
  onError: (s: string) => void;
  onToast: (s: string, k?: 'ok' | 'error' | 'warn') => void;
  onChanged: () => void;
}
