// 教师 · 设置页追加：机构信息与匿名演示模式、评委测试账号、群发通知、重置学生密码、已核实资料（M16、M17）
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useToast } from '../components/Toast';

interface Org { school_name: string; college_name: string; teacher_names: string; extra_terms: string }
interface Judge { id: number; student_no: string; name: string; expires_at: string; demo_note: string; last_seen: string | null; expired: boolean }

export default function TeacherAdmin() {
  const toast = useToast();
  const err = (e: unknown) => toast(e instanceof ApiError ? e.message : '操作失败', 'error');
  const [org, setOrg] = useState<Org | null>(null);
  const [anon, setAnon] = useState(false);
  const [demo, setDemo] = useState<{ accounts: Judge[]; daily_limit: number; demo_key_configured: boolean; note: string } | null>(null);
  const [created, setCreated] = useState<{ student_no: string; password: string; expires_at: string }[]>([]);
  const [gen, setGen] = useState({ count: 1, days: 14, note: '' });
  const [bc, setBc] = useState({ title: '', text: '', email: false });
  const [reset, setReset] = useState('');
  const [resetOut, setResetOut] = useState('');
  const [vm, setVm] = useState('');

  const load = async () => {
    const a = await api<{ enabled: boolean; org: Org }>('/teacher/anonymous-mode');
    setAnon(a.enabled); setOrg(a.org);
    setDemo(await api('/teacher/demo-accounts'));
    setVm((await api<{ text: string }>('/teacher/verified-materials')).text);
  };
  useEffect(() => { void load().catch(err); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!org || !demo) return null;
  return (
    <>
      <section className="section">
        <h2>机构信息与匿名演示模式</h2>
        <p className="muted small">学校、学院、教师姓名会出现在打印版报告里。开启匿名模式后，界面、导出文件和邮件里的这些名称以及所有学生姓名，都会替换成“某地方本科院校”“教师A”“学生001”。录制演示视频、截图时开启。</p>
        <div className="grid-2">
          <div className="field"><label htmlFor="o-s">学校名称</label><input id="o-s" className="input" value={org.school_name} onChange={(e) => setOrg({ ...org, school_name: e.target.value })} /></div>
          <div className="field"><label htmlFor="o-c">学院名称</label><input id="o-c" className="input" value={org.college_name} onChange={(e) => setOrg({ ...org, college_name: e.target.value })} /></div>
          <div className="field"><label htmlFor="o-t">教师姓名（多位用逗号隔开）</label><input id="o-t" className="input" value={org.teacher_names} onChange={(e) => setOrg({ ...org, teacher_names: e.target.value })} /></div>
          <div className="field"><label htmlFor="o-x">其他需要遮掉的词（地名、校区名……）</label><input id="o-x" className="input" value={org.extra_terms} onChange={(e) => setOrg({ ...org, extra_terms: e.target.value })} /></div>
        </div>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => void api('/teacher/org', { method: 'PUT', body: org }).then(() => toast('已保存')).catch(err)}>保存机构信息</button>
          <span className="spacer" />
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={anon} onChange={async (e) => { try { const r = await api<{ enabled: boolean; note: string }>('/teacher/anonymous-mode', { method: 'PUT', body: { enabled: e.target.checked } }); setAnon(r.enabled); toast(r.note); } catch (x) { err(x); } }} />
            <span><strong>匿名演示模式</strong>{anon ? '（已开启）' : ''}</span>
          </label>
        </div>
      </section>

      <section className="section">
        <h2>评委测试账号</h2>
        <p className="muted small">{demo.note}{!demo.demo_key_configured && ' 目前没有配置演示 Key，评委账号使用高阶模块时需要自己填 Key。'}</p>
        <div className="row">
          <label className="small" htmlFor="j-n">数量</label><input id="j-n" type="number" className="input" style={{ width: 70 }} min={1} max={10} value={gen.count} onChange={(e) => setGen({ ...gen, count: Number(e.target.value) })} />
          <label className="small" htmlFor="j-d">有效天数</label><input id="j-d" type="number" className="input" style={{ width: 70 }} min={1} max={60} value={gen.days} onChange={(e) => setGen({ ...gen, days: Number(e.target.value) })} />
          <input className="input" style={{ flex: 1 }} placeholder="备注（发给哪个评审组）" value={gen.note} onChange={(e) => setGen({ ...gen, note: e.target.value })} aria-label="备注" />
          <button type="button" className="btn btn-primary btn-sm" onClick={async () => { try { const r = await api<{ accounts: typeof created }>('/teacher/demo-accounts', { body: gen }); setCreated(r.accounts); await load(); } catch (x) { err(x); } }}>生成</button>
        </div>
        <p className="muted small">每个评委账号每天最多调用 AI {demo.daily_limit} 次。</p>
        {!!created.length && (
          <div className="notice notice-ok"><span className="icon">✓</span><div>
            <p style={{ marginTop: 0 }}>密码只显示这一次，请复制保存：</p>
            <ul className="small">{created.map((c) => <li key={c.student_no}>账号 <code>{c.student_no}</code>　密码 <code>{c.password}</code>　有效期至 {c.expires_at}</li>)}</ul>
          </div></div>
        )}
        <ul className="list small">{demo.accounts.map((a) => (
          <li key={a.id} className="row"><code>{a.student_no}</code><span>{a.demo_note}</span><span className={`badge ${a.expired ? 'badge-pause' : 'badge-ok'}`}>{a.expired ? '已过期' : `至 ${a.expires_at.slice(0, 10)}`}</span><span className="muted">最近登录 {a.last_seen?.slice(0, 16) || '从未'}</span><span className="spacer" />
            <button type="button" className="btn btn-text btn-sm" onClick={async () => { if (!window.confirm('删除这个评委账号和它的全部演示数据？')) return; try { await api(`/teacher/demo-accounts/${a.id}`, { method: 'DELETE' }); await load(); } catch (x) { err(x); } }}>删除</button></li>
        ))}</ul>
      </section>

      <section className="section">
        <h2>群发通知</h2>
        <div className="field"><label htmlFor="b-t">标题</label><input id="b-t" className="input" maxLength={60} value={bc.title} onChange={(e) => setBc({ ...bc, title: e.target.value })} /></div>
        <div className="field"><label htmlFor="b-x">内容</label><textarea id="b-x" className="textarea" maxLength={1000} value={bc.text} onChange={(e) => setBc({ ...bc, text: e.target.value })} /></div>
        <label className="check"><input type="checkbox" checked={bc.email} onChange={(e) => setBc({ ...bc, email: e.target.checked })} /><span>同时发邮件（只发给开启了邮件提醒的同学）</span></label>
        <button type="button" className="btn btn-sm" disabled={!bc.title || !bc.text} onClick={async () => { try { const r = await api<{ note: string }>('/teacher/broadcast', { body: bc }); toast(r.note); setBc({ title: '', text: '', email: false }); } catch (x) { err(x); } }}>发布</button>
      </section>

      <section className="section">
        <h2>重置学生密码</h2>
        <div className="row">
          <input className="input" style={{ maxWidth: 220 }} placeholder="学号" value={reset} onChange={(e) => setReset(e.target.value)} aria-label="学号" />
          <button type="button" className="btn btn-sm" disabled={!reset} onClick={async () => { try { const r = await api<{ name: string; temp_password: string; note: string }>('/teacher/reset-password', { body: { student_no: reset } }); setResetOut(`${r.name} 的临时密码：${r.temp_password}。${r.note}`); } catch (x) { err(x); } }}>生成临时密码</button>
        </div>
        {resetOut && <p className="notice notice-ok"><span className="icon">✓</span><span>{resetOut}</span></p>}
      </section>

      <section className="section">
        <h2>已核实资料</h2>
        <p className="muted small">所有导师都会读到这段文字（附录B.2）。只写已经对照官方公告核实过的信息，写明日期和出处。</p>
        <textarea className="textarea" rows={8} value={vm} onChange={(e) => setVm(e.target.value)} aria-label="已核实资料" />
        <button type="button" className="btn btn-sm" onClick={() => void api('/teacher/verified-materials', { method: 'PUT', body: { text: vm } }).then(() => toast('已保存')).catch(err)}>保存</button>
      </section>
    </>
  );
}
