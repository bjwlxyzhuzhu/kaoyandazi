// 我 → 模型与 API Key（PRD 5.4）
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, userKeyStore } from '../api/client';
import type { Me, ModuleRow, Quota } from '../api/types';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';

interface ModulesResp { modules: ModuleRow[]; no_key: string; has_key: boolean }
interface UsageRow { kind: string; calls: number; prompt_tokens: number; completion_tokens: number }

function StatusBadge({ s }: { s: ModuleRow['status'] }) {
  if (s === 'available') return <span className="badge badge-ok">✅ 可用</span>;
  if (s === 'need_key') return <span className="badge badge-lock">🔒 需绑定自己的 Key</span>;
  return <span className="badge badge-pause">⏸ 今日额度已用完</span>;
}

const localMask = (k: string) => (k ? `sk-****${k.slice(-4)}` : '');

export default function MeKeys() {
  const { me, setMe } = useAuth();
  const toast = useToast();
  const [mods, setMods] = useState<ModulesResp | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [usage, setUsage] = useState<UsageRow[]>([]);
  const [localKey, setLocalKey] = useState(userKeyStore.get());
  const [input, setInput] = useState('');
  const [onServer, setOnServer] = useState(false);
  const [tested, setTested] = useState<{ key: string; models: string[]; mock: boolean } | null>(null);
  const [busy, setBusy] = useState<'' | 'test' | 'save' | 'delete' | 'pref'>('');
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const [m, q, u] = await Promise.all([
      api<ModulesResp>('/me/modules', { withKey: true }),
      api<Quota>('/me/quota'),
      api<{ by_module: UsageRow[] }>('/me/usage'),
    ]);
    setMods(m); setQuota(q); setUsage(u.by_module);
  }, []);

  useEffect(() => { reload().catch((e) => setError((e as Error).message)); }, [reload]);

  const bound = !!localKey || !!me?.key_saved_on_server;

  const test = async () => {
    setError('');
    setBusy('test');
    try {
      const r = await api<{ models: string[]; mock: boolean }>('/me/key/test', { method: 'POST', key: input.trim() });
      setTested({ key: input.trim(), models: r.models, mock: r.mock });
      toast('连通成功');
    } catch (e) {
      setTested(null);
      setError(e instanceof ApiError ? e.message : '测试失败，请重试。');
    } finally {
      setBusy('');
    }
  };

  const save = async () => {
    if (!tested || tested.key !== input.trim()) return;
    setError('');
    setBusy('save');
    try {
      let r: { me: Me };
      if (onServer) {
        r = await api<{ me: Me }>('/me/key', { method: 'PUT', body: { key: tested.key, save_on_server: true } });
        userKeyStore.clear();
        setLocalKey('');
      } else {
        // 默认只保存在本机浏览器；同时清除服务器上可能存在的旧 Key
        r = await api<{ me: Me }>('/me/key', { method: 'DELETE' });
        userKeyStore.set(tested.key);
        setLocalKey(tested.key);
      }
      setMe(r.me);
      setInput('');
      setTested(null);
      toast('已保存');
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败，请重试。');
    } finally {
      setBusy('');
    }
  };

  const remove = async () => {
    if (!window.confirm('确定删除已绑定的 Key 吗？删除后高阶模块会重新锁定。')) return;
    setBusy('delete');
    try {
      const r = await api<{ me: Me }>('/me/key', { method: 'DELETE' });
      userKeyStore.clear();
      setLocalKey('');
      setMe(r.me);
      toast('已删除');
      await reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const setPref = async (v: boolean) => {
    setBusy('pref');
    try {
      const r = await api<{ me: Me }>('/me/key-preference', { method: 'PUT', body: { use_own_key_basic: v } });
      setMe(r.me);
      await reload();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy('');
    }
  };

  const groups: Array<['basic' | 'advanced', string]> = [['basic', '基础（平台 Key，人人可用）'], ['advanced', '高阶（需自带 Key）']];

  return (
    <div className="page">
      <p><Link to="/me">← 返回“我”</Link></p>
      <h1>模型与 API Key</h1>
      <p className="muted">基础模块使用平台 Key，注册后直接可用；高阶模块需要绑定你自己的 Key。是否绑定不影响结课考核。</p>
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}

      <section className="section">
        <h2>1. 模块权限</h2>
        {!mods ? <p className="muted">正在载入…</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>模块</th><th>使用的 Key</th><th>状态</th><th>说明</th></tr></thead>
              <tbody>
                {groups.map(([tier, label]) => (
                  <FragmentRows key={tier} label={label} rows={mods.modules.filter((m) => m.tier === tier)} />
                ))}
                <tr className="tier-head"><td colSpan={4}>无需 Key</td></tr>
                <tr><td colSpan={2}>{mods.no_key}</td><td><span className="badge badge-ok">✅ 可用</span></td><td className="muted small">不调用大模型</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <h2>2. 今日基础额度</h2>
        {quota ? (
          <>
            <p style={{ margin: 0 }}>已用 <strong>{quota.used}</strong> / 上限 <strong>{quota.limit}</strong> 次</p>
            {quota.daily_exhausted && <p className="notice notice-warn" style={{ marginTop: 12 }}><span className="icon">!</span><span>今天的基础额度用完了，明天恢复；你也可以绑定自己的 Key 继续使用。</span></p>}
            {quota.monthly_blocked && <p className="notice notice-warn" style={{ marginTop: 12 }}><span className="icon">!</span><span>本月班级的基础模块额度已用完，请联系老师。</span></p>}
          </>
        ) : <p className="muted">正在载入…</p>}
      </section>

      <section className="section">
        <h2>3. 我的 API Key</h2>
        {bound ? (
          <div className="row" style={{ marginBottom: 16 }}>
            <span>已绑定：<strong>{me?.key_saved_on_server ? me.key_mask : localMask(localKey)}</strong></span>
            <span className="badge badge-muted">{me?.key_saved_on_server ? '服务器加密保存' : '仅保存在本机浏览器'}</span>
            <button type="button" className="btn btn-danger" onClick={() => void remove()} disabled={!!busy}>删除</button>
          </div>
        ) : <p className="muted">尚未绑定。可以跳过，第六章课上会统一注册绑定。</p>}

        <div className="field">
          <label htmlFor="k-input">{bound ? '更换 Key' : '粘贴你的 Key'}</label>
          <input id="k-input" type="password" className="input" autoComplete="off" spellCheck={false} placeholder="sk-..." value={input} onChange={(e) => { setInput(e.target.value); setTested(null); }} />
        </div>
        <label className="check">
          <input type="checkbox" checked={onServer} onChange={(e) => setOnServer(e.target.checked)} />
          <span>在服务器上加密保存，换设备免输入（不勾选时只保存在这台电脑的浏览器里）</span>
        </label>
        <div className="row">
          <button type="button" className="btn" onClick={() => void test()} disabled={!input.trim() || !!busy}>{busy === 'test' ? '正在测试…' : '测试连通'}</button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={!tested || tested.key !== input.trim() || !!busy}>{busy === 'save' ? '正在保存…' : '保存'}</button>
          {!tested && input.trim() && <span className="muted small">先测试连通，成功后才能保存</span>}
        </div>
        {tested && (
          <p className="notice notice-ok" style={{ marginTop: 12 }}>
            <span className="icon">✓</span>
            <span>连通成功{tested.mock ? '（模拟模型）' : ''}，可用模型 {tested.models.length} 个：{tested.models.slice(0, 8).join('、')}{tested.models.length > 8 ? '…' : ''}</span>
          </p>
        )}
        <details style={{ marginTop: 16 }}>
          <summary>怎么获得自己的 Key？</summary>
          <ol className="muted">
            <li>在 tokenone.work 注册账号；</li>
            <li>充值少量金额；</li>
            <li>生成 Key，选择 DeepSeek 对应的分组（以中转站实际名称为准）；</li>
            <li>复制 Key，粘贴到上面的输入框，先“测试连通”，再“保存”。</li>
          </ol>
          <p className="muted small">Key 像一把带余额的钥匙：不要外传、不要截图，发现泄露可以随时在中转站作废。</p>
        </details>
      </section>

      <section className="section">
        <h2>4. 我的模型</h2>
        <p className="muted" style={{ margin: 0 }}>为高阶模块选择默认模型将在阶段6开放。本课程以 DeepSeek 为准，换模型后效果可能不同。</p>
      </section>

      <section className="section">
        <h2>5. 偏好</h2>
        <label className="check">
          <input type="checkbox" checked={!!me?.use_own_key_basic} disabled={!bound || !!busy} onChange={(e) => void setPref(e.target.checked)} />
          <span>基础模块也用我的 Key（为班级节省额度）{!bound && <span className="muted small">（需先绑定 Key）</span>}</span>
        </label>
      </section>

      <section className="section">
        <h2>6. 我的用量</h2>
        {!usage.length ? <p className="muted" style={{ margin: 0 }}>暂无记录（只统计你自己的 Key）。</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>模块</th><th>调用次数</th><th>输入 token</th><th>输出 token</th></tr></thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={u.kind}><td>{mods?.modules.find((m) => m.id === u.kind)?.name || u.kind}</td><td>{u.calls}</td><td>{u.prompt_tokens}</td><td>{u.completion_tokens}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>费用估算（按教师设定的单价）将在阶段6开放。</p>
      </section>
    </div>
  );
}

function FragmentRows({ label, rows }: { label: string; rows: ModuleRow[] }) {
  return (
    <>
      <tr className="tier-head"><td colSpan={4}>{label}</td></tr>
      {rows.map((m) => (
        <tr key={m.id}>
          <td>
            {m.open && m.route ? <Link to={m.route}>{m.name}</Link> : <span>{m.name}</span>}
            {!m.open && <span className="muted small">（后续阶段开放）</span>}
          </td>
          <td>{m.tier === 'basic' ? '平台' : '学生'}</td>
          <td><StatusBadge s={m.status} /></td>
          <td className="muted small">{m.note}</td>
        </tr>
      ))}
    </>
  );
}
