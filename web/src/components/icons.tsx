// 原创抽象图标：导航图标与导师符号（云纹、山脊、波纹、轻舟等），不使用人像
import type { ReactElement, SVGProps } from 'react';

type P = SVGProps<SVGSVGElement>;
const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

export const IconToday = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="10" r="4" /><path d="M3 20h18M6 16.5 4.5 18M18 16.5l1.5 1.5M12 3v1.5" /></svg>);
export const IconRoad = (p: P) => (<svg {...base} {...p}><path d="M3 19 9 9l4 6 3-4 5 8" /><path d="M5 21c4-1 6-3 7-6s3-5 7-6" strokeDasharray="2 2.5" /></svg>);
export const IconMentors = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="6.5" r="1.6" /><circle cx="6.8" cy="14.5" r="1.6" /><circle cx="17.2" cy="14.5" r="1.6" /></svg>);
export const IconStudy = (p: P) => (<svg {...base} {...p}><path d="M4 5.5c3-1 5.5-.5 8 1.5 2.5-2 5-2.5 8-1.5V19c-3-1-5.5-.5-8 1.5-2.5-2-5-2.5-8-1.5Z" /><path d="M12 7v13" /></svg>);
export const IconGrowth = (p: P) => (<svg {...base} {...p}><path d="M6 3.5h9l3 3V20.5H6Z" /><path d="M9 11h6M9 14.5h6M9 18h3" /></svg>);
export const IconMe = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20c1.2-3.5 3.8-5 7-5s5.8 1.5 7 5" /></svg>);
export const IconMenu = (p: P) => (<svg {...base} {...p}><path d="M4 7h16M4 12h16M4 17h16" /></svg>);
export const IconTeacher = (p: P) => (<svg {...base} {...p}><path d="M3 9.5 12 5l9 4.5-9 4.5Z" /><path d="M7 11.5V16c3 2 7 2 10 0v-4.5" /></svg>);
export const IconSettings = (p: P) => (<svg {...base} {...p}><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></svg>);

// 导师符号
const mentorPaths: Record<string, ReactElement> = {
  cloud: (<path d="M5 15.5c-1.7 0-2.5-1-2.5-2.3S3.6 11 5 11c.2-2.3 2-4 4.3-4 1.8 0 3.3 1 4 2.6.5-.3 1-.4 1.7-.4 1.9 0 3.3 1.4 3.4 3.3 1.5.2 2.6 1.2 2.6 2.5 0 1.4-1 2.5-2.7 2.5Zm3 0c0-1.3 1-2.2 2.3-2.2" />),
  whetstone: (<g><path d="M3 15.5 7 9h14l-4 6.5Z" /><path d="M10 6l3-3M14 6.5 17 3.5" /></g>),
  wave: (<g><path d="M2.5 12c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 3-2" /><path d="M2.5 16.5c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 3-2" /></g>),
  boat: (<g><path d="M3 14.5h18l-3 4H6Z" /><path d="M12 14.5V4l6 8h-6" /><path d="M2.5 21c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 3-1" /></g>),
  ridge: (<path d="M2.5 19 9 8l3.5 5 3-4 6 10Z" />),
  river: (<path d="M7 3c4 3-4 6 0 9s-4 6 0 9M15 3c4 3-4 6 0 9s-4 6 0 9" />),
  steps: (<path d="M4 19h4v-4h4v-4h4V7h4" />),
  spark: (<path d="M12 3v5M12 16v5M3 12h5M16 12h5M6 6l3 3M15 15l3 3M6 18l3-3M15 9l3-3" />),
  page: (<g><path d="M6 3h9l3 3v15H6Z" /><path d="M9 10h6M9 14h6" /></g>),
  compass: (<g><circle cx="12" cy="12" r="8.5" /><path d="m14.5 9.5-1.5 4-3.5 1 1.5-4Z" /></g>),
  scale: (<g><path d="M12 4v16M6 20h12M5 7h14" /><path d="M5 7 2.5 13h5ZM19 7l-2.5 6h5Z" /></g>),
  mist: (<path d="M3 9h12M6 13h15M3 17h10" />),
  mirror: (<g><ellipse cx="12" cy="10" rx="6" ry="7" /><path d="M12 17v4M8.5 21h7" /></g>),
};

export function MentorGlyph({ icon, ...p }: { icon: string } & P) {
  return <svg {...base} {...p}>{mentorPaths[icon] || <circle cx="12" cy="12" r="6" />}</svg>;
}
