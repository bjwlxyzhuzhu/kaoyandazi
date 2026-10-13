// 导师回复下方：资料来源标签 + “有帮助 / 没帮助 + 原因”（PRD M20：反馈只记评分、原因和被评价的这一条回复）
import { useState } from 'react';
import { api } from '../api/client';

export interface SourceRef { ref: string; title: string; source?: string; level?: string; snippet?: string }

export function SourceTags({ sources }: { sources?: SourceRef[] | null }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!sources?.length) return null;
  return (
    <div className="sources">
      <span className="muted small">依据：</span>
      {sources.map((s) => (
        <button key={s.ref} type="button" className="source-tag" aria-expanded={open === s.ref} onClick={() => setOpen(open === s.ref ? null : s.ref)}>
          [{s.ref}] {s.title}{s.level ? `｜${s.level}` : ''}
        </button>
      ))}
      {open && (() => {
        const s = sources.find((x) => x.ref === open)!;
        return <p className="small source-snippet">《{s.title}》{s.source ? `（来源：${s.source}）` : ''}：{s.snippet}…</p>;
      })()}
    </div>
  );
}

const REASONS = ['太严厉', '太啰嗦', '不准确', '没听懂我', '太空泛', '其他'];

/** messageRef：msg:<id>（1:1 对话）或 gmsg:<id>（会议发言） */
export function FeedbackBar({ mentorKey, messageRef, sessionId }: { mentorKey: string; messageRef: string; sessionId?: number }) {
  const [state, setState] = useState<'idle' | 'asking' | 'sent'>('idle');
  const [picked, setPicked] = useState<string[]>([]);
  const send = async (helpful: boolean, reasons: string[] = []) => {
    try {
      await api(`/mentors/${mentorKey}/feedback`, { body: { helpful, reasons, message_ref: messageRef, ...(sessionId ? { session_id: sessionId } : {}) } });
      setState('sent');
    } catch { setState('sent'); }
  };
  if (state === 'sent') return <p className="muted small feedback-bar">谢谢，老师会根据大家的反馈改进这位导师（老师只看得到这一条回复，看不到你们的对话）。</p>;
  return (
    <div className="feedback-bar">
      {state === 'idle' ? (
        <>
          <button type="button" className="btn btn-text btn-sm" onClick={() => void send(true)}>有帮助</button>
          <button type="button" className="btn btn-text btn-sm" onClick={() => setState('asking')}>没帮助</button>
        </>
      ) : (
        <>
          <span className="muted small">哪里不好？</span>
          <div className="chips">
            {REASONS.map((r) => (
              <button key={r} type="button" className="chip" role="checkbox" aria-checked={picked.includes(r)} onClick={() => setPicked((x) => (x.includes(r) ? x.filter((y) => y !== r) : [...x, r]))}>{r}</button>
            ))}
          </div>
          <button type="button" className="btn btn-sm" disabled={!picked.length} onClick={() => void send(false, picked)}>提交</button>
          <button type="button" className="btn btn-text btn-sm" onClick={() => setState('idle')}>取消</button>
        </>
      )}
    </div>
  );
}
