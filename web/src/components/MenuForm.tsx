// 菜单题渲染（PRD 4.1 菜单阶段：全部点选，不调用大模型）
import { useEffect, useState } from 'react';
import type { MenuDef, MenuQuestion } from '../api/types2';

interface Props {
  def: MenuDef;
  submitting?: boolean;
  onSubmit: (answers: Record<string, unknown>) => void;
  submitLabel?: string;
}

function initial(qs: MenuQuestion[], saved: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const q of qs) {
    const v = saved?.[q.key];
    if (v !== undefined) out[q.key] = v;
    else if (q.type === 'multi') out[q.key] = [];
    else if (q.type === 'slider') out[q.key] = Math.round((q.min + q.max) / 4);
    else out[q.key] = '';
  }
  return out;
}

export function MenuForm({ def, submitting, onSubmit, submitLabel = '下一步' }: Props) {
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => initial(def.questions, def.answers));
  const [error, setError] = useState('');

  useEffect(() => { setAnswers(initial(def.questions, def.answers)); }, [def]);

  const set = (k: string, v: unknown) => { setAnswers((x) => ({ ...x, [k]: v })); setError(''); };

  const check = () => {
    for (const q of def.questions) {
      const v = answers[q.key];
      const empty = v === '' || v === undefined || v === null || (Array.isArray(v) && !v.length);
      if (empty && q.required !== false) return `还有一题没有回答：${q.label}`;
    }
    return '';
  };

  const submit = () => {
    const msg = check();
    if (msg) { setError(msg); return; }
    onSubmit(answers);
  };

  return (
    <div>
      {def.note && <p className="muted small">{def.note}</p>}
      {def.questions.map((q) => (
        <fieldset key={q.key} className="field" style={{ border: 0, padding: 0, margin: '0 0 24px' }}>
          <legend className="label" style={{ padding: 0, marginBottom: 8 }}>
            {q.label}{q.required === false && <span className="muted small">（选填）</span>}
          </legend>
          {q.type === 'single' && (
            <div className="chips">
              {q.options.map((o) => (
                <button key={o} type="button" className="chip" aria-pressed={answers[q.key] === o} onClick={() => set(q.key, o)}>
                  {o}
                </button>
              ))}
            </div>
          )}
          {q.type === 'multi' && (
            <div className="chips">
              {q.options.map((o) => {
                const arr = Array.isArray(answers[q.key]) ? (answers[q.key] as string[]) : [];
                return (
                  <button key={o} type="button" className="chip" aria-checked={arr.includes(o)} role="checkbox"
                    onClick={() => set(q.key, arr.includes(o) ? arr.filter((x) => x !== o) : [...arr, o])}>
                    {o}
                  </button>
                );
              })}
            </div>
          )}
          {q.type === 'slider' && (
            <div className="row">
              <input type="range" min={q.min} max={q.max} step={q.step} value={Number(answers[q.key]) || q.min}
                aria-label={q.label} style={{ flex: 1, minWidth: 200 }}
                onChange={(e) => set(q.key, Number(e.target.value))} />
              <strong style={{ minWidth: 64 }}>{String(answers[q.key] ?? q.min)} 小时</strong>
            </div>
          )}
          {q.type === 'text' && (
            <input className="input" value={String(answers[q.key] ?? '')} placeholder={q.placeholder} maxLength={q.max || 100} onChange={(e) => set(q.key, e.target.value)} />
          )}
        </fieldset>
      ))}
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}
      <button type="button" className="btn btn-primary" disabled={submitting} onClick={submit}>
        {submitting ? '正在提交…' : submitLabel} <span className="arrow">→</span>
      </button>
    </div>
  );
}
