// 应用外壳：桌面左侧72px图标导航（可展开至224px），手机底栏（PRD 10.1）
import { Suspense, useState, type ComponentType, type SVGProps } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { IconGrowth, IconMe, IconMentors, IconMenu, IconRoad, IconSettings, IconStudy, IconToday } from './icons';
import { useAuth } from '../auth';

interface NavDef { to: string; label: string; Icon: ComponentType<SVGProps<SVGSVGElement>>; mobile: boolean }

const STUDENT_NAV: NavDef[] = [
  { to: '/', label: '今日', Icon: IconToday, mobile: true },
  { to: '/road', label: '我的路', Icon: IconRoad, mobile: true },
  { to: '/mentors', label: '导师团', Icon: IconMentors, mobile: true },
  { to: '/study', label: '书房', Icon: IconStudy, mobile: true },
  { to: '/growth', label: '成长档案', Icon: IconGrowth, mobile: false },
  { to: '/me', label: '我', Icon: IconMe, mobile: true },
];

// 教师端：概览 / 学生 / 课堂 / 评分 / 导师工坊 / 成效 / 设置
const TEACHER_NAV: NavDef[] = [
  { to: '/teacher', label: '概览', Icon: IconToday, mobile: true },
  { to: '/teacher/students', label: '学生', Icon: IconMe, mobile: true },
  { to: '/teacher/class', label: '课堂', Icon: IconStudy, mobile: true },
  { to: '/teacher/grades', label: '评分', Icon: IconGrowth, mobile: false },
  { to: '/teacher/mentors', label: '导师工坊', Icon: IconMentors, mobile: false },
  { to: '/teacher/impact', label: '成效', Icon: IconRoad, mobile: false },
  { to: '/teacher/settings', label: '设置', Icon: IconSettings, mobile: true },
];

export function AppShell() {
  const { me, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const items = me?.role === 'teacher' ? TEACHER_NAV : STUDENT_NAV;

  return (
    <div className="shell">
      <a href="#main" className="skip-link">跳到正文</a>
      <nav className={`nav${open ? ' open' : ''}`} aria-label="主导航">
        <button
          type="button"
          className="btn btn-text nav-toggle"
          aria-expanded={open}
          aria-label={open ? '收起导航' : '展开导航'}
          onClick={() => setOpen((v) => !v)}
        >
          <IconMenu width={22} height={22} />
        </button>
        <div className="brand-mark">{open ? '山海问知' : '山海'}</div>
        {items.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} end={to === '/' || to === '/teacher'} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`} title={label}>
            <Icon />
            <span className="nav-label">{label}</span>
          </NavLink>
        ))}
        <div className="nav-bottom">
          <button type="button" className="btn btn-text" style={{ width: '100%' }} onClick={() => void logout()} title="退出登录">
            {open ? '退出登录' : '退出'}
          </button>
        </div>
      </nav>

      <main className="main" id="main" tabIndex={-1}>
        {me?.is_demo && (
          <p className="notice notice-warn demo-banner">
            <span className="icon">!</span>
            <span>这是评委演示账号（沙箱班级），产生的数据都标记为“演示”，不计入任何统计{me.expires_at ? `；有效期至 ${me.expires_at.slice(0, 10)}` : ''}。</span>
          </p>
        )}
        <Suspense fallback={<p className="muted" role="status">正在载入…</p>}>
          <Outlet />
        </Suspense>
      </main>

      <nav className="tabbar" aria-label="底部导航">
        {items.filter((i) => i.mobile).map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} end={to === '/' || to === '/teacher'} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
