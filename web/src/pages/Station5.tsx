// 第5站 制定方案：菜单 → 生成方案JSON → 学生改 → 点“采用这份方案”才保存（M7）
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { MenuDef, PlanData, PlanResp } from '../api/types2';
import { MenuForm } from '../components/MenuForm';
import { StationShell } from './Road';
import { useToast } from '../components/Toast';

export default function Station5() {
  const toast = useToast();
  const [menu, setMenu] = useState<MenuDef | null>(null);
  const [data, setData] = useState<PlanResp | null>(null);
  const [draft, setDraft] = useState<PlanData | null>(null);
  const [cap, setCap] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [showMenu, setShowMenu] = useState(false);

  const load = useCallback(async () => {
    const [m, p] = await Promise.all([api<MenuDef>('/menus/plan'), api<PlanResp>('/plan')]);
    setMenu(m); setData(p);
    setDraft(p.plan);
    setShowMenu(!m.answers || !p.plan);
  }, []);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  const saveMenu = async (answers: Record<string, unknown>) => {
    setBusy('menu'); setError('');
    try {
      await api('/menus/plan', { body: { answers } });
      const m = await api<MenuDef>('/menus/plan');
      setMenu(m);
      if (data?.plan) setShowMenu(false);
      toast('菜单已保存');
    } catch (e) { setError(e instanceof ApiError ? e.message : '保存失败，请重试。'); } finally { setBusy(''); }
  };

  const generate = async () => {
    setBusy('gen'); setError('');
    try {
      const r = await api<{ plan: PlanData; daily_cap_minutes: number }>('/plan/generate', { body: {}, withKey: true });
      setDraft(r.plan);
      setCap(r.daily_cap_minutes);
      toast('方案已生成，请改到你觉得能用');
    } catch (e) { setError(e instanceof ApiError ? e.message : '生成失败，请重试。'); } finally { setBusy(''); }
  };

  const adopt = async () => {
    if (!draft) return;
    setBusy('adopt'); setError('');
    try {
      await api('/plan/save', { body: { plan: draft } });
      toast('方案已采用，明天开始打卡');
      await load();
      setShowMenu(false);
    } catch (e) { setError(e instanceof ApiError ? e.message : '保存失败，请重试。'); } finally { setBusy(''); }
  };

  const editTask = (di: number, ti: number, patch: Partial<PlanData['week'][0]['tasks'][0]>) => {
    setDraft((d) => {
      if (!d) return d;
      const week = d.week.map((day, i) => (i !== di ? day : { ...day, tasks: day.tasks.map((t, j) => (j !== ti ? t : { ...t, ...patch })) }));
      return { ...d, week };
    });
  };

  const removeTask = (di: number, ti: number) => {
    setDraft((d) => {
      if (!d) return d;
      const week = d.week.map((day, i) => (i !== di ? day : { ...day, tasks: day.tasks.filter((_, j) => j !== ti) }));
      return { ...d, week };
    });
  };

  const addTask = (di: number) => {
    setDraft((d) => {
      if (!d) return d;
      const week = d.week.map((day, i) => (i !== di ? day : { ...day, tasks: [...day.tasks, { title: '新任务', kind: '专业课', minutes: 30 }] }));
      return { ...d, week };
    });
  };

  const dayTotal = (day: PlanData['week'][0]) => day.tasks.reduce((n, t) => n + (Number(t.minutes) || 0), 0);

  return (
    <StationShell station={5}>
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}

      <section className="section">
        <div className="row">
          <h2 style={{ margin: 0 }}>第一步　告诉我你的时间和重点</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={() => setShowMenu((v) => !v)}>{showMenu ? '收起' : '修改'}</button>
        </div>
        {showMenu && menu && <MenuForm def={menu} submitting={busy === 'menu'} submitLabel="保存并生成方案" onSubmit={(a) => void saveMenu(a)} />}
        {!showMenu && menu?.answers && (
          <ul className="list">
            <li><span className="muted">每周可投入：</span>{String(menu.answers.weekly_hours)} 小时</li>
            <li><span className="muted">可用时段：</span>{(menu.answers.slots as string[])?.join('、')}</li>
            <li><span className="muted">本阶段重点：</span>{(menu.answers.focus as string[])?.join('、')}</li>
          </ul>
        )}
      </section>

      <section className="section">
        <h2>第二步　生成方案</h2>
        <p className="muted">生成的是草案，采用之前不会保存。每天任务总时长会自动控制在你的可投入时间之内（每天上限 = 每周小时 ÷ 7 × 1.2）。</p>
        <button type="button" className="btn btn-primary" disabled={busy === 'gen' || !menu?.answers} onClick={() => void generate()}>
          {busy === 'gen' ? '正在生成…' : draft ? '重新生成一份' : '生成学习方案'}
        </button>
        {cap && <p className="muted small">每天任务上限：{cap} 分钟</p>}
        {data?.reduce_flag && <p className="notice notice-warn"><span className="icon">!</span><span>最近完成率偏低，这次生成会自动减量约30%。</span></p>}
      </section>

      {draft && (
        <>
          <section className="section">
            <h2>第三步　改成你觉得能用的样子</h2>
            <div className="field">
              <label htmlFor="plan-goal">这一阶段的目标</label>
              <textarea id="plan-goal" className="textarea" value={draft.goal} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} />
            </div>
            <h3>阶段划分</h3>
            <ul className="list">
              {draft.phases.map((p, i) => (
                <li key={`${p.name}-${i}`}>
                  <strong>{p.name}</strong> <span className="muted small">{p.range}</span>
                  <p className="small" style={{ margin: '2px 0' }}>{p.focus}</p>
                  <p className="muted small" style={{ margin: 0 }}>里程碑：{p.milestone}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="section">
            <h3>未来7天</h3>
            {draft.week.map((day, di) => {
              const total = dayTotal(day);
              const over = cap !== null && total > cap;
              return (
                <div key={day.date} className="card">
                  <div className="row">
                    <strong>{day.date}</strong>
                    <span className={`badge ${over ? 'badge-warn' : 'badge-muted'}`}>{total} 分钟{cap !== null && ` / 上限 ${cap}`}</span>
                    <span className="spacer" />
                    <button type="button" className="btn btn-text btn-sm" onClick={() => addTask(di)}>+ 加任务</button>
                  </div>
                  <ul className="task-list">
                    {day.tasks.map((t, ti) => (
                      <li key={`${day.date}-${ti}`}>
                        <label className="sr-only" htmlFor={`t-${di}-${ti}`}>任务内容</label>
                        <input id={`t-${di}-${ti}`} className="input" style={{ flex: 1, minWidth: 160 }} value={t.title} onChange={(e) => editTask(di, ti, { title: e.target.value })} />
                        <label className="sr-only" htmlFor={`k-${di}-${ti}`}>类型</label>
                        <select id={`k-${di}-${ti}`} className="select" value={t.kind} onChange={(e) => editTask(di, ti, { kind: e.target.value })}>
                          {['英语', '数学', '政治', '专业课', '成果', '阅读', 'AI技能', '复盘'].map((k) => <option key={k} value={k}>{k}</option>)}
                        </select>
                        <label className="sr-only" htmlFor={`m-${di}-${ti}`}>分钟</label>
                        <input id={`m-${di}-${ti}`} type="number" min={0} max={600} step={5} className="input" style={{ width: 80 }} value={t.minutes} onChange={(e) => editTask(di, ti, { minutes: Number(e.target.value) })} />
                        <button type="button" className="btn btn-text btn-sm" onClick={() => removeTask(di, ti)}>删除</button>
                      </li>
                    ))}
                    {!day.tasks.length && <li className="muted small">这一天还没有任务，可以当作缓冲日。</li>}
                  </ul>
                </div>
              );
            })}
          </section>

          <section className="section">
            <h3>成果铺垫</h3>
            <ul className="list">
              {draft.achievements.map((a, i) => (
                <li key={`${a.name}-${i}`}><strong>{a.type}</strong>：{a.name} <span className="muted small">（{a.when}）</span>
                  <p className="small" style={{ margin: '2px 0' }}>{a.why}</p>
                  <p className="muted small" style={{ margin: 0 }}>AI能帮：{a.ai_help}</p>
                </li>
              ))}
            </ul>
            <p><strong>缓冲规则：</strong>{draft.buffer_rule}</p>
            <p><strong>调整条件：</strong>{draft.check_rule}</p>
          </section>

          <section className="section">
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy === 'adopt'} onClick={() => void adopt()}>
                {busy === 'adopt' ? '正在保存…' : '采用这份方案'} <span className="arrow">→</span>
              </button>
              <button type="button" className="btn" onClick={() => void generate()}>重新生成</button>
              {data?.latest_is_active && <span className="badge badge-ok">当前已在执行</span>}
            </div>
            {data?.versions?.length ? <p className="muted small">历史版本 {data.versions.length} 份，旧版本会保留。</p> : null}
          </section>
        </>
      )}

      {!draft && !showMenu && (
        <section className="section">
          <p className="muted">还没有方案。先填菜单，再点“生成学习方案”。</p>
        </section>
      )}
    </StationShell>
  );
}
