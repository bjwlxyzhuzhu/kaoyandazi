// 通用对话面板：流式正文 + 结构化选项（PRD 4.1、4.2、4.4）
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, streamPost } from '../api/client';
import type { ChatMessage } from '../api/types';
import { getAgent, displayName } from '../registry';
import { Markdown, visibleStreamText } from './Markdown';
import { OptionsBar } from './OptionsBar';
import { MentorIcon } from './MentorBadge';
import { FeedbackBar, SourceTags, type SourceRef } from './Feedback';

export interface ConvSummary { id: number; title: string; created_at: string }

interface ConvResponse {
  conversation: { id: number; title: string } | null;
  messages: ChatMessage[];
  pending: boolean;
  list: ConvSummary[];
  mock: boolean;
}

interface Props {
  kind: string;
  /** 当前导师（下一次发送时冻结使用） */
  agentKey: string;
  /** 要打开的对话 id；undefined 表示最近一次对话，null 表示新对话 */
  convId: number | null | undefined;
  onListChange?: (list: ConvSummary[], currentId: number | null) => void;
}

interface Streaming { text: string; agentKey: string }

export function ChatPanel({ kind, agentKey, convId, onListChange }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [mock, setMock] = useState(false);
  const [streaming, setStreaming] = useState<Streaming | null>(null);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const sendingRef = useRef(false);
  const endRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async (id: number | null | undefined) => {
    if (id === null) {
      setMessages([]); setCurrentId(null); setPending(false); setLoading(false);
      return;
    }
    const q = id ? `?id=${id}` : '';
    const r = await api<ConvResponse>(`/conv/${kind}${q}`);
    if (!alive.current) return;
    setMessages(r.messages);
    setCurrentId(r.conversation?.id ?? null);
    setPending(r.pending);
    setMock(r.mock);
    setLoading(false);
    onListChange?.(r.list, r.conversation?.id ?? null);
  }, [kind, onListChange]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    load(convId).catch((e) => { setError(e as ApiError); setLoading(false); });
  }, [convId, load]);

  // 离开页面时回复仍在生成：回来后轮询同一请求的结果
  useEffect(() => {
    if (!pending || sending) return;
    const t = window.setInterval(() => { void load(currentId); }, 1500);
    return () => window.clearInterval(t);
  }, [pending, sending, currentId, load]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages.length, streaming?.text]);

  const send = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setError(null);
    const tempId = -Date.now();
    let userMsgId = tempId;
    setMessages((xs) => [...xs, { id: tempId, role: 'user', content: t, options: null, agent_key: null, created_at: '' }]);
    setDraft('');
    setStreaming({ text: '', agentKey });

    // 失败时撤回本轮消息，把原文放回输入框（后端同样已撤回）
    const restore = (err: ApiError, text = t) => {
      setMessages((xs) => xs.filter((m) => m.id !== userMsgId));
      setDraft(text);
      setError(err);
    };

    try {
      let convAfter = currentId;
      await streamPost(`/conv/${kind}/send`, { conv_id: currentId, text: t, agent_key: agentKey }, {
        onEvent: (event, data) => {
          if (event === 'meta') {
            convAfter = data.conv_id;
            setCurrentId(data.conv_id);
            setMock(!!data.mock);
            userMsgId = data.user_message_id;
            setMessages((xs) => xs.map((m) => (m.id === tempId ? { ...m, id: userMsgId } : m)));
          } else if (event === 'delta') {
            setStreaming((s) => (s ? { ...s, text: s.text + data.text } : s));
          } else if (event === 'done') {
            setMessages((xs) => [...xs, data.message as ChatMessage]);
          } else if (event === 'error') {
            restore(new ApiError(0, data.code, data.message), data.restore_text || t);
          }
        },
      }, { withKey: true });
      if (alive.current && convAfter) {
        // 刷新历史列表（标题）
        api<ConvResponse>(`/conv/${kind}?id=${convAfter}`).then((r) => onListChange?.(r.list, convAfter)).catch(() => {});
      }
    } catch (e) {
      restore(e instanceof ApiError ? e : new ApiError(0, 'NETWORK', '网络连接失败，请检查网络后重试。'));
    } finally {
      sendingRef.current = false;
      if (alive.current) {
        setSending(false);
        setStreaming(null);
      }
    }
  }, [agentKey, currentId, kind, onListChange]);

  const lastAi = [...messages].reverse().find((m) => m.role === 'assistant');
  const lastIsAi = messages.length > 0 && messages[messages.length - 1].role === 'assistant';
  const block = lastIsAi ? lastAi?.options ?? null : null;
  const showFree = !block || block.free_text;
  const busy = sending || pending;

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(draft);
    }
  };

  return (
    <div className="msgs-wrap">
      {mock && (
        <div className="notice notice-warn" style={{ marginBottom: 16 }}>
          <span className="icon">!</span>
          <span>当前是<strong>模拟模型</strong>：回复由程序生成，用于检查流程，不是真实 AI 的回答。老师配置真实接口后自动切换。</span>
        </div>
      )}

      <div className="msgs" aria-live="polite" aria-busy={busy}>
        {loading && <p className="muted">正在载入对话…</p>}
        {!loading && !messages.length && !streaming && (
          <p className="muted">还没有聊过。可以直接说说今天的情况，或者问问导师任何关于学习规划的问题。</p>
        )}
        {messages.map((m) => (m.role === 'user' ? (
          <div key={m.id} className="msg msg-user">{m.content}</div>
        ) : (
          <AiMessage key={m.id} id={m.id} agentKey={m.agent_key} content={m.content} sources={(m.options as { sources?: SourceRef[] } | null)?.sources} />
        )))}
        {streaming && (
          <div className="msg msg-ai">
            <AiMeta agentKey={streaming.agentKey} />
            {streaming.text ? <Markdown text={visibleStreamText(streaming.text)} /> : <p className="stream-status">正在思考…</p>}
            <p className="stream-status" role="status">正在生成…</p>
          </div>
        )}
        {pending && !streaming && <p className="stream-status" role="status">上一条回复还在生成中，稍等会自动显示…</p>}
        <div ref={endRef} />
      </div>

      <div className="composer">
        {error && (
          <div className="notice notice-error" role="alert" style={{ marginBottom: 12 }}>
            <span className="icon">!</span>
            <span>
              {error.message}
              {(error.code === 'NEED_USER_KEY' || error.code === 'QUOTA_DAILY' || error.code === 'QUOTA_MONTHLY' || error.code.startsWith('USER_')) && (
                <> <Link to="/me/keys">去设置</Link></>
              )}
            </span>
          </div>
        )}
        {block && !busy && (
          <OptionsBar key={lastAi?.id} block={block} disabled={busy} onChoose={(t) => void send(t)} />
        )}
        {showFree && (
          <div className="composer-row" style={{ marginTop: block ? 12 : 0 }}>
            <label htmlFor="chat-input" className="sr-only">{block ? '都不是，我自己说' : '输入你想说的话'}</label>
            <textarea
              id="chat-input"
              className="textarea"
              rows={1}
              placeholder={block ? '都不是，我自己说……' : '输入你想说的话（Enter 发送，Shift+Enter 换行）'}
              value={draft}
              maxLength={2000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
            />
            <button type="button" className="btn btn-primary" disabled={busy || !draft.trim()} onClick={() => void send(draft)}>
              {sending ? '发送中' : '发送'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function AiMeta({ agentKey }: { agentKey: string | null }) {
  const agent = getAgent(agentKey);
  return (
    <div className="msg-meta">
      <MentorIcon agent={agent} size={22} />
      <span>{displayName(agent)}</span>
      <span className="ai-tag">AI生成</span>
    </div>
  );
}

function AiMessage({ id, agentKey, content, sources }: { id: number; agentKey: string | null; content: string; sources?: SourceRef[] | null }) {
  return (
    <div className="msg msg-ai">
      <AiMeta agentKey={agentKey} />
      <Markdown text={content} />
      <SourceTags sources={sources} />
      {agentKey && id > 0 && <FeedbackBar mentorKey={agentKey} messageRef={`msg:${id}`} />}
    </div>
  );
}
