// 教师 · 成效看板（M17）：只统计真实班级；每个数字都能点开看原始记录；导出 Excel，图表可下载 PNG
import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { BarList, SurveyBars, TrendLine } from '../components/Charts';

interface Metric { group: string; id: string; label: string; value: number | string | null; unit: string; formula: string }
interface Impact {
  generated_at: string; scope: string; metrics: Metric[];
  funnel: { station: number; name: string; done: number; rate: number | null }[];
  trend: { date: string; rate: number | null }[];
  streaks: { bucket: string; count: number }[];
  interventions: { rule: string; triggered: number; chosen: number; rate: number | null }[];
  surveys: { label: string; pre: number | null; mid: number | null; post: number | null }[];
  ai_usage: { kind: string; n: number }[];
}

export default function TeacherImpact() {
  const [d, setD] = useState<Impact | null>(null);
  const [drill, setDrill] = useState<{ metric: Metric; rows: Record<string, unknown>[] } | null>(null);
  const [log, setLog] = useState<{ days: { date: string; total: number; server_errors: number; client_errors: number; success_rate: number | null }[]; note: string } | null>(null);
  useEffect(() => {
    api<Impact>('/teacher/impact').then(setD).catch(() => {});
    api<NonNullable<typeof log>>('/teacher/runlog').then(setLog).catch(() => {});
  }, []);
  if (!d) return <p className="muted">正在载入…</p>;
  const groups = [...new Set(d.metrics.map((m) => m.group))];
  const open = async (m: Metric) => {
    const r = await api<{ rows: Record<string, unknown>[] }>(`/teacher/impact/drill/${m.id}`);
    setDrill({ metric: m, rows: r.rows });
  };
  return (
    <div className="page">
      <div className="row">
        <h1 style={{ margin: 0 }}>成效看板</h1>
        <span className="spacer" />
        <a className="btn" href="/api/teacher/impact/export">导出 Excel</a>
      </div>
      <p className="muted">{d.scope} 每个数字都来自原始记录，点开就能看到是哪些记录算出来的；数据不足时显示“—”，不做任何估算。</p>

      {groups.filter((g) => !['流程'].includes(g)).map((g) => (
        <section key={g} className="section">
          <h2>{g}</h2>
          <div className="metric-grid">
            {d.metrics.filter((m) => m.group === g).map((m) => (
              <button key={m.id} type="button" className="metric metric-btn" onClick={() => void open(m)}>
                <span className="num">{m.value ?? '—'}<small>{m.value !== null ? m.unit : ''}</small></span>
                <span className="lbl">{m.label}</span>
                <span className="formula">{m.formula}</span>
              </button>
            ))}
          </div>
        </section>
      ))}

      {drill && (
        <section className="section" aria-live="polite">
          <div className="row"><h2 style={{ margin: 0 }}>原始记录：{drill.metric.label}（{drill.rows.length} 条）</h2><span className="spacer" /><button type="button" className="btn btn-text btn-sm" onClick={() => setDrill(null)}>收起</button></div>
          <p className="muted small">口径：{drill.metric.formula}</p>
          {!drill.rows.length ? <p className="muted">没有记录。</p> : (
            <div style={{ overflowX: 'auto', maxHeight: 420 }}>
              <table className="score-table small">
                <thead><tr>{Object.keys(drill.rows[0]).map((k) => <th key={k}>{k}</th>)}</tr></thead>
                <tbody>{drill.rows.slice(0, 300).map((r, i) => <tr key={i}>{Object.values(r).map((v, j) => <td key={j}>{String(v ?? '')}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section className="section">
        <BarList title="各站完成率（流程漏斗）" items={d.funnel.map((f) => ({ label: `${f.station} ${f.name}`, value: f.rate, hint: `${f.done} 人` }))} unit="%" max={100} />
      </section>
      <section className="section">
        <TrendLine title="7日完成率趋势（最近14天）" note="每一天的数值 = 截至当天的7天里，已勾选任务 ÷ 全部任务" points={d.trend.map((t) => ({ label: t.date, value: t.rate }))} unit="%" />
      </section>
      <section className="section">
        <BarList title="连续打卡天数分布" items={d.streaks.map((s) => ({ label: s.bucket, value: s.count }))} unit=" 人" />
      </section>
      <section className="section">
        <BarList title="各规则干预响应率" note="响应率 = 学生选了某个选项的卡片 ÷ 触发的卡片" items={d.interventions.map((i) => ({ label: i.rule, value: i.rate, hint: `触发 ${i.triggered}，被选择 ${i.chosen}` }))} unit="%" max={100} />
      </section>
      <section className="section">
        <SurveyBars title="能力自评：前测、中测、后测（1—5）" note="每人只计最近一次；问卷完全匿名统计" rows={d.surveys} />
      </section>
      <section className="section">
        <BarList title="AI 调用的用途分布" items={d.ai_usage.map((a) => ({ label: a.kind, value: a.n }))} unit=" 次" />
      </section>
      {log && (
        <section className="section">
          <h2>运行日志</h2>
          <p className="muted small">{log.note}</p>
          <table className="score-table small"><thead><tr><th>日期</th><th>请求</th><th>正常拒绝（4xx）</th><th>服务器错误</th><th>成功率</th></tr></thead>
            <tbody>{log.days.slice(-14).reverse().map((x) => <tr key={x.date}><td>{x.date}</td><td className="num">{x.total}</td><td className="num">{x.client_errors}</td><td className="num">{x.server_errors}</td><td className="num">{x.success_rate ?? '—'}%</td></tr>)}</tbody></table>
        </section>
      )}
    </div>
  );
}
