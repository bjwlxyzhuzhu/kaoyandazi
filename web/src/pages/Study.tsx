// 书房（学生一级入口）：备考空间 + 科研空间，四个工作台的入口
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { FlowResp, KbItemsResp, PapersResp } from '../api/types2';
import { getAgent } from '../registry';
import { MentorIcon } from '../components/MentorBadge';

export default function Study() {
  const [papers, setPapers] = useState(0);
  const [verified, setVerified] = useState(0);
  const [items, setItems] = useState<KbItemsResp['stats'] | null>(null);
  const [flow, setFlow] = useState<FlowResp | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([
      api<PapersResp>('/papers'),
      api<KbItemsResp>('/kb/items'),
      api<FlowResp>('/flow'),
    ]).then(([p, i, f]) => {
      setPapers(p.papers.length);
      setVerified(p.papers.filter((x) => x.verify_status === 'verified').length);
      setItems(i.stats);
      setFlow(f);
    }).catch((e) => setError((e as Error).message));
  }, []);

  const open = flow?.stations.filter((s) => s.open && [7, 8, 9].includes(s.station)) || [];

  return (
    <div className="page">
      <header>
        <h1>书房</h1>
        <p className="muted">我在学什么、研究什么。备考的知识和科研的文献，都放在这里。</p>
      </header>

      {error && <div className="notice notice-error" role="alert"><span className="icon">!</span><span>{error}</span></div>}

      <section className="section">
        <h2>我的书房</h2>
        <div className="stat-row">
          <div className="stat"><span className="num">{papers}</span><span className="lbl">文献（已核验 {verified}）</span></div>
          <div className="stat"><span className="num">{items?.prep ?? '—'}</span><span className="lbl">备考条目</span></div>
          <div className="stat"><span className="num">{items?.research ?? '—'}</span><span className="lbl">科研条目</span></div>
          <div className="stat"><span className="num">{items?.mistakes ?? '—'}</span><span className="lbl">错题</span></div>
        </div>
      </section>

      <section className="section">
        <h2>三个工作台</h2>
        <p className="muted small">对应主线的第7、8、9站。没有完成前面的站也能进来，但建议按顺序走。</p>
        <ul className="desk-list">
          {open.map((s) => {
            const mentor = getAgent(s.station === 7 ? 'method' : s.station === 8 ? 'research_search' : 'achievement');
            return (
              <li key={s.station}>
                <Link to={s.route} className="desk-card">
                  <span className="dot" aria-hidden="true">{s.station}</span>
                  <span className="desk-body">
                    <strong>{s.name}</strong>
                    <span className="muted small">{s.full}</span>
                    <span className="muted small">产物：{s.product}</span>
                  </span>
                  {mentor && (
                    <span className="muted small desk-mentor">
                      <MentorIcon agent={mentor} size={20} />
                      {mentor.name}
                    </span>
                  )}
                  <span className="arrow" aria-hidden="true">→</span>
                </Link>
              </li>
            );
          })}
        </ul>
        {!open.length && <p className="muted">还在前面的站点。走完当前站的当前一步后，这里会开放。</p>}
      </section>

      <section className="section">
        <h2>这一站不做的事</h2>
        <p style={{ margin: 0 }}>
          书房<strong>不做</strong>论文写作、续写、润色、改写、翻译成稿、排版、查重降重和投稿推荐。
          遇到这类请求，导师会礼貌说明并把话题引回阅读和思考。
          科研这条路真正有价值的部分——检索、读懂、理清、提出好问题——平台会陪你走完。
        </p>
      </section>
    </div>
  );
}
