// 导师团入口。阶段1提供 1:1 陪伴导师对话（M9 基础版）；导师团会议（M18）在阶段4开放。
import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Me } from '../api/types';
import { useAuth } from '../auth';
import { companions, getAgent, DEFAULT_COMPANION } from '../registry';
import { ChatPanel, type ConvSummary } from '../components/ChatPanel';
import { MentorIcon, MentorLabel } from '../components/MentorBadge';
import { OverlayPanel, useOverlay } from '../overlay/OverlayHost';
import { useToast } from '../components/Toast';

export default function Mentors() {
  const { me, setMe } = useAuth();
  const ov = useOverlay();
  const toast = useToast();
  const [agentKey, setAgentKey] = useState(me?.persona || DEFAULT_COMPANION);
  const [convId, setConvId] = useState<number | null | undefined>(undefined);
  const [chatKey, setChatKey] = useState(0);
  const [list, setList] = useState<ConvSummary[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [savingPersona, setSavingPersona] = useState(false);

  const onListChange = useCallback((l: ConvSummary[], id: number | null) => {
    setList(l);
    setCurrentId(id);
  }, []);

  const choose = async (key: string) => {
    if (savingPersona) return;
    const prev = agentKey;
    setAgentKey(key); // 从下一轮开始使用新导师；正在生成的回复仍用发出时的导师
    setSavingPersona(true);
    try {
      const r = await api<{ me: Me }>('/me', { method: 'PUT', body: { persona: key } });
      setMe(r.me);
      ov.close('mentor-picker');
      toast(`已切换为 ${getAgent(key)?.name}，记忆不会丢失`);
    } catch (e) {
      setAgentKey(prev);
      toast((e as Error).message, 'error');
    } finally {
      setSavingPersona(false);
    }
  };

  const agent = getAgent(agentKey);

  return (
    <div className="chat">
      <div className="chat-head">
        <MentorLabel agent={agent} />
        <span className="spacer" />
        <Link to="/mentors/group" className="btn">开导师团会议</Link>
        <Link to="/mentors/ask" className="btn">问一位导师</Link>
        <button
          type="button"
          className="btn"
          aria-expanded={ov.isOpen('mentor-picker')}
          onClick={(e) => ov.toggle('mentor-picker', e.currentTarget)}
        >
          换导师
        </button>
        <button
          type="button"
          className="btn"
          aria-expanded={ov.isOpen('chat-history')}
          onClick={(e) => ov.toggle('chat-history', e.currentTarget)}
        >
          历史
        </button>
        <button type="button" className="btn btn-text" onClick={() => { setConvId(null); setCurrentId(null); setChatKey((k) => k + 1); }}>
          新对话
        </button>
      </div>

      <ChatPanel key={chatKey} kind="companion" agentKey={agentKey} convId={convId} onListChange={onListChange} />

      <OverlayPanel id="mentor-picker" title="选择陪伴导师">
        <p className="muted small">四位都是 AI 导师，共享同一份记忆。切换后从下一轮对话开始使用新导师的语气。</p>
        <div className="mentor-list">
          {companions.map((c, i) => (
            <button
              key={c.key}
              type="button"
              className="mentor-option"
              aria-pressed={c.key === agentKey}
              disabled={savingPersona}
              data-autofocus={i === 0 ? true : undefined}
              onClick={() => void choose(c.key)}
            >
              <MentorIcon agent={c} size={44} />
              <span>
                <strong>{c.name}｜{c.duty}</strong> <span className="ai-tag">AI导师</span>
                <span className="muted small" style={{ display: 'block' }}>{c.summary}</span>
              </span>
            </button>
          ))}
        </div>
      </OverlayPanel>

      <OverlayPanel id="chat-history" title="历史对话">
        {!list.length ? (
          <p className="muted">暂无记录</p>
        ) : (
          <ul className="list">
            {list.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="btn btn-text"
                  aria-current={c.id === currentId ? 'true' : undefined}
                  onClick={() => { setConvId(c.id); setChatKey((k) => k + 1); ov.close('chat-history'); }}
                >
                  {c.title || '未命名对话'}
                </button>
                <span className="muted small"> {c.created_at.slice(0, 16)}</span>
              </li>
            ))}
          </ul>
        )}
      </OverlayPanel>
    </div>
  );
}
