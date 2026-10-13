// “它记得什么”（M9）：查看、删除、手动添加；并说明哪些内容不会记录
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { MemoriesResp, MemoryRow } from '../api/types2';
import { useToast } from '../components/Toast';

const CATEGORIES = ['目标', '承诺', '困难', '偏好', '进展', '状态', '其他'];

export default function Memories() {
  const toast = useToast();
  const [data, setData] = useState<MemoriesResp | null>(null);
  const [content, setContent] = useState('');
  const [category, setCategory] = useState('目标');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [warn, setWarn] = useState('');

  const load = useCallback(async () => {
    setData(await api<MemoriesResp>('/memories'));
  }, []);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  const add = async () => {
    if (!content.trim()) return;
    setBusy('add'); setError(''); setWarn('');
    try {
      await api('/memories', { body: { content, category } });
      setContent('');
      toast('已添加一条记忆');
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SENSITIVE') setWarn(e.message);
      else setError(e instanceof ApiError ? e.message : '保存失败，请重试。');
    } finally { setBusy(''); }
  };

  const remove = async (m: MemoryRow) => {
    if (!window.confirm(`确定删掉这条记忆吗？\n\n${m.content}`)) return;
    setBusy(`del-${m.id}`);
    try {
      await api(`/memories/${m.id}`, { method: 'DELETE' });
      toast('已删除');
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : '删除失败。'); } finally { setBusy(''); }
  };

  if (!data) return <div className="page-narrow">{error ? <div className="notice notice-error"><span className="icon">!</span><span>{error}</span></div> : <p className="muted">正在载入…</p>}</div>;

  const grouped = CATEGORIES.map((c) => ({ c, items: data.memories.filter((m) => (m.category || '其他') === c) })).filter((g) => g.items.length);

  return (
    <div className="page-narrow">
      <p className="muted small"><a href="/me">← 返回“我”</a></p>
      <h1>它记得什么</h1>
      <p className="muted">
        下面是平台记住的关于你的事，共 <strong>{data.count}</strong> / {data.limit} 条。
        你可以随时删掉任何一条，也可以自己添加。教师看不到这里的内容，只能看到条数。
      </p>
      <p className="notice notice-warn" role="note">
        <span className="icon">!</span>
        <span>{data.note}</span>
      </p>

      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}

      <section className="section">
        <h2>自己加一条</h2>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="mem-content">想让它记住的事</label>
            <input id="mem-content" className="input" maxLength={200} value={content} placeholder="例如：每周日晚上是我的固定复盘时间" onChange={(e) => setContent(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="mem-cat">类别</label>
            <select id="mem-cat" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>
        {warn && <div className="notice notice-warn" role="alert" style={{ marginBottom: 12 }}><span className="icon">!</span><span>{warn}</span></div>}
        <button type="button" className="btn btn-primary" disabled={!content.trim() || busy === 'add'} onClick={() => void add()}>
          {busy === 'add' ? '正在保存…' : '添加这条记忆'}
        </button>
      </section>

      <section className="section">
        <h2>已记住的事</h2>
        {!data.memories.length && <p className="muted">还没有记忆。和搭子聊几次，它会自己整理；也可以在上面手动添加。</p>}
        {grouped.map((g) => (
          <div key={g.c} style={{ marginBottom: 20 }}>
            <h3>{g.c}</h3>
            <ul className="list">
              {g.items.map((m) => (
                <li key={m.id}>
                  <div className="row">
                    <span style={{ flex: 1 }}>{m.content}</span>
                    <button type="button" className="btn btn-text btn-sm" disabled={busy === `del-${m.id}`} onClick={() => void remove(m)}>删除</button>
                  </div>
                  <span className="muted small">{m.created_at.slice(0, 16)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
