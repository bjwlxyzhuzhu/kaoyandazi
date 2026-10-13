// 问卷渲染（附录F）：前测 / 中测 / 后测 / 满意度
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { SurveyDef } from '../api/types2';

interface Props {
  def: SurveyDef;
  onSubmitted?: () => void;
}

export function SurveyForm({ def, onSubmitted }: Props) {
  const [answers, setAnswers] = useState<Record<string, unknown>>(() => ({ ...(def.answers || {}) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => { setAnswers({ ...(def.answers || {}) }); setDone(false); }, [def]);

  const set = (k: string, v: unknown) => { setAnswers((x) => ({ ...x, [k]: v })); setError(''); };

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api(`/surveys/${def.kind}`, { body: { answers } });
      setDone(true);
      onSubmitted?.();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '提交失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  if (def.submitted_at && done) {
    return (
      <div className="notice notice-ok" role="status">
        <span className="icon">✓</span>
        <span>已提交（{def.submitted_at.slice(0, 16)}）。只有你自己能看到自己的答案。</span>
      </div>
    );
  }

  return (
    <div>
      <p className="muted">{def.desc}</p>
      {def.items.map((it) => (
        <fieldset key={it.key} className="field" style={{ border: 0, padding: 0, margin: '0 0 20px' }}>
          <legend className="label" style={{ padding: 0, marginBottom: 8 }}>{it.label}</legend>
          {it.type === 'scale' && (
            <div className="chips">
              {Array.from({ length: (it.max ?? 5) - (it.min ?? 1) + 1 }, (_, i) => (it.min ?? 1) + i).map((n) => (
                <button key={n} type="button" className="chip" aria-pressed={Number(answers[it.key]) === n} onClick={() => set(it.key, n)}>
                  {n}
                </button>
              ))}
              <span className="muted small" style={{ alignSelf: 'center' }}>
                {def.scaleLabels?.['1']} — {def.scaleLabels?.['5']}
              </span>
            </div>
          )}
          {it.type === 'single' && (
            <div className="chips">
              {(it.options || []).map((o) => (
                <button key={o} type="button" className="chip" aria-pressed={answers[it.key] === o} onClick={() => set(it.key, o)}>{o}</button>
              ))}
            </div>
          )}
          {it.type === 'multi' && (
            <div className="chips">
              {(it.options || []).map((o) => {
                const arr = Array.isArray(answers[it.key]) ? (answers[it.key] as string[]) : [];
                return (
                  <button key={o} type="button" className="chip" role="checkbox" aria-checked={arr.includes(o)}
                    onClick={() => set(it.key, arr.includes(o) ? arr.filter((x) => x !== o) : [...arr, o])}>{o}</button>
                );
              })}
            </div>
          )}
          {it.type === 'textarea' && (
            <textarea className="textarea" maxLength={it.max || 300} value={String(answers[it.key] ?? '')} onChange={(e) => set(it.key, e.target.value)} />
          )}
        </fieldset>
      ))}
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
        {busy ? '正在提交…' : '提交问卷'}
      </button>
    </div>
  );
}
