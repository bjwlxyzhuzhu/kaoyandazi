// 第2站 认识自己：菜单题 → 苏格拉底追问 → 生成画像 → 逐字段确认（M4）
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { MenuDef, ProfileData, ProfileResp } from '../api/types2';
import { MenuForm } from '../components/MenuForm';
import { ChatPanel } from '../components/ChatPanel';
import { StationShell } from './Road';
import { useToast } from '../components/Toast';

type Phase = 'menu' | 'talk' | 'profile';

export default function Station2() {
  const toast = useToast();
  const [menu, setMenu] = useState<MenuDef | null>(null);
  const [prof, setProf] = useState<ProfileResp | null>(null);
  const [phase, setPhase] = useState<Phase>('menu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<ProfileData | null>(null);
  const [chatKey, setChatKey] = useState(0);

  const load = useCallback(async () => {
    const [m, p] = await Promise.all([api<MenuDef>('/menus/intake'), api<ProfileResp>('/profile')]);
    setMenu(m); setProf(p);
    if (p.profile) { setDraft(p.profile); setPhase('profile'); }
    else if (p.has_menu) setPhase('talk');
    else setPhase('menu');
  }, []);

  useEffect(() => { load().catch((e) => setError((e as Error).message)); }, [load]);

  const saveMenu = async (answers: Record<string, unknown>) => {
    setBusy(true); setError('');
    try {
      await api('/menus/intake', { body: { answers } });
      await load();
      setPhase('talk');
      toast('菜单题已保存，接下来和启微聊一聊');
    } catch (e) { setError(e instanceof ApiError ? e.message : '保存失败，请重试。'); } finally { setBusy(false); }
  };

  const generate = async () => {
    setBusy(true); setError('');
    try {
      const r = await api<{ profile: ProfileData }>('/profile/generate', { body: {}, withKey: true });
      setDraft(r.profile);
      setPhase('profile');
      toast('画像已经生成，请逐条检查并修改');
    } catch (e) { setError(e instanceof ApiError ? e.message : '生成失败，请重试。'); } finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!draft) return;
    setBusy(true); setError('');
    try {
      await api('/profile', { method: 'PUT', body: { profile: draft } });
      toast('画像已确认，进入第3站');
      await load();
    } catch (e) { setError(e instanceof ApiError ? e.message : '保存失败，请重试。'); } finally { setBusy(false); }
  };

  const setField = <K extends keyof ProfileData>(k: K, v: ProfileData[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  return (
    <StationShell station={2}>
      {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}

      {phase === 'menu' && menu && (
        <section className="section">
          <h2>先填8道菜单题</h2>
          <p className="muted">全部点选，不用打字，也不会调用 AI。</p>
          <MenuForm def={menu} submitting={busy} submitLabel="保存并开始访谈" onSubmit={(a) => void saveMenu(a)} />
        </section>
      )}

      {phase === 'talk' && (
        <>
          <section className="section">
            <div className="row">
              <h2 style={{ margin: 0 }}>和启微聊一聊</h2>
              <span className="spacer" />
              <button type="button" className="btn btn-text" onClick={() => setPhase('menu')}>改菜单答案</button>
            </div>
            <p className="muted">每轮都会给你2—5个选项，点选即可；想补充就写在输入框里。聊到信息差不多时，会出现“可以生成画像了”。</p>
          </section>
          <section className="section" style={{ background: 'transparent', border: 0, padding: 0 }}>
            <ChatPanel key={chatKey} kind="intake" agentKey="intake" convId={undefined} />
          </section>
          <section className="section">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void generate()}>
              {busy ? '正在生成…' : '生成我的画像'} <span className="arrow">→</span>
            </button>
            <button type="button" className="btn btn-text" style={{ marginLeft: 8 }} onClick={() => { setChatKey((k) => k + 1); }}>继续聊</button>
            <p className="muted small" style={{ marginTop: 8 }}>觉得聊得差不多了就可以生成；生成后还能改任何字段。</p>
          </section>
        </>
      )}

      {phase === 'profile' && draft && (
        <>
          <section className="section">
            <h2>这是我的画像，请逐条检查</h2>
            <p className="muted">AI 起草，你修改，最后由你确认。任何一条你觉得不对，都可以直接改。</p>

            <div className="field">
              <label htmlFor="p-summary">一句话概括现在的我</label>
              <textarea id="p-summary" className="textarea" value={draft.summary} onChange={(e) => setField('summary', e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="p-motivation">我做这件事的动机</label>
              <input id="p-motivation" className="input" value={draft.motivation} onChange={(e) => setField('motivation', e.target.value)} />
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="p-strengths">我的优势（每行一条）</label>
                <textarea id="p-strengths" className="textarea" value={draft.strengths.join('\n')} onChange={(e) => setField('strengths', e.target.value.split('\n').filter(Boolean))} />
              </div>
              <div className="field">
                <label htmlFor="p-gaps">我的短板（每行一条）</label>
                <textarea id="p-gaps" className="textarea" value={draft.gaps.join('\n')} onChange={(e) => setField('gaps', e.target.value.split('\n').filter(Boolean))} />
              </div>
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="p-hours">每周可投入时间（小时）</label>
                <input id="p-hours" type="number" min={0} max={60} className="input" value={draft.weekly_hours} onChange={(e) => setField('weekly_hours', Number(e.target.value))} />
              </div>
              <div className="field">
                <label htmlFor="p-career">职业目标</label>
                <input id="p-career" className="input" value={draft.career_goal} onChange={(e) => setField('career_goal', e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label htmlFor="p-unknowns">还没想清楚的问题（每行一条）</label>
              <textarea id="p-unknowns" className="textarea" value={draft.unknowns.join('\n')} onChange={(e) => setField('unknowns', e.target.value.split('\n').filter(Boolean))} />
            </div>
          </section>

          <section className="section">
            <h3>为你准备的几条路</h3>
            <p className="muted small">至少有一条不是考研。路径的选择在第3站进行。</p>
            {draft.paths.map((p) => (
              <article key={p.id} className="section" style={{ background: '#fff' }}>
                <h3 style={{ marginTop: 0 }}>{p.name}</h3>
                <p><strong>适合的理由：</strong>{p.fit}</p>
                <p><strong>代价与风险：</strong>{p.cost}</p>
                <p><strong>关键节点：</strong>{p.milestones.join(' → ')}</p>
                <p><strong>成果铺垫建议：</strong>{p.achievements.join('、') || '暂无'}</p>
                <p><strong>AI能帮什么：</strong>{p.ai_leverage}</p>
                <p style={{ margin: 0 }}><strong>本周第一步：</strong>{p.first_step}</p>
              </article>
            ))}
          </section>

          <section className="section">
            <div className="row">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirm()}>
                {busy ? '正在保存…' : '确认这份画像'} <span className="arrow">→</span>
              </button>
              <button type="button" className="btn" onClick={() => setPhase('talk')}>还想再聊聊</button>
              <button type="button" className="btn btn-text" onClick={() => void generate()}>重新生成</button>
            </div>
            {prof?.updated_at && <p className="muted small">上次确认：{prof.updated_at.slice(0, 16)}</p>}
          </section>
        </>
      )}
    </StationShell>
  );
}
