// 我：平台怎么认识我（PRD 10.1）：数字分身、它记得什么、模型与 Key、API 实验室、提醒设置、导出与注销
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { MemoriesResp } from '../api/types2';
import { useAuth } from '../auth';
import { useToast } from '../components/Toast';

export default function MePage() {
  const { me, setMe } = useAuth();
  const toast = useToast();
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<MemoriesResp>('/memories').then((r) => setCount(r.count)).catch(() => setCount(null));
  }, []);

  if (!me) return null;

  const saveRemind = async (patch: { email_remind?: boolean; remind_hour?: number }) => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ me: typeof me }>('/me', { method: 'PUT', body: patch });
      setMe(r.me);
      toast('已保存');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '保存失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-narrow">
      <h1>我</h1>
      <p className="muted">平台怎么认识我。</p>

      <section className="section">
        <h3>基本信息</h3>
        <ul className="list">
          <li>{me.name} · 学号 {me.student_no}</li>
          <li>{me.major} · {me.grade} · {me.major_group}</li>
          <li>{me.email}</li>
          {me.class && <li>班级：{me.class.name}{me.is_demo && <span className="badge badge-muted" style={{ marginLeft: 8 }}>演示</span>}</li>}
        </ul>
      </section>

      <section className="section">
        <h3>平台怎么认识我</h3>
        <ul className="list">
          <li>
            <Link to="/me/twin">数字分身</Link>
            <span className="muted small" style={{ display: 'block' }}>看见平台眼中的自己并校正；可以预演复盘会、复试彩排、对话未来的自己。数据来源逐项开关，只有你本人可见。</span>
          </li>
          <li>
            <Link to="/me/lab">API 实验室</Link>
            <span className="muted small" style={{ display: 'block' }}>第六章课堂任务：调参数、双模型对比、保存你自己的小智能体（需要自己的 Key）。</span>
          </li>
        </ul>
      </section>

      <section className="section">
        <h3>设置</h3>
        <ul className="list">
          <li>
            <Link to="/me/keys">模型与 API Key</Link>
            <span className="muted small" style={{ display: 'block' }}>查看哪些模块可用、今日基础额度，绑定你自己的 Key（可选）。</span>
          </li>
          <li>
            <Link to="/memories">它记得什么</Link>
            <span className="muted small" style={{ display: 'block' }}>
              查看、修改、删除平台记住的事{count === null ? '' : `（现在有 ${count} 条）`}。教师看不到这里的内容。
            </span>
          </li>
          <li>
            <strong style={{ display: 'block' }}>提醒设置</strong>
            <label className="check" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={me.email_remind} disabled={busy} onChange={(e) => void saveRemind({ email_remind: e.target.checked })} />
              <span>开启邮件提醒（每日提醒和断卡、过载等提醒都会发到这个邮箱）</span>
            </label>
            <div className="row" style={{ marginTop: 8 }}>
              <label htmlFor="remind-hour" className="label" style={{ margin: 0 }}>每日提醒时间</label>
              <label className="sr-only" htmlFor="remind-hour">每日提醒时间的整点</label>
              <select id="remind-hour" className="select" value={me.remind_hour} disabled={busy || !me.email_remind}
                onChange={(e) => void saveRemind({ remind_hour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => h).map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
              <span className="muted small">这里设置的是你自己的每日提醒；断卡、计划过载等提醒在每天早上8点检查。</span>
            </div>
            {error && <div className="notice notice-error" role="alert" style={{ marginTop: 8 }}><span className="icon">!</span><span>{error}</span></div>}
          </li>
        </ul>
      </section>

      <DataSection />
    </div>
  );
}

/** 导出我的全部数据；注销账号（需要密码和确认词） */
function DataSection() {
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remove = async () => {
    const word = window.prompt('注销会删除你的账号和全部学习数据，不可恢复。确认请输入：注销账号');
    if (word !== '注销账号') { if (word !== null) toast('输入不一致，没有注销', 'warn'); return; }
    setBusy(true); setError('');
    try {
      await api('/me', { method: 'DELETE', body: { password: pw, confirm: '注销账号' } });
      window.location.href = '/login';
    } catch (e) { setError(e instanceof ApiError ? e.message : '注销失败。'); } finally { setBusy(false); }
  };
  return (
    <section className="section">
      <h3>导出与注销</h3>
      <p className="muted small">导出的是你在平台上的全部数据（JSON），不含密码和 Key。</p>
      <button type="button" className="btn btn-sm" onClick={() => { window.location.href = '/api/me/export'; }}>导出我的数据</button>
      <div className="field" style={{ marginTop: 16 }}>
        <label htmlFor="del-pw">注销账号（输入密码）</label>
        <input id="del-pw" type="password" className="input" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </div>
      {error && <div className="notice notice-error" role="alert"><span className="icon">!</span><span>{error}</span></div>}
      <button type="button" className="btn btn-text btn-danger" disabled={!pw || busy} onClick={() => void remove()}>注销账号</button>
    </section>
  );
}
