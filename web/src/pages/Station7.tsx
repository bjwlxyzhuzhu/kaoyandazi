// 书房 · 建知识库（第7站，M12）
// 备考空间与科研空间：条目录入、检索、导入导出、考核报告
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { ImportReport, KbItem, KbItemsResp, KbReport } from '../api/types2';
import { StationShell } from './Road';
import { useToast } from '../components/Toast';
import { EmptyHint, readFileBase64, downloadUrl } from './StudyShared';

type Tab = 'items' | 'io' | 'report';

const SPACES = [
  { key: 'prep', label: '备考空间' },
  { key: 'research', label: '科研空间' },
] as const;

const TYPES = [
  { key: 'knowledge', label: '知识点' },
  { key: 'mistake', label: '错题' },
  { key: 'note', label: '笔记' },
] as const;

export default function Station7() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('items');
  const [error, setError] = useState('');

  return (
    <StationShell station={7}>
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'items'} className={tab === 'items' ? 'active' : ''} onClick={() => setTab('items')}>我的条目</button>
        <button type="button" role="tab" aria-selected={tab === 'io'} className={tab === 'io' ? 'active' : ''} onClick={() => setTab('io')}>导入与导出</button>
        <button type="button" role="tab" aria-selected={tab === 'report'} className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}>知识库报告</button>
      </div>

      {tab === 'items' && <ItemsPanel onError={setError} onToast={toast} />}
      {tab === 'io' && <IoPanel onError={setError} onToast={toast} />}
      {tab === 'report' && <ReportPanel onError={setError} onToast={toast} />}
    </StationShell>
  );
}

// ---------- 条目 ----------

