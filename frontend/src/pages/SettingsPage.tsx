import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { UserSettings } from '../api/types';
import { useApp } from '../state/AppContext';
import { CookiePanel } from '../components/CookiePanel';
import { DownloadLimits } from '../components/DownloadLimits';
import { fmtDate, groupText } from '../components/format';

const ACCENTS = ['#6ea8fe', '#57d38c', '#e8b23d', '#ef6b6b', '#c69ef0'];
const PERMISSION_TEXT: Record<string, string> = {
  'thread.download': '提交下载申请',
  'thread.edit': '修改串信息与标签',
  'user.manage': '用户与权限管理',
  'db.manage': '数据库备份/恢复/清理',
  'log.view': '查看日志',
};

type TabKey = 'appearance' | 'download' | 'account' | 'blacklist';

export function SettingsPage() {
  const {
    session,
    settings,
    saveSettings,
    resetSettings,
    blockCookie,
    unblockCookie,
    blockThread,
    unblockThread,
    notify,
    logout,
  } = useApp();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabKey>('appearance');
  const [cookieInput, setCookieInput] = useState('');
  const [threadInput, setThreadInput] = useState('');
  const [passwordDraft, setPasswordDraft] = useState({ current: '', next: '', confirm: '' });
  const [passwordBusy, setPasswordBusy] = useState(false);

  const set = (patch: Partial<UserSettings>) => saveSettings(patch);

  if (!session) return null;

  return (
    <>
      <div className="card">
        <div className="card-title">
          <h3>设置</h3>
          <span className="hint">
            {session.username} · {groupText(session.group)}
          </span>
        </div>
        <div className="tabs" style={{ marginBottom: 0 }}>
          {(
            [
              ['appearance', '阅读外观'],
              ['download', '下载'],
              ['account', '账户与权限'],
              ['blacklist', '黑名单'],
            ] as Array<[TabKey, string]>
          ).map(([key, label]) => (
            <button key={key} className={`tab ${tab === key ? 'active' : ''}`} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'appearance' && (
        <div className="card mt-12">
          <div className="card-title">
            <h3>阅读外观</h3>
            <button className="btn btn-sm btn-ghost" onClick={resetSettings}>
              恢复默认
            </button>
          </div>
          <div className="grid-2">
            <div className="field">
              <label>主题</label>
              <div className="tabs-inline" style={{ margin: 0 }}>
                <button className={settings.theme === 'dark' ? 'active' : ''} onClick={() => set({ theme: 'dark' })}>
                  深色
                </button>
                <button className={settings.theme === 'light' ? 'active' : ''} onClick={() => set({ theme: 'light' })}>
                  浅色
                </button>
              </div>
            </div>
            <div className="field">
              <label>强调色</label>
              <div className="row">
                {ACCENTS.map((color) => (
                  <button
                    key={color}
                    className="accent-dot"
                    onClick={() => set({ accent: color })}
                    style={{
                      background: color,
                      borderColor: settings.accent === color ? 'var(--text)' : 'transparent',
                    }}
                    aria-label={`强调色 ${color}`}
                  />
                ))}
              </div>
            </div>
            <div className="field">
              <label>字号：{settings.fontSize}px</label>
              <input
                type="range"
                min={12}
                max={20}
                step={1}
                value={settings.fontSize}
                onChange={(e) => set({ fontSize: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>行距：{settings.lineHeight.toFixed(2)}</label>
              <input
                type="range"
                min={1.4}
                max={2.2}
                step={0.05}
                value={settings.lineHeight}
                onChange={(e) => set({ lineHeight: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>亮度：{settings.brightness}%</label>
              <input
                type="range"
                min={70}
                max={110}
                step={5}
                value={settings.brightness}
                onChange={(e) => set({ brightness: Number(e.target.value) })}
              />
            </div>
            <div className="field">
              <label>字体</label>
              <select
                className="select"
                value={settings.fontFamily}
                onChange={(e) => set({ fontFamily: e.target.value as UserSettings['fontFamily'] })}
              >
                <option value="system">系统默认</option>
                <option value="serif">衬线（宋体）</option>
                <option value="mono">等宽</option>
              </select>
            </div>
            <div className="field">
              <label>阅读页分页方式</label>
              <select
                className="select"
                value={settings.pagingMode}
                onChange={(e) => set({ pagingMode: e.target.value as UserSettings['pagingMode'] })}
              >
                <option value="island">按岛页码（保留原页结构）</option>
                <option value="custom">按自定义条数</option>
              </select>
            </div>
            <div className="field">
              <label>每页条数：{settings.pageSize}</label>
              <input
                type="range"
                min={10}
                max={50}
                step={5}
                value={settings.pageSize}
                onChange={(e) => set({ pageSize: Number(e.target.value) })}
              />
            </div>
          </div>
          <p className="hint">这些设置只影响你自己的阅读视图；数据库仍保存岛上原始页码，换分页方式不会改动数据。</p>
        </div>
      )}

      {tab === 'download' && (
        <>
          <DownloadLimits />
          <CookiePanel />
        </>
      )}

      {tab === 'account' && (
        <div className="card mt-12">
          <div className="card-title">
            <h3>账户与权限</h3>
            <button
              className="btn btn-sm btn-danger"
              onClick={() => {
                logout();
                navigate('/login', { replace: true });
              }}
            >
              注销
            </button>
          </div>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                <tr>
                  <th>用户名</th>
                  <td className="mono">{session.username}</td>
                </tr>
                <tr>
                  <th>用户组</th>
                  <td>{groupText(session.group)}</td>
                </tr>
                <tr>
                  <th>本地时间</th>
                  <td>{fmtDate(Math.floor(Date.now() / 1000))}</td>
                </tr>
                <tr>
                  <th>权限</th>
                  <td>
                    <div className="row row-wrap">
                      {session.permissions.map((p) => (
                        <span key={p} className="badge badge-accent">
                          {PERMISSION_TEXT[p] ?? p}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'account' && (
        <div className="card mt-12">
          <div className="card-title">
            <h3>修改密码</h3>
            <span className="hint">改完其它设备上的登录会失效，当前这台会保持登录</span>
          </div>
          <form
            className="row row-wrap form-uniform"
            autoComplete="off"
            onSubmit={async (event) => {
              event.preventDefault();
              const { current, next, confirm } = passwordDraft;
              if (!current || !next) return;
              if (next !== confirm) {
                notify('两次输入的新密码不一致', 'error');
                return;
              }
              setPasswordBusy(true);
              try {
                await api.changePassword(current, next);
                setPasswordDraft({ current: '', next: '', confirm: '' });
                notify('密码已修改', 'ok');
              } catch (error) {
                notify(error instanceof Error ? error.message : '修改失败', 'error');
              } finally {
                setPasswordBusy(false);
              }
            }}
          >
            <input
              className="input"
              style={{ width: 200 }}
              type="password"
              name="current-password"
              autoComplete="current-password"
              placeholder="当前密码"
              value={passwordDraft.current}
              onChange={(e) => setPasswordDraft((prev) => ({ ...prev, current: e.target.value }))}
            />
            <input
              className="input"
              style={{ width: 200 }}
              type="password"
              name="new-password"
              autoComplete="new-password"
              placeholder="新密码"
              value={passwordDraft.next}
              onChange={(e) => setPasswordDraft((prev) => ({ ...prev, next: e.target.value }))}
            />
            <input
              className="input"
              style={{ width: 200 }}
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              placeholder="再输一次新密码"
              value={passwordDraft.confirm}
              onChange={(e) => setPasswordDraft((prev) => ({ ...prev, confirm: e.target.value }))}
            />
            <button
              className="btn btn-primary"
              type="submit"
              disabled={passwordBusy || !passwordDraft.current || !passwordDraft.next}
            >
              {passwordBusy ? '提交中…' : '修改密码'}
            </button>
          </form>
        </div>
      )}

      {tab === 'blacklist' && (
        <div className="card mt-12">
          <div className="card-title">
            <h3>黑名单</h3>
            <span className="hint">目录页与阅读页会自动隐藏命中的饼干和串</span>
          </div>

          <div className="field">
            <label>屏蔽饼干</label>
            <div className="row">
              <input
                className="input mono"
                value={cookieInput}
                onChange={(e) => setCookieInput(e.target.value)}
                placeholder="例如 t4OnvWM"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    blockCookie(cookieInput);
                    setCookieInput('');
                  }
                }}
              />
              <button
                className="btn"
                onClick={() => {
                  blockCookie(cookieInput);
                  setCookieInput('');
                }}
              >
                添加
              </button>
            </div>
            <div className="row row-wrap mt-12">
              {settings.blacklistCookies.length === 0 && <span className="hint">暂无</span>}
              {settings.blacklistCookies.map((c) => (
                <span key={c} className="tag">
                  <span className="mono">ID:{c}</span>
                  <button onClick={() => unblockCookie(c)} aria-label={`解除 ${c}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>

          <div className="field">
            <label>屏蔽串</label>
            <div className="row">
              <input
                className="input mono"
                value={threadInput}
                onChange={(e) => setThreadInput(e.target.value)}
                placeholder="例如 59775198"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && threadInput) {
                    blockThread(Number(threadInput));
                    setThreadInput('');
                  }
                }}
              />
              <button
                className="btn"
                onClick={() => {
                  if (threadInput) blockThread(Number(threadInput));
                  setThreadInput('');
                }}
              >
                添加
              </button>
            </div>
            <div className="row row-wrap mt-12">
              {settings.blacklistThreads.length === 0 && <span className="hint">暂无</span>}
              {settings.blacklistThreads.map((t) => (
                <span key={t} className="tag">
                  No.{t}
                  <button onClick={() => unblockThread(t)} aria-label={`解除 ${t}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
