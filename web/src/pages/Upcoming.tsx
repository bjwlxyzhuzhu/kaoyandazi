// 尚未开发的一级入口：只说明将在哪个阶段开放，不展示半成品（PRD 第17章）
export default function Upcoming({ title, question, stage }: { title: string; question: string; stage: string }) {
  return (
    <div className="page-narrow">
      <h1>{title}</h1>
      <p className="muted">{question}</p>
      <section className="section">
        <p style={{ margin: 0 }}>这一部分将在{stage}开放。</p>
      </section>
    </div>
  );
}