function ItemsPanel({ onError, onToast }: { onError: (s: string) => void; onToast: (s: string, k?: 'ok' | 'error' | 'warn') => void }) {
  const [data, setData] = useState<KbItemsResp | null>(null);
  const [space, setSpace] = useState<string>('prep');
  const [type, setType] = useState<string>('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);

  // 新建表单
  const [showForm, setShowForm] = useState(false);
  const [newSpace, setNewSpace] = useState<'prep' | 'research'>('prep');
  const [newType, setNewType] = useState<'knowledge' | 'mistake' | 'note'>('knowledge');
  const [title, setTitle] = useState('');
  const [outline, setOutline] = useState('');
  const [detail, setDetail] = useState('');
  const [body, setBody] = useState('');
  const [cause, setCause] = useState('');
  const [correction, setCorrection] = useState('');
  const [mastery, setMastery] = useState(1);
  const [tags, setTags] = useState('');

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (space) params.set('space', space);
    if (type) params.set('type', type);
    if (q.trim()) params.set('q', q.trim());
    setData(await api<KbItemsResp>(`/kb/items?${params.toString()}`));
  }, [space, type, q]);

  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  const reset = () => {
    setTitle(''); setOutline(''); setDetail(''); setBody(''); setCause(''); setCorrection(''); setMastery(1); setTags('');
  };

  const submit = async () => {
    onError('');
    if (!title.trim()) { onError('请填写标题。'); return; }
    if (newType === 'knowledge' && !outline.trim()) { onError('知识点请填“一句话概括”。'); return; }
    if (newType === 'mistake' && !cause) { onError('错题请选一个错因。'); return; }
    setBusy(true);
    try {
      const content = newType === 'knowledge'
        ? { outline, detail }
        : newType === 'mistake'
          ? { summary: body, cause, correction }
          : { body };
      await api('/kb/items', { body: { space: newSpace, type: newType, title, content, mastery: newType === 'knowledge' ? mastery : undefined, tags: tags.split(/[，,\s]+/).filter(Boolean) } });
      onToast('已加入知识库');
      reset(); setShowForm(false);      await load();
    } catch (e) { onError(e instanceof ApiError ? e.message : '保存失败，请重试。'); } finally { setBusy(false); }
  };

  const remove = async (id: number) => {
    if (!window.confirm('删除这条？删除后无法恢复。')) return;
    try {
      await api(`/kb/items/${id}`, { method: 'DELETE' });
      onToast('已删除');
      await load();
    } catch (e) { onError(e instanceof ApiError ? e.message : '删除失败。'); }
  };

  if (!data) return <p className="muted" style={{ marginTop: 16 }}>正在载入…</p>;

  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>我的条目</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? '收起' : '＋ 新建条目'}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          共 {data.stats.total} 条：备考 {data.stats.prep} 条、科研 {data.stats.research} 条，其中错题 {data.stats.mistakes} 条。
        </p>

        {showForm && (
          <div className="kb-form">
            <div className="grid-3">
              <div className="field">
                <label htmlFor="kb-space">放哪个空间</label>
                <select id="kb-space" className="select" value={newSpace} onChange={(e) => setNewSpace(e.target.value as 'prep' | 'research')}>
                  {SPACES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="kb-type">类型</label>
                <select id="kb-type" className="select" value={newType} onChange={(e) => setNewType(e.target.value as 'knowledge' | 'mistake' | 'note')}>
                  {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="kb-tags">标签（用逗号分隔）</label>
                <input id="kb-tags" className="input" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="例如：数据结构, 树" />
              </div>
            </div>

            <div className="field">
              <label htmlFor="kb-title">标题</label>
              <input id="kb-title" className="input" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>

            {newType === 'knowledge' && (
              <>
                <div className="field">
                  <label htmlFor="kb-outline">一句话概括</label>
                  <input id="kb-outline" className="input" maxLength={200} value={outline} onChange={(e) => setOutline(e.target.value)} placeholder="合上书也能说出来的那句话" />
                </div>
                <div className="field">
                  <label htmlFor="kb-detail">展开说明</label>
                  <textarea id="kb-detail" className="textarea" maxLength={3000} value={detail} onChange={(e) => setDetail(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="kb-mastery">掌握程度</label>
                  <div className="chips" id="kb-mastery" role="radiogroup" aria-label="掌握程度">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button key={n} type="button" className="chip" role="radio" aria-checked={mastery === n} onClick={() => setMastery(n)}>{n}</button>
                    ))}
                  </div>
                  <span className="muted small">1 完全不会 — 5 能讲给别人听</span>
                </div>
              </>
            )}

            {newType === 'mistake' && (
              <>
                <div className="field">
                  <label htmlFor="kb-body">这道题错在哪</label>
                  <textarea id="kb-body" className="textarea" maxLength={1000} value={body} onChange={(e) => setBody(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor="kb-cause">错因</label>
                  <div className="chips" id="kb-cause" role="radiogroup" aria-label="错因">
                    {data.mistake_causes.map((c) => (
                      <button key={c} type="button" className="chip" role="radio" aria-checked={cause === c} onClick={() => setCause(c)}>{c}</button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="kb-corr">怎么改（下次遇到怎么办）</label>
                  <textarea id="kb-corr" className="textarea" maxLength={2000} value={correction} onChange={(e) => setCorrection(e.target.value)} />
                </div>
              </>
            )}

            {newType === 'note' && (
              <div className="field">
                <label htmlFor="kb-note">笔记内容</label>
                <textarea id="kb-note" className="textarea" maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)} />
              </div>
            )}

            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
                {busy ? '正在保存…' : '保存'}
              </button>
              <button type="button" className="btn btn-text" onClick={() => { reset(); setShowForm(false); }}>取消</button>
            </div>
          </div>
        )}
      </section>

      <section className="section">
        <div className="row">
          <div className="chips">
            <button type="button" className="chip" aria-pressed={space === ''} onClick={() => setSpace('')}>全部空间</button>
            {SPACES.map((s) => (
              <button key={s.key} type="button" className="chip" aria-pressed={space === s.key} onClick={() => setSpace(s.key)}>{s.label}</button>
            ))}
          </div>
          <span className="spacer" />
          <div className="chips">
            <button type="button" className="chip" aria-pressed={type === ''} onClick={() => setType('')}>全部类型</button>
            {TYPES.map((t) => (
              <button key={t.key} type="button" className="chip" aria-pressed={type === t.key} onClick={() => setType(t.key)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="kb-q" className="sr-only">搜索条目</label>
          <input id="kb-q" className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题、内容或标签…" />
        </div>

        {!data.items.length ? (
          <EmptyHint>这里还没有条目。点上面的“新建条目”，把一章知识清单或一道错题记下来。</EmptyHint>
        ) : (
          <ul className="list">
            {data.items.map((x) => (
              <li key={x.id}>
                <div className="row">
                  <strong>{x.title}</strong>
                  <span className="badge badge-muted">{x.space === 'prep' ? '备考' : '科研'}</span>
                  <span className="badge badge-muted">{TYPES.find((t) => t.key === x.type)?.label || x.type}</span>
                  {x.type === 'knowledge' && x.mastery !== null && <span className="badge badge-muted">掌握 {x.mastery}/5</span>}
                  {!!x.tags.length && <span className="muted small">{x.tags.join('、')}</span>}
                  <span className="spacer" />
                  <button type="button" className="btn btn-text btn-sm" onClick={() => void remove(x.id)}>删除</button>
                </div>
                <p className="small muted" style={{ margin: '4px 0 0' }}><ItemSummary item={x} /></p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ItemSummary({ item }: { item: KbItem }) {
  const c = item.content;
  if (item.type === 'knowledge') return <>{String(c.outline || '')}{c.detail ? ` —— ${String(c.detail).slice(0, 100)}` : ''}</>;
  if (item.type === 'mistake') return <>错因：{String(c.cause || '未填')}｜{String(c.summary || '').slice(0, 80)}</>;
  return <>{String(c.body || '').slice(0, 120)}</>;
}

// ---------- 导入与导出 ----------

function IoPanel({ onError, onToast }: { onError: (s: string) => void; onToast: (s: string, k?: 'ok' | 'error' | 'warn') => void }) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);

  const onFile = async (file: File | null) => {
    if (!file) return;
    onError(''); setBusy(true);
    try {
      const data = await readFileBase64(file);
      const r = await api<ImportReport>('/kb/import', { body: { data, filename: file.name } });
      setReport(r);
      onToast(`导入完成：新增 ${r.imported} 条`);
    } catch (e) { onError(e instanceof ApiError ? e.message : '导入失败，请重试。'); } finally { setBusy(false); }
  };

  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <h2>导入文献</h2>
        <p className="muted small">
          支持知网导出的 <strong>RIS / EndNote / NoteExpress / RefWorks</strong> 文本、<strong>BibTeX</strong>、
          <strong> CSV</strong>、纯 <strong>DOI 列表</strong>，以及本平台导出的 <strong>JSON 备份</strong>（换新账号时可完整恢复）。
        </p>
        <p className="muted small">知网导出的 GBK 编码会自动识别，不用手动转码。重复的文献会自动跳过。</p>
        <div className="field">
          <label htmlFor="kb-file">选择文件</label>
          <input id="kb-file" type="file" className="input" accept=".ris,.txt,.bib,.csv,.json,.enw,.ref" disabled={busy} onChange={(e) => void onFile(e.target.files?.[0] || null)} />
        </div>
        {busy && <p className="muted small">正在导入…</p>}
        {report && (
          <div className="notice notice-ok" style={{ marginTop: 8 }}>
            <span className="icon">✓</span>
            <span>
              识别为 <strong>{report.format}</strong>：新增 {report.imported} 条
              {report.duplicated ? `，重复跳过 ${report.duplicated} 条` : ''}
              {report.doi_filled ? `，用 DOI 补全 ${report.doi_filled} 条元数据` : ''}。
              {report.report?.papers !== undefined && `（文献 ${report.report.papers}、阅读卡 ${report.report.cards}、条目 ${report.report.kb_items}、选题 ${report.report.topic_ideas}）`}
            </span>
          </div>
        )}
        {(report?.report?.ok?.length || report?.report?.dup?.length) && (
          <div style={{ marginTop: 12 }}>
            {!!report?.report?.ok?.length && (
              <>
                <h3 className="small">新增清单</h3>
                <ul className="list small">{report.report.ok.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </>
            )}
            {!!report?.report?.dup?.length && (
              <>
                <h3 className="small">重复跳过</h3>
                <ul className="list small">{report.report.dup.map((t, i) => <li key={i}>{t}</li>)}</ul>
              </>
            )}
          </div>
        )}
      </section>

      <section className="section">
        <h2>导出</h2>
        <p className="muted small">导出的是你自己的数据，随时可以带走。BibTeX 和 RIS 可以直接导进 Zotero、EndNote。</p>
        <div className="row">
          <button type="button" className="btn" onClick={() => downloadUrl('/kb/export?format=bib')}>BibTeX（.bib）</button>
          <button type="button" className="btn" onClick={() => downloadUrl('/kb/export?format=ris')}>RIS（.ris）</button>
          <button type="button" className="btn" onClick={() => downloadUrl('/kb/export?format=csv')}>表格（.csv）</button>
          <button type="button" className="btn" onClick={() => downloadUrl('/kb/export?format=md')}>阅读卡（.zip）</button>
          <button type="button" className="btn" onClick={() => downloadUrl('/kb/export?format=json')}>完整备份（.json）</button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          阅读卡导出的是一个 ZIP，里面每张卡是一份 Markdown 文件，中文文件名在 Windows 解压后正常显示。
          CSV 带 BOM，用 Excel 打开不会乱码。
        </p>
      </section>
    </>
  );
}

// ---------- 知识库报告 ----------

const PICK_LIMIT = 5;

function ReportPanel({ onError, onToast }: { onError: (s: string) => void; onToast: (s: string, k?: 'ok' | 'error' | 'warn') => void }) {
  const [rep, setRep] = useState<KbReport | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { setRep(await api<KbReport>('/kb/report')); }, []);
  useEffect(() => { load().catch((e) => onError((e as Error).message)); }, [load, onError]);

  const savePicks = async (picks: KbReport['picks']) => {
    setBusy(true); onError('');
    try {
      const r = await api<{ picks: number }>('/kb/report/picks', { method: 'PUT', body: { picks } });
      onToast(`已保存 ${r.picks} 条精选`);
      await load();
    } catch (e) { onError(e instanceof ApiError ? e.message : '保存失败。'); } finally { setBusy(false); }
  };

  if (!rep) return <p className="muted" style={{ marginTop: 16 }}>正在载入…</p>;
  const c = rep.counts;

  return (
    <>
      <section className="section" style={{ marginTop: 16 }}>
        <div className="row">
          <h2 style={{ margin: 0 }}>我的知识库报告</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={() => window.open('/api/kb/report/print', '_blank', 'noopener')}>打印 / 存 PDF</button>
        </div>
        <p className="muted small">{rep.note}</p>
        <p className="muted small">生成于 {rep.generated_at}</p>

        <div className="stat-row" style={{ marginTop: 16 }}>
          <div className="stat"><span className="num">{c.papers}</span><span className="lbl">文献（已核验 {c.papers_verified}）</span></div>
          <div className="stat"><span className="num">{c.cards}</span><span className="lbl">阅读卡</span></div>
          <div className="stat"><span className="num">{c.topics}</span><span className="lbl">主题</span></div>
          <div className="stat"><span className="num">{c.ideas}</span><span className="lbl">选题卡</span></div>
          <div className="stat"><span className="num">{c.kb_items}</span><span className="lbl">知识条目</span></div>
          <div className="stat"><span className="num">{Math.round(c.reading_minutes / 60 * 10) / 10}</span><span className="lbl">阅读小时</span></div>
        </div>
      </section>

      {!!rep.mistake_causes.length && (
        <section className="section">
          <h2>错因分布</h2>
          <p className="muted small">把错题按错因归类，看自己最常在哪儿跌倒。</p>
          <ul className="list">
            {rep.mistake_causes.map((m) => (
              <li key={m.name}>
                <div className="row">
                  <span style={{ minWidth: 96 }}>{m.name}</span>
                  <span className="poll-bar" style={{ flex: 1, maxWidth: `${Math.round((m.count / rep.mistake_causes[0].count) * 100)}%` }} />
                  <span className="muted small">{m.count} 道</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!rep.topics.length && (
        <section className="section">
          <h2>主题结构</h2>
          <ul className="list">
            {rep.topics.map((t) => (
              <li key={t.name}>
                <strong>{t.name}</strong>{t.description && <span className="muted small">　{t.description}</span>}
                <p className="small muted" style={{ margin: '4px 0 0' }}>
                  {t.papers.length ? t.papers.join('；') : '这个主题下还没有文献'}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="section">
        <h2>精选条目（最多{PICK_LIMIT}条）</h2>
        <p className="muted small">
          自己挑能代表这学期工作的条目，放进结课考核档案袋。这一栏由你自己决定，AI 不参与挑选。
          已选 {rep.picks.length} / {PICK_LIMIT}。
        </p>
        {!!rep.picks.length && (
          <ul className="list">
            {rep.picks.map((p, i) => (
              <li key={`${p.kind}-${p.ref_id}`}>
                <div className="row">
                  <span className="badge badge-muted">{{ paper: '文献', card: '阅读卡', item: '知识条目', idea: '选题卡' }[p.kind] || p.kind}</span>
                  <strong>{p.title}</strong>
                  <span className="spacer" />
                  <button type="button" className="btn btn-text btn-sm" disabled={busy}
                    onClick={() => void savePicks(rep.picks.filter((_, j) => j !== i))}>移除</button>
                </div>
                {p.note && <p className="small muted" style={{ margin: '4px 0 0' }}>{p.note}</p>}
              </li>
            ))}
          </ul>
        )}
        <PickAdder disabled={busy || rep.picks.length >= PICK_LIMIT} onAdd={(p) => void savePicks([...rep.picks, p])} />
      </section>
    </>
  );
}

function PickAdder({ disabled, onAdd }: { disabled: boolean; onAdd: (p: { kind: string; ref_id: number; title: string; note: string }) => void }) {
  const [kind, setKind] = useState<'paper' | 'card' | 'item' | 'idea'>('paper');
  const [rows, setRows] = useState<{ id: number; title: string }[]>([]);
  const [refId, setRefId] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    const path = kind === 'paper' ? '/papers' : kind === 'card' ? '/cards' : kind === 'item' ? '/kb/items' : '/ideas';
    api<Record<string, { id: number; title?: string; question?: string }[]>>(path)
      .then((r) => {
        const list = r.papers || r.cards || r.items || r.ideas || [];
        setRows(list.map((x) => ({ id: x.id, title: x.title || x.question || `#${x.id}` })));
      })
      .catch(() => setRows([]));
  }, [kind]);

  return (
    <div style={{ marginTop: 12 }}>
      <div className="grid-3">
        <div className="field">
          <label htmlFor="pick-kind">类型</label>
          <select id="pick-kind" className="select" value={kind} onChange={(e) => { setKind(e.target.value as typeof kind); setRefId(''); }}>
            <option value="paper">文献</option>
            <option value="card">阅读卡</option>
            <option value="item">知识条目</option>
            <option value="idea">选题卡</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="pick-ref">选一条</label>
          <select id="pick-ref" className="select" value={refId} onChange={(e) => setRefId(e.target.value)}>
            <option value="">请选择…</option>
            {rows.map((r) => <option key={r.id} value={r.id}>{r.title.slice(0, 40)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="pick-note">为什么选它（选填）</label>
          <input id="pick-note" className="input" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <button type="button" className="btn" disabled={disabled || !refId}
        onClick={() => { const r = rows.find((x) => String(x.id) === refId); if (r) { onAdd({ kind, ref_id: r.id, title: r.title, note }); setRefId(''); setNote(''); } }}>
        ＋ 加入精选
      </button>
    </div>
  );
}
