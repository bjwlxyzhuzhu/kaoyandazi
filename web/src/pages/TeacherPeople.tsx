// 教师 · 概览（M16）与学生（列表 + 详情）
// 学生详情只有学习记录与平台指标；看不到私聊、会议原文、长期记忆内容和数字分身。
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { BarList } from '../components/Charts';

interface Metric { id: string; label: string; value: number | string | null; unit: string; formula: string }

export function TeacherOverview() {
  const [d, setD] = useState<{ scope: string; cards: Metric[]; funnel: { station: number; name: string; done: number; rate: number | null }[]; paths: { path: string; count: number }[]; portfolio_rate: number | null; note: string } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<NonNullable<typeof d>>('/teacher/overview').then(setD).catch((e) => setErr((e as Error).message)); }, []);
  if (err) return <p className="notice notice-error"><span className="icon">!</span><span>{err}</span></p>;
  if (!d) return <p className="muted">正在载入…</p>;
  const names: Record<string, string> = { kaoyan: '考研', baoyan: '保研', job: '就业', gongkao: '考公选调', abroad: '出国', 未选: '还没选' };
  return (
    <div className="page">
      <h1>全班概览</h1>
      <p className="muted">{d.scope} {d.note}</p>
      <section className="section">
        <div className="metric-grid">
          {d.cards.map((c) => (
            <div key={c.id} className="metric" title={c.formula}>
              <span className="num">{c.value ?? '—'}<small>{c.value !== null ? c.unit : ''}</small></span>
              <span className="lbl">{c.label}</span>
            </div>
          ))}
          <div className="metric" title="五项考核中已完成项目的比例（全班平均）">
            <span className="num">{d.portfolio_rate ?? '—'}<small>{d.portfolio_rate !== null ? '%' : ''}</small></span>
            <span className="lbl">档案袋完成度</span>
          </div>
        </div>
        <p className="muted small">把鼠标停在数字上可以看计算口径；详细口径和下钻在 <Link to="/teacher/impact">成效看板</Link>。</p>
      </section>
      <section className="section">
        <BarList title="各站完成人数（流程漏斗）" items={d.funnel.map((f) => ({ label: `${f.station} ${f.name}`, value: f.done, hint: f.rate === null ? '' : `完成率 ${f.rate}%` }))} unit=" 人" />
      </section>
      <section className="section">
        <BarList title="路径分布" note="学生在第3站自己选定的路径" items={d.paths.map((p) => ({ label: names[p.path] || p.path, value: p.count }))} unit=" 人" />
      </section>
    </div>
  );
}

interface Row { id: number; student_no: string; name: string; station: number; path: string; last_checkin: string | null; last_seen: string | null; pending_interventions: number; portfolio_missing: number }

export function TeacherStudents() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { api<{ students: Row[] }>('/teacher/students').then((r) => setRows(r.students)).catch(() => setRows([])); }, []);
  if (!rows) return <p className="muted">正在载入…</p>;
  const shown = rows.filter((r) => !q || r.name.includes(q) || r.student_no.includes(q));
  return (
    <div className="page">
      <h1>学生</h1>
      <p className="muted">只列真实班级的学生。这里看得到学习记录与平台指标，看不到私聊、会议原文、长期记忆内容和数字分身。</p>
      <input className="input" style={{ maxWidth: 260, marginBottom: 12 }} placeholder="按姓名或学号搜索" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索学生" />
      <section className="section">
        <table className="score-table small">
          <thead><tr><th>学号</th><th>姓名</th><th>当前站</th><th>路径</th><th>最近打卡</th><th>最近登录</th><th>待处理提醒</th><th>档案缺项</th><th /></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td>{r.student_no}</td><td>{r.name}</td><td className="num">{r.station}</td><td>{r.path || '—'}</td>
                <td>{r.last_checkin || '—'}</td><td>{r.last_seen?.slice(0, 16) || '—'}</td>
                <td className="num">{r.pending_interventions}</td><td className="num">{r.portfolio_missing}</td>
                <td><Link to={`/teacher/students/${r.id}`}>详情</Link></td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={9} className="muted">没有学生。</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}

