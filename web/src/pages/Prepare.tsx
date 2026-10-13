// M1 出发准备向导：4步（AI使用须知 → 认识模块 → 前测问卷 → 选择搭子人设）
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Me, ModuleRow } from '../api/types';
import type { PrepareResp, SurveyDef as Survey } from '../api/types2';
import { useAuth } from '../auth';
import { companions, getAgent } from '../registry';
import { MentorIcon } from '../components/MentorBadge';
import { SurveyForm } from '../components/SurveyForm';
import { useToast } from '../components/Toast';

type StepKey = 'consent' | 'modules' | 'survey' | 'persona';

export default function Prepare() {
  const { me, setMe } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [state, setState] = useState<PrepareResp | null>(null);
  const [step, setStep] = useState<StepKey>('consent');
  const [consent, setConsent] = useState<{ title: string; points: string[]; notes: string[] } | null>(null);
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [survey, setSurvey] = useState<Survey | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const [p, c, m, s] = await Promise.all([
      api<PrepareResp>('/prepare'),
      api<{ title: string; points: string[]; notes: string[] }>('/prepare/consent'),
      api<{ modules: ModuleRow[] }>('/me/modules', { withKey: true }),
      api<Survey>('/surveys/pre'),
    ]);
    setState(p); setConsent(c); setModules(m.modules); setSurvey(s);
    const next = p.steps.find((x) => !x.done);
    setStep((next?.key as StepKey) || 'persona');
    setAgreed(!!me?.consent_at);
  }, [me?.consent_at]);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  const finish = async () => {
    const r = await api<{ me: Me }>('/me');
    setMe(r.me);
    if (!r.me.prepare_done) {
      setError('还有步骤没有完成，请按顺序做完四步。');
      await load();
      return;
    }
    toast('出发准备完成，开始第1站');
    nav('/', { replace: true });
  };

  const doConsent = async () => {
    setBusy(true); setError('');
    try {
      await api('/prepare/consent', { body: { agreed: true } });
      await load();
      setStep('modules');
    } catch (e) { setError(e instanceof ApiError ? e.message : '提交失败，请重试。'); } finally { setBusy(false); }
  };

  const doModules = async () => {
    setBusy(true); setError('');
    try {
      await api('/prepare/modules-read', { body: {} });
      await load();
      setStep('survey');
    } catch (e) { setError(e instanceof ApiError ? e.message : '提交失败，请重试。'); } finally { setBusy(false); }
  };

  const choosePersona = async (key: string) => {
    setBusy(true); setError('');
    try {
      const r = await api<{ me: Me }>('/me', { method: 'PUT', body: { persona: key } });
      setMe(r.me);
      await load();
      setStep('persona');
    } catch (e) { setError(e instanceof ApiError ? e.message : '保存失败，请重试。'); } finally { setBusy(false); }
  };

  const basic = modules.filter((m) => m.tier === 'basic');
  const advanced = modules.filter((m) => m.tier === 'advanced');

  return (
    <div className="page-narrow">
      <h1>出发准备</h1>
      <p className="muted">四个小步骤，大约10分钟。做完就可以开始第1站。</p>

      <ol className="steps" aria-label="出发准备进度">
        {state?.steps.map((s) => (
          <li key={s.key} className={s.done ? 'done' : step === s.key ? 'active' : ''}>
            <span className="dot sm" aria-hidden="true">{s.done ? '✓' : s.no}</span>
            <span>{s.title}</span>
          </li>
        ))}
      </ol>

      {error && <div className="notice notice-error" role="alert" style={{ margin: '16px 0' }}><span className="icon">!</span><span>{error}</span></div>}

      {step === 'consent' && consent && (
        <section className="section">
          <h2>第一步　{consent.title}</h2>
          <h3>三条红线</h3>
          <ol>
            {consent.points.map((p) => <li key={p}>{p}</li>)}
          </ol>
          <h3>还有几件事你应该知道</h3>
          <ul>
            {consent.notes.map((p) => <li key={p}>{p}</li>)}
          </ul>
          <label className="check">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>我已阅读并同意以上内容，知道我在使用AI时要遵守的边界。</span>
          </label>
          <button type="button" className="btn btn-primary" disabled={!agreed || busy} onClick={() => void doConsent()}>
            {busy ? '正在保存…' : '同意并继续'} <span className="arrow">→</span>
          </button>
        </section>
      )}

      {step === 'modules' && (
        <section className="section">
          <h2>第二步　认识基础模块与高阶模块</h2>
          <p className="muted">基础模块用平台的 Key，注册后直接可用，不需要你做任何配置；高阶模块需要绑定你自己的 API Key。</p>
          <h3>基础模块（人人可用）</h3>
          <ul className="list">
            {basic.map((m) => <li key={m.id}>{m.name}<span className="muted small"> · {m.note}</span></li>)}
          </ul>
          <h3>高阶模块（需要自己的 Key）</h3>
          <ul className="list">
            {advanced.map((m) => <li key={m.id}>{m.name}<span className="muted small"> · {m.note}</span></li>)}
          </ul>
          <p className="muted small">绑定 Key 是可选的，可以跳过：第六章课上会统一注册绑定。不绑定不影响结课考核。</p>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void doModules()}>
              {busy ? '正在保存…' : '我知道了'} <span className="arrow">→</span>
            </button>
            <a className="btn btn-text" href="/me/keys">现在就去绑定（可选）</a>
          </div>
        </section>
      )}

      {step === 'survey' && survey && (
        <section className="section">
          <h2>第三步　{survey.title}</h2>
          <SurveyForm def={survey} onSubmitted={() => void load()} />
          {state?.steps.find((s) => s.key === 'survey')?.done && (
            <button type="button" className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => setStep('persona')}>
              继续选搭子 <span className="arrow">→</span>
            </button>
          )}
        </section>
      )}

      {step === 'persona' && (
        <section className="section">
          <h2>第四步　选择搭子人设</h2>
          <p className="muted">四位都是 AI 导师，随时可以换，记忆不会丢。</p>
          <div className="mentor-list">
            {companions.map((c) => (
              <button key={c.key} type="button" className="mentor-option" aria-pressed={me?.persona === c.key} disabled={busy} onClick={() => void choosePersona(c.key)}>
                <MentorIcon agent={c} size={44} />
                <span>
                  <strong>{c.name}｜{c.duty}</strong> <span className="ai-tag">AI导师</span>
                  <span className="muted small" style={{ display: 'block' }}>{c.summary}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="row" style={{ marginTop: 24 }}>
            <button type="button" className="btn btn-primary" onClick={() => void finish()} disabled={!me?.persona}>
              开始第1站 <span className="arrow">→</span>
            </button>
            <span className="muted small">
              当前：{getAgent(me?.persona || '')?.name || '未选择'}
            </span>
          </div>
        </section>
      )}
    </div>
  );
}
