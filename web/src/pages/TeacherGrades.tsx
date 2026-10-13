// 教师 · 评分（M14）：逐项打分（参考平台指标，最终分数由老师决定）、查看已提交的行动方案、导出成绩表
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { ActionPlanView, PortfolioItem, TeacherGradeRow } from '../api/types2';
import { useToast } from '../components/Toast';

interface ItemDef { key: string; name: string; weight: number; levels: Record<string, string>; indicators: string }
interface Detail {
  student: { id: number; student_no: string; name: string; major: string | null; grade: string | null };
  portfolio: { items: PortfolioItem[] };
  action_plan: Pick<ActionPlanView, 'draft' | 'reflections' | 'ai_statement' | 'submitted_at'> | null;
  grades: TeacherGradeRow['grades'];
  total: number | null;
  note: string;
}
const ST: Record<string, string> = { done: '✓', partial: '…', missing: '—' };

export default function TeacherGrades() {
  const toast = useToast();
  const [items, setItems] = useState<ItemDef[]>([]);
  const [rows, setRows] = useState<TeacherGradeRow[]>([]);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [draft, setDraft] = useState<Record<string, { score: string; comment: string }>>({});
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const r = await api<{ items: ItemDef[]; students: TeacherGradeRow[] }>('/teacher/grades');
    setItems(r.items); setRows(r.students);
  }, []);
  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  const open = async (id: number) => {
    setError('');
    try {
      const d = await api<Detail>(`/teacher/grades/${id}`);
      setDetail(d);
      setDraft(Object.fromEntries(items.map((it) => [it.key, { score: d.grades[it.key]?.score?.toString() ?? '', comment: d.grades[it.key]?.comment ?? '' }])));
    } catch (e) { setError((e as Error).message); }
  };

  const save = async (key: string) => {
    if (!detail) return;
    const v = draft[key];
    try {
      const r = await api<{ total: number | null }>(`/teacher/grades/${detail.student.id}`, { method: 'PUT', body: { item: key, score: v.score === '' ? null : Number(v.score), comment: v.comment } });
      setDetail({ ...detail, total: r.total });
      toast('已保存');
      await load();
    } catch (e) { toast(e instanceof ApiError ? e.message : '保存失败', 'error'); }
  };

  return (
    <div className="page">
      <div className="row">
        <h1 style={{ margin: 0 }}>评分</h1>
        <span className="spacer" />
        <a className="btn" href="/api/teacher/grades/export">导出成绩表（CSV）</a>
      </div>
      <p className="muted">按申报表的考核结构逐项打分。平台指标只是参考，<strong>最终分数由老师决定</strong>；五项都评完才算总评。这里看不到学生的私聊、会议原文和数字分身。</p>
      {error && <div className="notice notice-error" role="alert"><span className="icon">!</span><span>{error}</span></div>}

      <section className="section">
        <table className="score-table small">
          <thead>
            <tr><th>学号</th><th>姓名</th>{items.map((it) => <th key={it.key} title={it.name}>{it.name.slice(0, 6)}（{it.weight}%）</th>)}<th>总评</th><th>终结性材料</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td>{s.student_no}</td><td>{s.name}</td>
                {items.map((it) => <td key={it.key} className="num" title={`档案：${s.status[it.key]}`}>{s.grades[it.key]?.score ?? <span className="muted">{ST[s.status[it.key]]}</span>}</td>)}
                <td className="num"><strong>{s.total ?? '—'}</strong></td>
                <td>{s.submitted_at ? <span className="badge badge-ok">已提交</span> : <span className="badge badge-muted">未提交</span>}</td>
                <td><button type="button" className="btn btn-text btn-sm" onClick={() => void open(s.id)}>评分</button></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={items.length + 5} className="muted">正式班级里还没有学生。</td></tr>}
          </tbody>
        </table>
        <p className="muted small">没打分的格子显示档案状态：✓ 已完成，… 进行中，— 还没开始。</p>
      </section>

      {detail && (
        <section className="section">
          <div className="row">
            <h2 style={{ margin: 0 }}>{detail.student.name}（{detail.student.student_no}）</h2>
            <span className="muted small">{detail.student.major} {detail.student.grade}</span>
            <span className="spacer" />
            <strong>总评：{detail.total ?? '未评完'}</strong>
            <button type="button" className="btn btn-text btn-sm" onClick={() => setDetail(null)}>收起</button>
          </div>
          {detail.portfolio.items.map((it) => {
            const def = items.find((x) => x.key === it.key)!;
            const v = draft[it.key] || { score: '', comment: '' };
            return (
              <div key={it.key} className="card">
                <div className="row"><strong>{it.name}（{it.weight}%）</strong><span className="badge badge-muted">{{ done: '已完成', partial: '进行中', missing: '未开始' }[it.status]}</span></div>
                <p className="small" style={{ margin: '4px 0' }}>产物：{it.products.join('；')}</p>
                <p className="small muted" style={{ margin: '4px 0' }}>平台指标：{Object.entries(it.metrics).map(([k, m]) => `${k} ${typeof m === 'object' ? Object.entries(m).map(([a, b]) => `${a}${b}`).join('、') || '—' : m}`).join('；')}</p>
                {!!it.missing.length && <p className="small" style={{ color: 'var(--c-warn)', margin: '4px 0' }}>缺项：{it.missing.join('；')}</p>}
                <details><summary className="small">量规</summary><ul className="small">{Object.entries(def.levels).map(([lv, t]) => <li key={lv}><strong>{lv}</strong>：{t}</li>)}</ul></details>
                <div className="row" style={{ marginTop: 8 }}>
                  <label className="small" htmlFor={`g-${it.key}`}>分数</label>
                  <input id={`g-${it.key}`} className="input" type="number" min={0} max={100} style={{ width: 90 }} value={v.score} onChange={(e) => setDraft((d) => ({ ...d, [it.key]: { ...v, score: e.target.value } }))} />
                  <input className="input" style={{ flex: 1 }} maxLength={500} placeholder="评语（选填）" aria-label={`${it.name}评语`} value={v.comment} onChange={(e) => setDraft((d) => ({ ...d, [it.key]: { ...v, comment: e.target.value } }))} />
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => void save(it.key)}>保存</button>
                </div>
              </div>
            );
          })}

          <h3>已提交的行动方案</h3>
          {!detail.action_plan ? <p className="muted">还没有提交。</p> : (
            <>
              <p className="small">提交于 {detail.action_plan.submitted_at}　<a href={`/api/teacher/grades/${detail.student.id}/plan`} target="_blank" rel="noopener">打印版</a>　<a href={`/api/teacher/grades/${detail.student.id}/plan?format=docx`}>下载 Word</a></p>
              {detail.action_plan.draft?.sections.map((s) => (
                <div key={s.key} className="card">
                  <strong>{s.title}</strong>
                  <p className="small" style={{ whiteSpace: 'pre-wrap', margin: '4px 0' }}><span className="muted">我的反思：</span>{detail.action_plan!.reflections[s.key]}</p>
                </div>
              ))}
              <div className="card">
                <strong>AI使用与核验说明</strong>
                <pre className="twin-preview">{detail.action_plan.ai_statement.draft}</pre>
                <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{detail.action_plan.ai_statement.note}</p>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
