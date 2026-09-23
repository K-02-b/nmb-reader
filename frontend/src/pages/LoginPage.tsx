import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../state/AppContext';

export function LoginPage() {
  const { login, register, session } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/home';

  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to={from} replace />;

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      if (mode === 'login') {
        await login(username, password);
        navigate(from, { replace: true });
      } else {
        if (password !== confirm) throw new Error('两次输入的密码不一致');
        await register(username, password, inviteCode);
        setMode('login');
        setPassword('');
        setConfirm('');
        setInviteCode('');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-brand">
          匿名版<span>阅读器</span>
        </h1>
        <div className="tabs-inline">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            登录
          </button>
          <button className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            注册
          </button>
        </div>

        <div className="field">
          <label htmlFor="username">用户名</label>
          <input
            id="username"
            className="input"
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>
        <div className="field">
          <label htmlFor="password">密码</label>
          <input
            id="password"
            className="input"
            type="password"
            value={password}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>

        {mode === 'register' && (
          <>
            <div className="field">
              <label htmlFor="confirm">确认密码</label>
              <input
                id="confirm"
                className="input"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="invite">邀请码</label>
              <input
                id="invite"
                className="input"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
              <span className="hint">
                密码至少 8 位，需包含大小写字母和数字；邀请码由管理员在命令行创建（见 README）。
              </span>
            </div>
          </>
        )}

        {error && <p className="error-text">{error}</p>}

        <button className="btn btn-primary" style={{ width: '100%' }} disabled={busy} onClick={submit}>
          {busy ? '处理中…' : mode === 'login' ? '登录' : '注册'}
        </button>
      </div>
    </div>
  );
}
