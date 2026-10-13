// M8 干预卡片（首页）：一段说明 + 3—4个选项，必须选一项才能收起
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Intervention } from '../api/types2';
import { useToast } from './Toast';

interface Props {
  card: Intervention;
  /** 选择“和搭子聊聊”时跳到搭子，并带上这段上下文 */
  onTalk?: (card: Intervention) => void;
  onDone?: () => void;
}

export function InterventionCard({ card, onTalk, onDone }: Props) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const option = card.options.find((o) => o.key === picked) || null;
  const needNote = !!option?.requireNote;

  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ effect: string; route: string | null }>(`/interventions/${card.id}/choose`, {
        body: { choice: picked, note },
      });
      toast('已记录你的选择');
      onDone?.();
      // 按选项效果跳转
      if (r.effect === 'talk') onTalk?.(card);
      else if (r.effect === 'goto' && r.route) window.location.href = r.route;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '提交失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section intervention" aria-labelledby={`iv-${card.id}`}>
      <div className="row">
        <span className="badge badge-warn">{card.rule}</span>
        <h3 id={`iv-${card.id}`} style={{ margin: 0 }}>{card.title}</h3>
        <span className="spacer" />
        <span className="muted small">{card.created_at.slice(5, 16)}</span>
      </div>
      <p>{card.message}</p>
      <div className="chips" role="radiogroup" aria-label="选择一个处理方式">
        {card.options.map((o) => (
          <button key={o.key} type="button" className="chip" role="radio" aria-checked={picked === o.key} onClick={() => { setPicked(o.key); setError(''); }}>
            {o.label}
          </button>
        ))}
      </div>
      {needNote && (
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor={`iv-note-${card.id}`}>一句话说明（必填）</label>
          <textarea id={`iv-note-${card.id}`} className="textarea" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
      )}
      {error && <div className="notice notice-error" role="alert" style={{ marginTop: 12 }}><span className="icon">!</span><span>{error}</span></div>}
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary" disabled={!picked || busy || (needNote && note.trim().length < 5)} onClick={() => void submit()}>
          {busy ? '正在保存…' : '就按这个来'}
        </button>
        <Link className="btn btn-text" to="/mentors">找搭子聊聊</Link>
      </div>
    </section>
  );
}
