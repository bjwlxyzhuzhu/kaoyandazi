// 成效看板的图表：纯 SVG，单系列用品牌色一个色相；前/中/后测是有顺序的系列，用同一色相由浅到深。
// 每张图都有：数值标签、悬停提示、表格视图、下载 PNG（导出给赛事材料用）。
import { useRef, useState, type ReactNode } from 'react';

const C = { bar: '#2f6f62', grid: '#dadfd8', ink: '#1c2430', muted: '#59665f', seq: ['#9cc4b3', '#4f8e7d', '#255a4f'] };

/** 把 SVG 画到 canvas 再下载 PNG（2 倍清晰度） */
function downloadPng(svg: SVGSVGElement | null, name: string) {
  if (!svg) return;
  const xml = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  const w = svg.viewBox.baseVal.width;
  const h = svg.viewBox.baseVal.height;
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = w * 2; canvas.height = h * 2;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, w, h);
    const a = document.createElement('a');
    a.download = `${name}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}

function Frame({ title, note, svgRef, table, children }: { title: string; note?: string; svgRef: React.RefObject<SVGSVGElement | null>; table: ReactNode; children: ReactNode }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className="chart">
      <figcaption className="row">
        <strong>{title}</strong>
        <span className="spacer" />
        <button type="button" className="btn btn-text btn-sm" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>{showTable ? '看图' : '看表格'}</button>
        <button type="button" className="btn btn-text btn-sm" onClick={() => downloadPng(svgRef.current, title)}>下载 PNG</button>
      </figcaption>
      {note && <p className="muted small" style={{ margin: '0 0 8px' }}>{note}</p>}
      {showTable ? table : children}
    </figure>
  );
}

function Tip({ tip }: { tip: { x: number; y: number; text: string } | null }) {
  if (!tip) return null;
  return <div className="chart-tip" style={{ left: tip.x, top: tip.y }} role="status">{tip.text}</div>;
}

/** 横向条形图：每一项一行，适合站点漏斗、分布 */
export function BarList({ title, note, items, unit = '', max }: { title: string; note?: string; items: { label: string; value: number | null; hint?: string }[]; unit?: string; max?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const W = 640; const row = 26; const left = 150; const right = 56;
  const H = items.length * row + 12;
  const top = max ?? Math.max(1, ...items.map((i) => i.value ?? 0));
  const table = (
    <table className="score-table small"><thead><tr><th>项目</th><th>数值</th></tr></thead>
      <tbody>{items.map((i) => <tr key={i.label}><td>{i.label}</td><td className="num">{i.value ?? '暂无数据'}{i.value !== null ? unit : ''}</td></tr>)}</tbody></table>
  );
  return (
    <Frame title={title} note={note} svgRef={ref} table={table}>
      <div className="chart-wrap" onMouseLeave={() => setTip(null)}>
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg" style={{ fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif' }}>
          <line x1={left} x2={left} y1={4} y2={H - 6} stroke={C.grid} />
          {items.map((it, i) => {
            const y = 6 + i * row;
            const w = it.value ? Math.max(2, ((W - left - right) * it.value) / top) : 0;
            return (
              <g key={it.label}
                onMouseMove={(e) => { const b = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); setTip({ x: e.clientX - b.left + 12, y: e.clientY - b.top - 28, text: `${it.label}：${it.value ?? '暂无数据'}${it.value !== null ? unit : ''}${it.hint ? `（${it.hint}）` : ''}` }); }}>
                <rect x={0} y={y - 2} width={W} height={row} fill="transparent" />
                <text x={left - 8} y={y + 14} textAnchor="end" fontSize="12" fill={C.muted}>{it.label}</text>
                {w > 0 && <rect x={left} y={y + 3} width={w} height={14} rx={4} fill={C.bar} />}
                <text x={left + w + 6} y={y + 14} fontSize="12" fill={C.ink}>{it.value ?? '—'}{it.value !== null ? unit : ''}</text>
              </g>
            );
          })}
        </svg>
        <Tip tip={tip} />
      </div>
    </Frame>
  );
}

/** 折线：单一系列随时间变化，悬停显示十字线与当天数值 */
export function TrendLine({ title, note, points, unit = '' }: { title: string; note?: string; points: { label: string; value: number | null }[]; unit?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 640; const H = 220; const L = 40; const R = 16; const T = 16; const B = 30;
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  const top = Math.max(100, ...vals);
  const x = (i: number) => L + ((W - L - R) * i) / Math.max(1, points.length - 1);
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const segs: string[] = [];
  let cur = '';
  points.forEach((p, i) => { if (p.value === null) { if (cur) segs.push(cur); cur = ''; } else cur += `${cur ? 'L' : 'M'}${x(i)},${y(p.value)}`; });
  if (cur) segs.push(cur);
  const table = (
    <table className="score-table small"><thead><tr><th>日期</th><th>数值</th></tr></thead>
      <tbody>{points.map((p) => <tr key={p.label}><td>{p.label}</td><td className="num">{p.value ?? '暂无数据'}{p.value !== null ? unit : ''}</td></tr>)}</tbody></table>
  );
  const last = [...points].reverse().find((p) => p.value !== null);
  return (
    <Frame title={title} note={note} svgRef={ref} table={table}>
      <div className="chart-wrap">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg" style={{ fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif' }}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => { const b = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - b.left) / b.width) * W; setHover(Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - R)) * (points.length - 1))))); }}>
          {[0, 50, 100].map((g) => <g key={g}><line x1={L} x2={W - R} y1={y(g)} y2={y(g)} stroke={C.grid} strokeDasharray={g ? '3 4' : undefined} /><text x={L - 6} y={y(g) + 4} fontSize="11" textAnchor="end" fill={C.muted}>{g}{unit}</text></g>)}
          {points.map((p, i) => (i % 3 === 0 || i === points.length - 1) && <text key={p.label} x={x(i)} y={H - 10} fontSize="11" textAnchor="middle" fill={C.muted}>{p.label.slice(5)}</text>)}
          {segs.map((d) => <path key={d} d={d} fill="none" stroke={C.bar} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />)}
          {last && <text x={x(points.lastIndexOf(last)) - 4} y={y(last.value!) - 10} fontSize="12" textAnchor="end" fill={C.ink}>{last.value}{unit}</text>}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} stroke={C.muted} strokeDasharray="2 3" />
              {points[hover].value !== null && <circle cx={x(hover)} cy={y(points[hover].value!)} r={4} fill={C.bar} stroke="#fff" strokeWidth={2} />}
              <text x={Math.min(x(hover) + 8, W - 120)} y={T + 12} fontSize="12" fill={C.ink}>{points[hover].label}：{points[hover].value ?? '暂无数据'}{points[hover].value !== null ? unit : ''}</text>
            </g>
          )}
        </svg>
      </div>
    </Frame>
  );
}

/** 前测 / 中测 / 后测：有顺序的三组，同一色相由浅到深，旁边有图例，每根柱子带数值 */
export function SurveyBars({ title, note, rows }: { title: string; note?: string; rows: { label: string; pre: number | null; mid: number | null; post: number | null }[] }) {
  const ref = useRef<SVGSVGElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const W = 640; const group = 34; const left = 230; const right = 40; const bh = 8;
  const H = rows.length * group + 34;
  const scale = (v: number) => ((W - left - right) * v) / 5;
  const series = [['pre', '前测'], ['mid', '中测'], ['post', '后测']] as const;
  const short = (s: string) => (s.length > 16 ? `${s.slice(0, 16)}…` : s);
  const table = (
    <table className="score-table small"><thead><tr><th>能力自评</th><th>前测</th><th>中测</th><th>后测</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.label}><td>{r.label}</td><td className="num">{r.pre ?? '—'}</td><td className="num">{r.mid ?? '—'}</td><td className="num">{r.post ?? '—'}</td></tr>)}</tbody></table>
  );
  return (
    <Frame title={title} note={note} svgRef={ref} table={table}>
      <div className="chart-wrap" onMouseLeave={() => setTip(null)}>
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={title} xmlns="http://www.w3.org/2000/svg" style={{ fontFamily: 'PingFang SC, Microsoft YaHei, sans-serif' }}>
          {series.map(([k, name], i) => (
            <g key={k} transform={`translate(${left + i * 70}, 6)`}><rect width={12} height={10} rx={2} fill={C.seq[i]} /><text x={16} y={9} fontSize="11" fill={C.muted}>{name}</text></g>
          ))}
          {rows.map((r, ri) => {
            const y0 = 28 + ri * group;
            return (
              <g key={r.label}>
                <text x={left - 8} y={y0 + 16} textAnchor="end" fontSize="11" fill={C.muted}>{short(r.label)}</text>
                {series.map(([k, name], si) => {
                  const v = r[k];
                  const y = y0 + si * (bh + 2);
                  return (
                    <g key={k} onMouseMove={(e) => { const b = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect(); setTip({ x: e.clientX - b.left + 12, y: e.clientY - b.top - 28, text: `${r.label} · ${name}：${v ?? '暂无数据'}` }); }}>
                      <rect x={left} y={y - 1} width={W - left} height={bh + 2} fill="transparent" />
                      {v !== null && <rect x={left} y={y} width={Math.max(2, scale(v))} height={bh} rx={3} fill={C.seq[si]} />}
                      {v !== null && <text x={left + scale(v) + 4} y={y + 8} fontSize="10" fill={C.ink}>{v}</text>}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
        <Tip tip={tip} />
      </div>
    </Frame>
  );
}
