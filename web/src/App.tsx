// 路由：学生六个一级入口（今日 / 我的路 / 导师团 / 书房 / 成长档案 / 我），教师端独立路由
import { lazy, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { AppShell } from './components/AppShell';
import { Login, Register } from './pages/Auth';
import Today from './pages/Today';
import Road from './pages/Road';
import Prepare from './pages/Prepare';
const Station2 = lazy(() => import('./pages/Station2'));
const Station3 = lazy(() => import('./pages/Station3'));
const Station4 = lazy(() => import('./pages/Station4'));
const Station5 = lazy(() => import('./pages/Station5'));
const Station6 = lazy(() => import('./pages/Station6'));
const Station7 = lazy(() => import('./pages/Station7'));
const Station8 = lazy(() => import('./pages/Station8'));
const Station9 = lazy(() => import('./pages/Station9'));
const Study = lazy(() => import('./pages/Study'));
const TwinPage = lazy(() => import('./pages/Twin'));
const LabPage = lazy(() => import('./pages/Lab'));
const Station10 = lazy(() => import('./pages/Station10'));
const Growth = lazy(() => import('./pages/Growth'));
const TeacherGrades = lazy(() => import('./pages/TeacherGrades'));
const Classroom = lazy(() => import('./pages/Classroom'));
const Memories = lazy(() => import('./pages/Memories'));
const Group = lazy(() => import('./pages/Group'));
const Mentors = lazy(() => import('./pages/Mentors'));
const MePage = lazy(() => import('./pages/Me'));
const MeKeys = lazy(() => import('./pages/MeKeys'));
const TeacherSettings = lazy(() => import('./pages/TeacherSettings'));
const TeacherOverview = lazy(() => import('./pages/TeacherPeople').then((m) => ({ default: m.TeacherOverview })));
const TeacherStudents = lazy(() => import('./pages/TeacherPeople').then((m) => ({ default: m.TeacherStudents })));
const TeacherStudentDetail = lazy(() => import('./pages/TeacherPeople').then((m) => ({ default: m.TeacherStudentDetail })));
const TeacherWorkshop = lazy(() => import('./pages/TeacherWorkshop').then((m) => ({ default: m.TeacherWorkshop })));
const TeacherMentor = lazy(() => import('./pages/TeacherWorkshop').then((m) => ({ default: m.TeacherMentor })));
const TeacherImpact = lazy(() => import('./pages/TeacherImpact'));
const Ask = lazy(() => import('./pages/Ask'));

function Guard({ role, children }: { role: 'student' | 'teacher'; children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <p className="muted" style={{ padding: 32 }}>正在载入…</p>;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (me.role !== role) return <Navigate to={me.role === 'teacher' ? '/teacher' : '/'} replace />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return null;
  if (me) return <Navigate to={me.role === 'teacher' ? '/teacher' : '/'} replace />;
  return <>{children}</>;
}

/** 学生首次登录且未完成出发准备时，先引导去做完（M1） */
function RequirePrepare({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const loc = useLocation();
  if (me && !me.prepare_done && loc.pathname !== '/prepare') {
    return <Navigate to="/prepare" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
      <Route path="/register" element={<PublicOnly><Register /></PublicOnly>} />

      <Route element={<Guard role="student"><AppShell /></Guard>}>
        <Route index element={<RequirePrepare><Today /></RequirePrepare>} />
        <Route path="prepare" element={<Prepare />} />
        <Route path="road" element={<RequirePrepare><Road /></RequirePrepare>} />
        <Route path="road/1" element={<RequirePrepare><Classroom /></RequirePrepare>} />
        <Route path="road/2" element={<RequirePrepare><Station2 /></RequirePrepare>} />
        <Route path="road/3" element={<RequirePrepare><Station3 /></RequirePrepare>} />
        <Route path="road/4" element={<RequirePrepare><Station4 /></RequirePrepare>} />
        <Route path="road/5" element={<RequirePrepare><Station5 /></RequirePrepare>} />
        <Route path="road/6" element={<RequirePrepare><Station6 /></RequirePrepare>} />
        <Route path="road/7" element={<RequirePrepare><Station7 /></RequirePrepare>} />
        <Route path="road/8" element={<RequirePrepare><Station8 /></RequirePrepare>} />
        <Route path="road/9" element={<RequirePrepare><Station9 /></RequirePrepare>} />
        <Route path="road/10" element={<RequirePrepare><Station10 /></RequirePrepare>} />
        <Route path="road/11" element={<RequirePrepare><Growth asStation /></RequirePrepare>} />
        <Route path="class" element={<RequirePrepare><Classroom /></RequirePrepare>} />
        <Route path="mentors" element={<RequirePrepare><Mentors /></RequirePrepare>} />
        <Route path="mentors/group" element={<RequirePrepare><Group /></RequirePrepare>} />
        <Route path="mentors/ask" element={<RequirePrepare><Ask /></RequirePrepare>} />
        <Route path="study" element={<RequirePrepare><Study /></RequirePrepare>} />
        <Route path="growth" element={<RequirePrepare><Growth /></RequirePrepare>} />
        <Route path="me" element={<MePage />} />
        <Route path="me/keys" element={<MeKeys />} />
        <Route path="me/twin" element={<RequirePrepare><TwinPage /></RequirePrepare>} />
        <Route path="me/lab" element={<RequirePrepare><LabPage /></RequirePrepare>} />
        <Route path="memories" element={<RequirePrepare><Memories /></RequirePrepare>} />
      </Route>

      <Route path="/teacher" element={<Guard role="teacher"><AppShell /></Guard>}>
        <Route index element={<TeacherOverview />} />
        <Route path="students" element={<TeacherStudents />} />
        <Route path="students/:id" element={<TeacherStudentDetail />} />
        <Route path="mentors" element={<TeacherWorkshop />} />
        <Route path="mentors/:key" element={<TeacherMentor />} />
        <Route path="impact" element={<TeacherImpact />} />
        <Route path="settings" element={<TeacherSettings />} />
        <Route path="class" element={<Classroom />} />
        <Route path="grades" element={<TeacherGrades />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
