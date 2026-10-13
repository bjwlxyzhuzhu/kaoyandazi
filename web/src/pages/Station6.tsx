// 第6站 坚持执行：每日打卡（红色印章只用于这一处）+ 周复盘（菜单式，M7）
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { CheckinTodayResp, MenuDef, WeeklyReviewResp } from '../api/types2';
import { MenuForm } from '../components/MenuForm';
import { StationShell } from './Road';
import { useToast } from '../components/Toast';
import { useAuth } from '../auth';

export default function Station6() {
  const toast = useToast();
  const { me } = useAuth();
  const [today, setToday] = useState<CheckinTodayResp | null>(null);
  const [weekly, setWeekly] = useState<WeeklyReviewResp | null>(null);
  const [menu, setMenu] = useState<MenuDef | null>(null);
  const [doneIds, setDoneIds] = useState<number[]>([]);
  const [minutes, setMinutes] = useState(0);
  const [accuracy, setAccuracy] = useState('');
  const [mood, setMood] = useState(3);
  const [reflection, setReflection] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [stamped, setStamped] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [t, w, m] = await Promise.all([
      api<CheckinTodayResp>('/checkin/today'),
      api<WeeklyReviewResp>('/weekly-review'),
      api<MenuDef>('/menus/weekly'),
    ]);
    setToday(t); setWeekly(w); setMenu(m);
    if (t.checkin) {
      setDoneIds(t.tasks.filter((x) => x.done).map((x) => x.id));
      setMinutes(t.checkin.minutes);
      setAccuracy(t.checkin.accuracy === null ? '' : String(t.checkin.accuracy));
      setMood(t.checkin.mood);
      setReflection(t.checkin.reflection);
      setStamped(t.checkin.id ? `${t.date} 已盖章` : null);
    } else {
      setDoneIds([]);
      setMinutes(0); setAccuracy(''); setMood(3); setReflection('');
    }
  }, []);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  const toggle = (id: number) => setDoneIds((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));

  const submitCheckin = async () => {
    setBusy('checkin'); setError('');
    try {
      const r = await api<{ stamped_at: string; streak: number; updated: boolean }>('/checkin', {
        body: { date: today?.date, done_task_ids: doneIds, minutes, accuracy: accuracy === '' ? null : Number(accuracy), mood, reflection },
      });
      setStamped(`${r.updated ? '已更新' : '已盖章'} · 连续 ${r.streak} 天`);
      toast(r.updated ? '今天的打卡已更新' : '打卡成功，印章盖上了');
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : '打卡失败，请重试。'); } finally { setBusy(''); }
  };

  const submitWeekly = async (answers: Record<string, unknown>) => {
    setBusy('weekly'); setError('');
    try {
      await api('/weekly-review', {
        body: { blockers: answers.blockers, adjust: answers.adjust, summary: answers.summary, week_start: weekly?.current.week_start },
      });
      toast('周复盘已记录');
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : '保存失败，请重试。'); } finally { setBusy(''); }
  };

  if (!today) return <StationShell station={6}>{error ? <div className="notice notice-error"><span className="icon">!</span><span>{error}</span></div> : <p className="muted">正在载入…</p>}</StationShell>;

  const cap = today.cap_minutes;
  const overCap = cap !== null && minutes > cap;

  return (
    <StationShell station={6}>
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}

      <section className="section">
        <div className="row">
          <h2 style={{ margin: 0 }}>{today.date} {today.weekday}</h2>
          <span className="spacer" />
          <span className="badge badge-muted">连续打卡 {today.streak} 天</span>
        </div>
        <p className="muted">勾掉今天做完的任务，写一句真实的复盘。印章要在服务端确认之后才盖。</p>

        {!today.tasks.length && (
          <p className="notice notice-warn"><span className="icon">!</span><span>今天没有安排任务。可以到第5站调整方案，或在这里手动加一条。</span></p>
        )}

        <ul className="check-list">
          {today.tasks.map((t) => (
            <li key={t.id}>
              <label className="check">
                <input type="checkbox" checked={doneIds.includes(t.id)} onChange={() => toggle(t.id)} disabled={!today.can_edit} />
                <span>
                  <strong>{t.title}</strong>{' '}
                  <span className="badge badge-muted">{t.kind}</span>{' '}
                  <span className="muted small">{t.minutes} 分钟</span>
                </span>
              </label>
            </li>
          ))}
        </ul>

        <div className="grid-3" style={{ marginTop: 16 }}>
          <div className="field">
            <label htmlFor="ck-minutes">今天实际投入（分钟）</label>
            <input id="ck-minutes" type="number" min={0} max={1440} step={5} className="input" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
            {cap !== null && <span className="muted small" style={{ color: overCap ? 'var(--c-danger)' : undefined }}>计划上限 {cap} 分钟</span>}
          </div>
          <div className="field">
            <label htmlFor="ck-acc">正确率（选填，%）</label>
            <input id="ck-acc" type="number" min={0} max={100} className="input" value={accuracy} onChange={(e) => setAccuracy(e.target.value)} placeholder="做题时才需要填" />
          </div>
          <div className="field">
            <label htmlFor="ck-mood">今天的状态</label>
            <div className="chips" id="ck-mood" role="radiogroup" aria-label="今天的状态">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" className="chip" role="radio" aria-checked={mood === n} onClick={() => setMood(n)}>{n}</button>
              ))}
            </div>
            <span className="muted small">1 很差 — 5 很好</span>
          </div>
        </div>

        <div className="field">
          <label htmlFor="ck-ref">今天的一句复盘（不少于10字，不能和昨天重复）</label>
          <textarea id="ck-ref" className="textarea" maxLength={300} value={reflection} onChange={(e) => setReflection(e.target.value)} />
          <span className="muted small">{reflection.trim().length} 字{reflection.trim().length < 10 ? '（还不够10字）' : ''}</span>
        </div>

        <div className="row">
          <button type="button" className="btn btn-primary" disabled={busy === 'checkin' || !today.can_edit} onClick={() => void submitCheckin()}>
            {busy === 'checkin' ? '正在提交…' : today.checkin ? '更新今天的打卡' : '完成打卡'}
          </button>
          {stamped && <Stamp label="已打卡" sub={stamped} />}
          {!today.can_edit && <span className="muted small">过去的日期不能修改。</span>}
        </div>
      </section>

      <section className="section">
        <h2>本周复盘</h2>
        <p className="muted">
          本周完成度：<strong>{Math.round(weekly!.current.rate * 100)}%</strong>
          （{weekly!.current.done}/{weekly!.current.all} 个任务）
        </p>
        <ul className="list small">
          {weekly!.current.dates.map((d) => {
            const c = weekly!.current.checkins.find((x) => x.date === d);
            return (
              <li key={d}>
                {d}　{c ? `已打卡 ${c.done_count}/${c.total_count}，${c.minutes}分钟，状态${c.mood}` : <span className="muted">未打卡</span>}
              </li>
            );
          })}
        </ul>
        {menu && !weekly!.current.reviewed && (
          <MenuForm def={menu} submitting={busy === 'weekly'} submitLabel="保存本周复盘" onSubmit={(a) => void submitWeekly(a)} />
        )}
        {weekly!.current.reviewed && (
          <p className="notice notice-ok"><span className="icon">✓</span><span>这一周的复盘已经写过了。想改就到下面的历史记录里重新提交一次。</span></p>
        )}
        {!!weekly!.reviews.length && (
          <>
            <h3>历史复盘</h3>
            <ul className="list">
              {weekly!.reviews.map((r) => (
                <li key={r.id}>
                  <strong>{r.week_start} 起的一周</strong> <span className="muted small">完成度 {Math.round(r.rate * 100)}%</span>
                  <p className="small" style={{ margin: '2px 0' }}>{r.summary}</p>
                  <p className="muted small" style={{ margin: 0 }}>卡点：{r.blockers.join('、')}｜调整：{r.adjust.join('、')}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <p className="muted small">班主任：{me?.name} 的第6站产物是复盘记录，会自动进入结课考核档案袋。</p>
    </StationShell>
  );
}

/** 打卡印章：红色只用于打卡这一处（PRD 11.2） */
function Stamp({ label, sub }: { label: string; sub: string }) {
  return (
    <span className="stamp" role="img" aria-label={sub}>
      <span className="stamp-line">{label}</span>
      <span className="stamp-sub">{sub}</span>
    </span>
  );
}