type Detail = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function TeacherStudentDetail() {
  const { id } = useParams();
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Detail>(`/teacher/students/${id}`).then(setD).catch((e) => setErr((e as Error).message)); }, [id]);
  if (err) return <p className="notice notice-error"><span className="icon">!</span><span>{err}</span></p>;
  if (!d) return <p className="muted">正在载入…</p>;
  const s = d.student;
  return (
    <div className="page">
      <p className="muted small"><Link to="/teacher/students">← 学生</Link></p>
      <h1>{s.name} <span className="muted small">{s.student_no} · {s.major} {s.grade}</span></h1>
      <p className="notice notice-ok"><span className="icon">i</span><span>{d.privacy}</span></p>
      <section className="section">
        <h2>主线进度</h2>
        <div className="chips">{d.flow.map((f: Detail) => <span key={f.station} className={`badge ${f.status === 'done' ? 'badge-ok' : f.status === 'in_progress' ? 'badge-warn' : 'badge-muted'}`}>{f.station} {f.name}</span>)}</div>
      </section>
      <section className="section">
        <h2>画像与路径</h2>
        {d.profile ? <><p>{d.profile.summary}</p><p className="small muted">优势：{(d.profile.strengths || []).join('、')}；短板：{(d.profile.gaps || []).join('、')}；每周可投入 {d.profile.weekly_hours} 小时</p></> : <p className="muted">还没有画像。</p>}
        {d.path && <p className="small">已选路径：<strong>{d.path.id}</strong>。理由：{d.path.reason}</p>}
      </section>
      <section className="section">
        <h2>学习方案与执行</h2>
        {d.plan ? <p>{d.plan.goal}（{d.plan.versions} 个版本{d.plan.reduced ? '，已减量' : ''}）</p> : <p className="muted">还没有采用方案。</p>}
        <table className="score-table small"><thead><tr><th>日期</th><th>完成</th><th>分钟</th><th>状态</th><th>复盘</th></tr></thead>
          <tbody>{d.checkins.slice(0, 10).map((c: Detail) => <tr key={c.date}><td>{c.date}</td><td>{c.done_count}/{c.total_count}</td><td className="num">{c.minutes}</td><td className="num">{c.mood}</td><td>{c.reflection}</td></tr>)}</tbody></table>
        {!!d.weekly_reviews.length && <ul className="small">{d.weekly_reviews.map((w: Detail) => <li key={w.week_start}>{w.week_start}：完成率 {Math.round(w.rate * 100)}%，{w.summary}</li>)}</ul>}
      </section>
      <section className="section">
        <h2>目标院校</h2>
        {!d.schools.length ? <p className="muted">还没有。</p> : (
          <table className="score-table small"><thead><tr><th>层次</th><th>院校</th><th>已核验</th><th>选择依据</th><th>不确定之处</th></tr></thead>
            <tbody>{d.schools.map((x: Detail, i: number) => <tr key={i}><td>{x.tier}</td><td>{x.school} {x.major}</td><td>{x.verified}/{x.facts}</td><td>{x.basis}</td><td>{x.uncertainty}</td></tr>)}</tbody></table>
        )}
      </section>
      <section className="section">
        <h2>知识库、选题与成果</h2>
        <p className="small">知识条目 {d.kb.items}，文献 {d.kb.papers}，阅读卡 {d.kb.cards}；长期记忆 {d.memory_count} 条（只显示条数，看不到内容）</p>
        {!!d.ideas.length && <ul className="small">{d.ideas.map((i: Detail, k: number) => <li key={k}>选题（{i.status}）：{i.question}</li>)}</ul>}
        {!!d.achievements.length && <ul className="small">{d.achievements.map((a: Detail, k: number) => <li key={k}>【{a.type}】{a.name}｜{a.stage}</li>)}</ul>}
      </section>
      <section className="section">
        <h2>课堂与干预</h2>
        <p className="small">课堂任务 {d.classroom.submitted}/{d.classroom.tasks}；互评 {d.classroom.peer_done}/{d.classroom.peer_assigned}</p>
        <ul className="small">{d.interventions.map((v: Detail, k: number) => <li key={k}>{v.created_at.slice(0, 10)} {v.rule} {v.title} → {v.chosen ? `选了 ${v.chosen}${v.note ? `（${v.note}）` : ''}` : '还没处理'}</li>)}</ul>
        {!!d.mail_log.length && <p className="small muted">邮件：{d.mail_log.map((m: Detail) => `${m.created_at.slice(5, 16)} ${m.kind} ${m.ok ? '已发送' : m.info}`).join('；')}</p>}
      </section>
      <section className="section">
        <h2>考核档案袋</h2>
        <ul className="list small">{d.portfolio.items.map((it: Detail) => <li key={it.key}><strong>{it.name}</strong>　{it.status === 'done' ? '已完成' : it.status === 'partial' ? '进行中' : '未开始'}{it.missing.length ? `　缺：${it.missing.join('；')}` : ''}</li>)}</ul>
        <Link className="btn btn-sm" to="/teacher/grades">去评分</Link>
      </section>
    </div>
  );
}
