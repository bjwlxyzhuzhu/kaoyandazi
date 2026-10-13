// 导师团 · 问一位导师（1:1）：政策、经验、学法、方向、择校、计划……
// 回答可以引用导师工坊里教师发布的资料，并显示来源；每条回复都可以反馈
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { ChatPanel, type ConvSummary } from '../components/ChatPanel';
import { MentorIcon } from '../components/MentorBadge';
import { getAgent, displayName } from '../registry';

interface MentorCard { key: string; name: string; duty: string; summary: string; learning: { note: string } | null }

export default function Ask() {
  const [list, setList] = useState<MentorCard[]>([]);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [agentKey, setAgentKey] = useState('policy');
  const [convId, setConvId] = useState<number | null | undefined>(undefined);
  const [chatKey, setChatKey] = useState(0);
  const [note, setNote] = useState('');
  const [history, setHistory] = useState<ConvSummary[]>([]);

  useEffect(() => {
    api<{ agents: MentorCard[]; training_note: string; ask_agents?: string[] }>('/mentors').then((r) => {
      setList(r.agents); setNote(r.training_note); setAllowed(r.ask_agents || []);
    }).catch(() => {});
  }, []);

  const cards = list.filter((a) => allowed.includes(a.key));
  const cur = cards.find((a) => a.key === agentKey);

  return (
    <div className="page">
      <p className="muted small"><Link to="/mentors">← 导师团</Link></p>
      <h1>问一位导师</h1>
      <p className="muted">政策条文找明章，上岸经验找渡舟，学习方法找习法……每位导师只回答自己职责内的问题。{note}</p>
      <div className="mentor-pick">
        {cards.map((a) => (
          <button key={a.key} type="button" className="mentor-option" aria-pressed={a.key === agentKey}
            onClick={() => { setAgentKey(a.key); setConvId(undefined); setChatKey((k) => k + 1); }}>
            <MentorIcon agent={getAgent(a.key)} size={28} />
            <span><strong>{a.name}｜{a.duty}</strong><span className="muted small" style={{ display: 'block' }}>{a.summary}</span></span>
          </button>
        ))}
      </div>
      {cur?.learning && <p className="muted small" style={{ marginTop: 12 }}>{displayName(getAgent(cur.key))}：{cur.learning.note}</p>}
      <div className="row">
        {!!history.length && (
          <select className="select" style={{ width: 'auto' }} aria-label="历史对话" value={convId ?? history[0]?.id ?? ''}
            onChange={(e) => { setConvId(Number(e.target.value)); setChatKey((k) => k + 1); }}>
            {history.map((h) => <option key={h.id} value={h.id}>{h.title}</option>)}
          </select>
        )}
        <button type="button" className="btn btn-text" onClick={() => { setConvId(null); setChatKey((k) => k + 1); }}>新对话</button>
      </div>
      <ChatPanel key={`${agentKey}-${chatKey}`} kind="ask" agentKey={agentKey} convId={convId} onListChange={(l) => setHistory(l)} />
    </div>
  );
}
