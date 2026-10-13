// 我 · API 实验室（M15，第六章课堂任务）：模型列表、对话实验、双模型对比、代码面板、我的小智能体、看懂平台本身
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, streamPost, userKeyStore } from '../api/client';
import type { LabAgent, LabAnatomy } from '../api/types2';
import { useToast } from '../components/Toast';
import { Markdown } from '../components/Markdown';

interface Out { model: string; text: string; ms?: number; error?: string; tokens?: number }

export default function LabPage() {
  const toast = useToast();
  const [tab, setTab] = useState<'chat' | 'agents' | 'anatomy'>('chat');
  const [models, setModels] = useState<string[]>([]);
  const [baseUrl, setBaseUrl] = useState('');
  const [tempKey, setTempKey] = useState('');
  const [model, setModel] = useState('');
  const [model2, setModel2] = useState('');
  const [compare, setCompare] = useState(false);
  const [system, setSystem] = useState('你是一位耐心的助教，用中文回答，尽量简短。');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(600);
  const [text, setText] = useState('');
  const [outs, setOuts] = useState<Out[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [agents, setAgents] = useState<LabAgent[]>([]);
  const [agentName, setAgentName] = useState('');
  const [anatomy, setAnatomy] = useState<LabAnatomy | null>(null);

  const loadModels = useCallback(async () => {
    setError(null);
    try {
      const r = await api<{ models: string[]; base_url: string; default_model: string }>('/lab/models', { body: tempKey ? { temp_key: tempKey } : {}, withKey: !tempKey });
      setModels(r.models); setBaseUrl(r.base_url);
      setModel((m) => m || r.default_model || r.models[0] || '');
      setModel2((m) => m || r.models.find((x) => x !== r.default_model) || r.models[0] || '');
    } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', '网络连接失败。')); }
  }, [tempKey]);

  const loadAgents = useCallback(async () => setAgents((await api<{ agents: LabAgent[] }>('/lab/agents')).agents), []);
  useEffect(() => { void loadModels(); void loadAgents(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'anatomy' && !anatomy) api<LabAnatomy>('/lab/anatomy').then(setAnatomy).catch(() => {}); }, [tab, anatomy]);

  const run = async () => {
    if (!text.trim()) return;
    const list = compare ? [model, model2] : [model];
    setRunning(true); setError(null);
    setOuts(list.map((m) => ({ model: m, text: '' })));
    try {
      await streamPost('/lab/chat', { text, system, temperature, max_tokens: maxTokens, models: list, ...(tempKey ? { temp_key: tempKey } : {}) }, {
        onEvent: (ev, d) => {
          if (ev === 'delta') setOuts((xs) => xs.map((o) => (o.model === d.model ? { ...o, text: o.text + d.text } : o)));
          else if (ev === 'model_end') setOuts((xs) => xs.map((o) => (o.model === d.model ? { ...o, ms: d.ms, error: d.error, tokens: d.usage?.completion_tokens } : o)));
        },
      }, { withKey: !tempKey });
    } catch (e) { setError(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', '网络连接失败。')); } finally { setRunning(false); }
  };

  const saveAgent = async () => {
    try {
      await api('/lab/agents', { body: { name: agentName, system, model, temperature, max_tokens: maxTokens } });
      toast('已保存为我的小智能体'); setAgentName('');
      await loadAgents();
    } catch (e) { toast(e instanceof ApiError ? e.message : '保存失败', 'error'); }
  };

  const code = useMemo(() => codeSnippets({ baseUrl, model, system, temperature, maxTokens, text: text || '你好' }), [baseUrl, model, system, temperature, maxTokens, text]);
  const [codeTab, setCodeTab] = useState<'curl' | 'python' | 'js'>('curl');
  const hasKey = !!(tempKey || userKeyStore.get());

  return (
    <div className="page">
      <p className="muted small"><Link to="/me">← 我</Link></p>
      <h1>API 实验室</h1>
      <p className="muted">第六章课堂任务：亲手调一次大模型接口，看看“温度”“系统提示词”到底改变了什么，最后保存一个属于你自己的小智能体。</p>

      {!hasKey && (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          <span className="icon">!</span>
          <span>实验室用的是你自己的 Key。先去 <Link to="/me/keys">模型与 API Key</Link> 填一次，或者在下面临时填一把（只用于本次请求，不保存）。</span>
        </div>
      )}
      {error && (
        <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span>
          <span>{error.message}{(error.code === 'NEED_USER_KEY' || error.code.startsWith('USER_')) && <> <Link to="/me/keys">去设置</Link></>}</span>
        </div>
      )}

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>对话实验</button>
        <button type="button" role="tab" aria-selected={tab === 'agents'} className={tab === 'agents' ? 'active' : ''} onClick={() => setTab('agents')}>我的小智能体（{agents.length}）</button>
        <button type="button" role="tab" aria-selected={tab === 'anatomy'} className={tab === 'anatomy' ? 'active' : ''} onClick={() => setTab('anatomy')}>看懂平台本身</button>
      </div>

      {tab === 'chat' && (
        <div className="lab-grid">
          <section className="section">
            <h2>参数</h2>
            <div className="field">
              <label htmlFor="lab-temp-key">临时 Key（选填，不保存）</label>
              <input id="lab-temp-key" className="input" type="password" autoComplete="off" value={tempKey} onChange={(e) => setTempKey(e.target.value.trim())} placeholder="sk-…" />
            </div>
            <div className="row">
              <button type="button" className="btn btn-sm" onClick={() => void loadModels()}>拉取模型列表</button>
              <span className="muted small">{models.length ? `共 ${models.length} 个模型` : '还没拉取'}</span>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <label htmlFor="lab-model">模型</label>
              <select id="lab-model" className="select" value={model} onChange={(e) => setModel(e.target.value)}>
                {models.map((m) => <option key={m}>{m}</option>)}
              </select>
            </div>
            <label className="check"><input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /><span>双模型对比（同一个问题发给两个模型）</span></label>
            {compare && (
              <div className="field">
                <label htmlFor="lab-model2">对比模型</label>
                <select id="lab-model2" className="select" value={model2} onChange={(e) => setModel2(e.target.value)}>
                  {models.map((m) => <option key={m}>{m}</option>)}
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="lab-system">系统提示词</label>
              <textarea id="lab-system" className="textarea" maxLength={4000} value={system} onChange={(e) => setSystem(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="lab-tempr">温度：{temperature.toFixed(1)}（越低越稳定，越高越发散）</label>
              <input id="lab-tempr" type="range" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} />
            </div>
            <div className="field">
              <label htmlFor="lab-max">最大长度（tokens）</label>
              <input id="lab-max" type="number" className="input" min={16} max={4000} step={50} value={maxTokens} onChange={(e) => setMaxTokens(Number(e.target.value))} />
            </div>
            <div className="row">
              <input className="input" style={{ flex: 1 }} maxLength={40} value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="给这组设置起个名字" aria-label="小智能体名称" />
              <button type="button" className="btn btn-sm" disabled={!agentName.trim()} onClick={() => void saveAgent()}>保存为小智能体</button>
            </div>
          </section>

          <section className="section">
            <h2>对话</h2>
            <div className="field">
              <label htmlFor="lab-text">发给模型的内容</label>
              <textarea id="lab-text" className="textarea" maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} placeholder="例如：用一句话解释什么是边际效用" />
            </div>
            <button type="button" className="btn btn-primary" disabled={running || !text.trim() || !model} onClick={() => void run()}>{running ? '正在生成…' : compare ? '同时发给两个模型' : '发送'}</button>
            <div className={compare ? 'lab-compare' : ''} style={{ marginTop: 16 }}>
              {outs.map((o) => (
                <div key={o.model} className="msg msg-ai">
                  <div className="msg-meta"><strong>{o.model}</strong><span className="ai-tag">AI生成</span>
                    {o.ms !== undefined && <span className="muted small">{(o.ms / 1000).toFixed(1)} 秒{o.tokens ? ` · 约 ${o.tokens} tokens` : ''}</span>}
                  </div>
                  {o.error ? <p className="notice notice-warn"><span className="icon">!</span><span>{o.error}</span></p> : o.text ? <Markdown text={o.text} /> : <p className="stream-status">等待中…</p>}
                </div>
              ))}
            </div>

            <h3 style={{ marginTop: 24 }}>代码面板</h3>
            <p className="muted small">按当前参数生成的等价代码。Key 显示为 sk-****，复制后换成你自己的。</p>
            <div className="chips">
              {(['curl', 'python', 'js'] as const).map((k) => (
                <button key={k} type="button" className="chip" aria-pressed={codeTab === k} onClick={() => setCodeTab(k)}>{k === 'js' ? 'JavaScript' : k === 'python' ? 'Python' : 'curl'}</button>
              ))}
            </div>
            <pre className="code-block">{code[codeTab]}</pre>
            <button type="button" className="btn btn-text btn-sm" onClick={() => { void navigator.clipboard?.writeText(code[codeTab]); toast('已复制'); }}>复制代码</button>
          </section>
        </div>
      )}

      {tab === 'agents' && (
        <section className="section">
          <h2>我的小智能体</h2>
          <p className="muted small">“系统提示词 + 模型 + 参数”就是一个最简单的智能体。点“载入”回到对话实验里继续调。</p>
          {!agents.length && <p className="muted">还没有保存过。在“对话实验”里调好参数，起个名字保存就行。</p>}
          <ul className="list">
            {agents.map((a) => (
              <li key={a.id}>
                <div className="row">
                  <strong>{a.name}</strong>
                  <span className="badge badge-muted">{a.model}</span>
                  <span className="muted small">温度 {a.temperature} · 最长 {a.max_tokens}</span>
                  <span className="spacer" />
                  <button type="button" className="btn btn-sm" onClick={() => { setSystem(a.system_prompt); setModel(a.model); setTemperature(a.temperature); setMaxTokens(a.max_tokens); setTab('chat'); toast(`已载入“${a.name}”`); }}>载入</button>
                  <button type="button" className="btn btn-text btn-sm" onClick={async () => { if (!window.confirm(`删除“${a.name}”？`)) return; await api(`/lab/agents/${a.id}`, { method: 'DELETE' }); await loadAgents(); }}>删除</button>
                </div>
                <p className="small muted" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{a.system_prompt.slice(0, 200)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'anatomy' && (
        <section className="section">
          {!anatomy ? <p className="muted">正在载入…</p> : (
            <>
              <h2>{anatomy.formula}</h2>
              <ul className="list">{anatomy.parts.map((p) => <li key={p.name}><strong>{p.name}：</strong>{p.text}</li>)}</ul>
              <h3>检索导师“寻源”的系统提示词（简化版）</h3>
              <pre className="code-block">{anatomy.system_prompt}</pre>
              <h3>一次工具调用</h3>
              <p className="muted small">{anatomy.tool_call_example.note}</p>
              <p className="small"><strong>请求</strong></p>
              <pre className="code-block">{JSON.stringify(anatomy.tool_call_example.request, null, 2)}</pre>
              <p className="small"><strong>响应</strong></p>
              <pre className="code-block">{JSON.stringify(anatomy.tool_call_example.response, null, 2)}</pre>
              <p>{anatomy.tool_call_example.then}</p>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function codeSnippets({ baseUrl, model, system, temperature, maxTokens, text }: { baseUrl: string; model: string; system: string; temperature: number; maxTokens: number; text: string }) {
  const url = baseUrl && baseUrl !== 'mock' ? baseUrl : 'https://你的接口地址/v1';
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: text }];
  const body = { model, messages, temperature, max_tokens: maxTokens };
  const json = JSON.stringify(body, null, 2);
  const sq = json.replace(/'/g, "'\\''");
  const py = `from openai import OpenAI

client = OpenAI(base_url="${url}", api_key="sk-****")

resp = client.chat.completions.create(
    model=${JSON.stringify(model)},
    messages=${JSON.stringify(messages, null, 4).replace(/\n/g, '\n    ')},
    temperature=${temperature},
    max_tokens=${maxTokens},
)
print(resp.choices[0].message.content)`;
  const js = `const res = await fetch("${url}/chat/completions", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer sk-****" },
  body: JSON.stringify(${json.replace(/\n/g, '\n  ')}),
});
const data = await res.json();
console.log(data.choices[0].message.content);`;
  return {
    curl: `curl ${url}/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -H "Authorization: Bearer sk-****" \\\n  -d '${sq}'`,
    python: py,
    js,
  };
}
