// 教师后台 · 设置（阶段1：邀请码、模型与 Key、额度、模块分级、平台 Key 用量、个别学生临时调额）
import TeacherAdmin from './TeacherAdmin';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { useToast } from '../components/Toast';

interface LlmView {
  base_url: string; mock: boolean; chat_model: string; reason_model: string;
  platform_key_mask: string; platform_key_source: 'settings' | 'env' | 'none';
  basic_daily_limit: number; monthly_token_budget: number;
  month: { used: number; budget: number; ratio: number; warning: boolean; blocked: boolean };
}
interface TierRow { id: string; name: string; tier: 'basic' | 'advanced'; defaultTier: string; module: string }
interface Usage {
  by_module: { kind: string; calls: number; tokens: number }[];
  by_student: { student_no: string; name: string; calls: number; tokens: number }[];
  by_day: { day: string; calls: number; tokens: number }[];
}

const errText = (e: unknown) => (e instanceof ApiError ? e.message : '操作失败，请重试。');

export default function TeacherSettings() {
  const toast = useToast();
  const [cls, setCls] = useState<{ name: string; invite_code: string } | null>(null);
  const [invite, setInvite] = useState('');
  const [llm, setLlm] = useState<LlmView | null>(null);
  const [form, setForm] = useState({ base_url: '', chat_model: '', reason_model: '', platform_key: '', basic_daily_limit: '60', monthly_token_budget: '0' });
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [testResult, setTestResult] = useState('');
  const [busy, setBusy] = useState('');
  const [quotaNo, setQuotaNo] = useState('');
  const [quotaLimit, setQuotaLimit] = useState('');
  const [quotaInfo, setQuotaInfo] = useState('');

  const applyLlm = (v: LlmView) => {
    setLlm(v);
    setForm({ base_url: v.base_url, chat_model: v.chat_model, reason_model: v.reason_model, platform_key: '', basic_daily_limit: String(v.basic_daily_limit), monthly_token_budget: String(v.monthly_token_budget) });
  };

  const load = useCallback(async () => {
    const [s, l, t, u] = await Promise.all([
      api<{ class: { name: string; invite_code: string } }>('/teacher/settings'),
      api<LlmView>('/teacher/llm'),
      api<{ modules: TierRow[] }>('/teacher/module-tiers'),
      api<Usage>('/teacher/llm/usage'),
    ]);
    setCls(s.class); setInvite(s.class.invite_code);
    applyLlm(l); setTiers(t.modules); setUsage(u);
  }, []);

  useEffect(() => { load().catch((e) => toast(errText(e), 'error')); }, [load, toast]);

  const saveInvite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('invite');
    try {
      const r = await api<{ class: { name: string; invite_code: string } }>('/teacher/settings', { method: 'PUT', body: { invite_code: invite } });
      setCls(r.class);
      toast('邀请码已保存');
    } catch (err) { toast(errText(err), 'error'); } finally { setBusy(''); }
  };

  const saveLlm = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('llm');
    try {
      const body: Record<string, unknown> = { ...form };
      if (!form.platform_key.trim()) delete body.platform_key;
      applyLlm(await api<LlmView>('/teacher/llm', { method: 'PUT', body }));
      toast('模型配置已保存');
    } catch (err) { toast(errText(err), 'error'); } finally { setBusy(''); }
  };

  const clearKey = async () => {
    if (!window.confirm('确定清除后台保存的平台 Key 吗？清除后会使用环境变量中的 Key（如有）。')) return;
    try { applyLlm(await api<LlmView>('/teacher/llm', { method: 'PUT', body: { clear_platform_key: true } })); toast('已清除'); } catch (err) { toast(errText(err), 'error'); }
  };

  const testLlm = async () => {
    setBusy('test');
    setTestResult('');
    try {
      const r = await api<{ models: string[]; mock: boolean; chat_model_found: boolean }>('/teacher/test-llm', { method: 'POST' });
      setTestResult(`连通成功${r.mock ? '（模拟模型）' : ''}：共 ${r.models.length} 个模型。${r.chat_model_found ? '' : '注意：模型列表中没有找到当前设置的对话模型名，请核对。'}`);
    } catch (err) { setTestResult(`连通失败：${errText(err)}`); } finally { setBusy(''); }
  };

  const saveTiers = async () => {
    setBusy('tiers');
    try {
      const map = Object.fromEntries(tiers.map((t) => [t.id, t.tier]));
      const r = await api<{ modules: TierRow[] }>('/teacher/module-tiers', { method: 'PUT', body: { tiers: map } });
      setTiers(r.modules);
      toast('模块分级已保存');
    } catch (err) { toast(errText(err), 'error'); } finally { setBusy(''); }
  };

  const lookupQuota = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('quota');
    try {
      const body = quotaLimit.trim() === '' ? null : { limit: Number(quotaLimit) };
      const r = body
        ? await api<{ name: string; limit: number; used: number; until?: string }>(`/teacher/quota/${encodeURIComponent(quotaNo.trim())}`, { method: 'PUT', body })
        : await api<{ name: string; limit: number; used: number }>(`/teacher/quota/${encodeURIComponent(quotaNo.trim())}`);
      setQuotaInfo(`${r.name}：今日已用 ${r.used} / 上限 ${r.limit} 次${'until' in r && r.until ? `（临时额度有效至 ${r.until}）` : ''}`);
    } catch (err) { setQuotaInfo(errText(err)); } finally { setBusy(''); }
  };

  const resetQuota = async () => {
    try {
      const r = await api<{ name: string; limit: number; used: number }>(`/teacher/quota/${encodeURIComponent(quotaNo.trim())}`, { method: 'PUT', body: { limit: null } });
      setQuotaInfo(`${r.name}：已恢复默认额度，今日已用 ${r.used} / 上限 ${r.limit} 次`);
    } catch (err) { setQuotaInfo(errText(err)); }
  };

  const f = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((x) => ({ ...x, [k]: e.target.value }));

  return (
    <div className="page">
      <h1>设置</h1>
      <p className="muted">阶段1开放：邀请码、模型与 Key、额度与模块分级。其余教师功能（概览、学生、课堂、评分、导师工坊、成效）在后续阶段开放。</p>

      {llm?.month.warning && (
        <div className={`notice ${llm.month.blocked ? 'notice-error' : 'notice-warn'}`} role="alert" style={{ marginBottom: 16 }}>
          <span className="icon">!</span>
          <span>本月平台 token 已使用 {Math.round(llm.month.ratio * 100)}%（{llm.month.used} / {llm.month.budget}）。{llm.month.blocked ? '基础模块已暂停。' : '达到100%时基础模块将暂停。'}</span>
        </div>
      )}

      <section className="section">
        <h2>班级邀请码</h2>
        <form className="row" onSubmit={saveInvite}>
          <label htmlFor="t-invite" className="sr-only">邀请码</label>
          <input id="t-invite" className="input" style={{ maxWidth: 240 }} value={invite} onChange={(e) => setInvite(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={busy === 'invite'}>保存</button>
          {cls && <span className="muted small">当前：{cls.invite_code}</span>}
        </form>
      </section>

      <section className="section">
        <h2>模型与 Key</h2>
        <form onSubmit={saveLlm}>
          <div className="field">
            <label htmlFor="t-base">接口地址（中转站的 /v1 地址；填 mock 使用内置模拟模型）</label>
            <input id="t-base" className="input" value={form.base_url} onChange={f('base_url')} placeholder="https://…/v1" />
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="t-chat">对话模型</label>
              <input id="t-chat" className="input" value={form.chat_model} onChange={f('chat_model')} placeholder="deepseek-chat" />
            </div>
            <div className="field">
              <label htmlFor="t-reason">推理模型（可空）</label>
              <input id="t-reason" className="input" value={form.reason_model} onChange={f('reason_model')} placeholder="deepseek-reasoner" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="t-key">平台 Key（留空表示不修改）</label>
            <input id="t-key" type="password" className="input" autoComplete="off" value={form.platform_key} onChange={f('platform_key')} placeholder="sk-..." />
            <span className="muted small">
              当前：{llm?.platform_key_mask || '未配置'}
              {llm?.platform_key_source === 'env' && '（来自环境变量）'}
              {llm?.platform_key_source === 'settings' && <>（后台保存，AES-256-GCM 加密） <button type="button" className="btn btn-text" onClick={() => void clearKey()}>清除</button></>}
            </span>
          </div>
          <div className="grid-2">
            <div className="field">
              <label htmlFor="t-limit">每人每日基础调用上限（次）</label>
              <input id="t-limit" type="number" min={0} className="input" value={form.basic_daily_limit} onChange={f('basic_daily_limit')} />
            </div>
            <div className="field">
              <label htmlFor="t-budget">班级月度 token 预算（0 表示不限）</label>
              <input id="t-budget" type="number" min={0} className="input" value={form.monthly_token_budget} onChange={f('monthly_token_budget')} />
            </div>
          </div>
          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy === 'llm'}>保存</button>
            <button type="button" className="btn" onClick={() => void testLlm()} disabled={busy === 'test'}>{busy === 'test' ? '正在测试…' : '测试连通'}</button>
            {testResult && <span role="status">{testResult}</span>}
          </div>
        </form>
        {llm && <p className="muted small" style={{ marginTop: 12, marginBottom: 0 }}>本月平台 token 用量：{llm.month.used}{llm.month.budget ? ` / ${llm.month.budget}` : '（未设预算）'}</p>}
      </section>

      <section className="section">
        <h2>个别学生临时调整额度</h2>
        <form className="row" onSubmit={lookupQuota}>
          <label htmlFor="q-no" className="sr-only">学号</label>
          <input id="q-no" className="input" style={{ maxWidth: 200 }} placeholder="学号" value={quotaNo} onChange={(e) => setQuotaNo(e.target.value)} />
          <label htmlFor="q-limit" className="sr-only">今日上限</label>
          <input id="q-limit" type="number" min={0} className="input" style={{ maxWidth: 200 }} placeholder="今日上限（留空=查询）" value={quotaLimit} onChange={(e) => setQuotaLimit(e.target.value)} />
          <button type="submit" className="btn btn-primary" disabled={!quotaNo.trim() || busy === 'quota'}>{quotaLimit.trim() ? '设为今日上限' : '查询'}</button>
          <button type="button" className="btn" disabled={!quotaNo.trim()} onClick={() => void resetQuota()}>恢复默认</button>
        </form>
        {quotaInfo && <p role="status" style={{ marginTop: 12, marginBottom: 0 }}>{quotaInfo}</p>}
      </section>

      <section className="section">
        <h2>模块分级</h2>
        <p className="muted small">基础模块用平台 Key，高阶模块需要学生自带 Key。调整后学生的“模型与 API Key”页面会同步显示。</p>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>模块</th><th>级别</th><th>默认</th></tr></thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <label className="sr-only" htmlFor={`tier-${t.id}`}>{t.name} 的级别</label>
                    <select id={`tier-${t.id}`} className="select" style={{ minWidth: 120 }} value={t.tier} onChange={(e) => setTiers((xs) => xs.map((x) => (x.id === t.id ? { ...x, tier: e.target.value as TierRow['tier'] } : x)))}>
                      <option value="basic">基础</option>
                      <option value="advanced">高阶</option>
                    </select>
                  </td>
                  <td className="muted small">{t.defaultTier === 'basic' ? '基础' : '高阶'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-primary" onClick={() => void saveTiers()} disabled={busy === 'tiers'}>保存分级</button>
        </div>
      </section>

      <section className="section">
        <h2>平台 Key 用量</h2>
        {!usage || !usage.by_day.length ? <p className="muted" style={{ margin: 0 }}>暂无记录</p> : (
          <div className="grid-2" style={{ gap: 24 }}>
            <div className="table-wrap">
              <h3>按天</h3>
              <table className="table"><thead><tr><th>日期</th><th>次数</th><th>token</th></tr></thead>
                <tbody>{usage.by_day.map((d) => <tr key={d.day}><td>{d.day}</td><td>{d.calls}</td><td>{d.tokens}</td></tr>)}</tbody></table>
            </div>
            <div className="table-wrap">
              <h3>按模块</h3>
              <table className="table"><thead><tr><th>模块</th><th>次数</th><th>token</th></tr></thead>
                <tbody>{usage.by_module.map((d) => <tr key={d.kind}><td>{tiers.find((t) => t.id === d.kind)?.name || d.kind}</td><td>{d.calls}</td><td>{d.tokens}</td></tr>)}</tbody></table>
              <h3 style={{ marginTop: 16 }}>按学生</h3>
              <table className="table"><thead><tr><th>学号</th><th>姓名</th><th>次数</th><th>token</th></tr></thead>
                <tbody>{usage.by_student.map((d) => <tr key={d.student_no}><td>{d.student_no}</td><td>{d.name}</td><td>{d.calls}</td><td>{d.tokens}</td></tr>)}</tbody></table>
            </div>
          </div>
        )}
      </section>
      <TeacherAdmin />
    </div>
  );
}
