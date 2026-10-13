// 登录与注册（PRD M1）
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Me } from '../api/types';
import { useAuth } from '../auth';

const GRADES = ['大一', '大二', '大三', '大四', '其他'];
const MAJOR_GROUPS = ['理工', '经管', '文史', '艺术', '教育', '其他'];

function Brand() {
  return (
    <div className="auth-title">
      <h1>山海问知</h1>
      <p className="muted">以山海为境，以求知为路</p>
    </div>
  );
}

export function Login() {
  const { setMe } = useAuth();
  const nav = useNavigate();
  const [studentNo, setStudentNo] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ me: Me }>('/login', { body: { student_no: studentNo, password } });
      setMe(r.me);
      nav(r.me.role === 'teacher' ? '/teacher' : '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '登录失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit} noValidate>
        <Brand />
        <div className="field">
          <label htmlFor="sno">学号（教师填账号）</label>
          <input id="sno" className="input" autoComplete="username" value={studentNo} onChange={(e) => setStudentNo(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="pw">密码</label>
          <input id="pw" type="password" className="input" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}
        <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? '正在登录…' : '登录'} <span className="arrow">→</span>
        </button>
        <p className="muted small" style={{ textAlign: 'center', marginTop: 16 }}>
          还没有账号？<Link to="/register">用班级邀请码注册</Link>
        </p>
      </form>
    </div>
  );
}

export function Register() {
  const { setMe } = useAuth();
  const nav = useNavigate();
  const [f, setF] = useState({ invite_code: '', student_no: '', name: '', email: '', major: '', grade: '', major_group: '', password: '', password2: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (f.password.length < 8) return setError('密码至少8位。');
    if (f.password !== f.password2) return setError('两次输入的密码不一致。');
    if (!f.grade || !f.major_group) return setError('请选择年级和专业大类。');
    setBusy(true);
    setError('');
    try {
      const body = {
        invite_code: f.invite_code, student_no: f.student_no, name: f.name, email: f.email,
        major: f.major, grade: f.grade, major_group: f.major_group, password: f.password,
      };
      const r = await api<{ me: Me }>('/register', { body });
      setMe(r.me);
      nav('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '注册失败，请重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit} noValidate>
        <Brand />
        <p className="muted small">注册不需要任何 API Key，基础模块注册后直接可用。</p>
        <div className="field">
          <label htmlFor="r-invite">班级邀请码</label>
          <input id="r-invite" className="input" value={f.invite_code} onChange={set('invite_code')} autoComplete="off" required />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="r-sno">学号</label>
            <input id="r-sno" className="input" value={f.student_no} onChange={set('student_no')} autoComplete="username" required />
          </div>
          <div className="field">
            <label htmlFor="r-name">姓名</label>
            <input id="r-name" className="input" value={f.name} onChange={set('name')} autoComplete="name" required />
          </div>
        </div>
        <div className="field">
          <label htmlFor="r-email">QQ邮箱（用于学习提醒）</label>
          <input id="r-email" type="email" className="input" value={f.email} onChange={set('email')} placeholder="例如 12345678@qq.com" autoComplete="email" required />
        </div>
        <div className="field">
          <label htmlFor="r-major">专业</label>
          <input id="r-major" className="input" value={f.major} onChange={set('major')} required />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="r-grade">年级</label>
            <select id="r-grade" className="select" value={f.grade} onChange={set('grade')} required>
              <option value="">请选择</option>
              {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="r-mg">专业大类</label>
            <select id="r-mg" className="select" value={f.major_group} onChange={set('major_group')} required>
              <option value="">请选择</option>
              {MAJOR_GROUPS.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="r-pw">密码（至少8位）</label>
            <input id="r-pw" type="password" className="input" value={f.password} onChange={set('password')} autoComplete="new-password" required />
          </div>
          <div className="field">
            <label htmlFor="r-pw2">再输一次密码</label>
            <input id="r-pw2" type="password" className="input" value={f.password2} onChange={set('password2')} autoComplete="new-password" required />
          </div>
        </div>
        {error && <div className="notice notice-error" role="alert" style={{ marginBottom: 16 }}><span className="icon">!</span><span>{error}</span></div>}
        <button type="submit" className="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? '正在注册…' : '注册'} <span className="arrow">→</span>
        </button>
        <p className="muted small" style={{ textAlign: 'center', marginTop: 16 }}>
          已有账号？<Link to="/login">去登录</Link>
        </p>
      </form>
    </div>
  );
}
