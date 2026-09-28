import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import type { UserSettings } from '../../api/types';
import { useApp } from '../../state/AppContext';
import { CookiePanel } from '../../components/CookiePanel';
import { DownloadLimits } from '../../components/DownloadLimits';
import { fmtDate, groupText } from '../../components/format';
import { writeUiMode } from '../device';

const ACCENTS = ['#6ea8fe', '#57d38c', '#e8b23d', '#ef6b6b', '#c69ef0'];
const PERMISSION_TEXT: Record<string, string> = {
  'thread.download': '提交下载申请',
  'thread.edit': '修改串信息与标签',
  'user.manage': '用户与权限管理',
  'db.manage': '数据库备份/恢复/清理',
  'log.view': '查看日志',
};

type TabKey = 'appearance' | 'download' | 'account' | 'blacklist';

const TABS: Array<[TabKey, string]> = [
  ['appearance', '阅读外观'],
  ['download', '下载'],
  ['account', '账户与权限'],
  ['blacklist', '黑名单'],
];

/**
 * 手机端设置页：与桌面设置页共用同一份设置状态（`AppContext` 的 settings/saveSettings，会同步到服务端）
 * 与同一批子组件（CookiePanel / DownloadLimits），只是标签改成可横向滚动的分段条。
 */
export function MobileSettingsPage() {
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
    <div className="m-page">
      <div className="m-seg">
        {TABS.map(([key, label]) => (
          <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'appearance' && (
        <div className="card">
          <div className="card-title">
            <h3>阅读外观</h3>
            <button className="btn btn-sm btn-ghost" onClick={resetSettings}>
              恢复默认
            </button>
          </div>
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
                  style={{ background: color, borderColor: settings.accent === color ? 'var(--text)' : 'transparent' }}
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
              onChange={(event) => set({ fontSize: Number(event.target.value) })}
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
              onChange={(event) => set({ lineHeight: Number(event.target.value) })}
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
              onChange={(event) => set({ brightness: Number(event.target.value) })}
            />
          </div>
          <div className="field">
            <label>字体</label>
            <select
              className="select"
              value={settings.fontFamily}
              onChange={(event) => set({ fontFamily: event.target.value as UserSettings['fontFamily'] })}
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
              onChange={(event) => set({ pagingMode: event.target.value as UserSettings['pagingMode'] })}
            >
              <option value="island">按岛页码（保留原页结构）</option>
              <option value="custom">按自定义条数</option>
            </select>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>每页条数：{settings.pageSize}</label>
            <input
              type="range"
              min={10}
              max={50}
              step={5}
              value={settings.pageSize}
              onChange={(event) => set({ pageSize: Number(event.target.value) })}
            />
          </div>
          <p className="hint">这些设置只影响你自己的阅读视图；数据库仍保存岛上原始页码。</p>
        </div>
      )}

      {tab === 'download' && (
        <>
          <DownloadLimits />
          <CookiePanel />
        </>
      )}

      {tab === 'account' && (
        <>
          <div className="card">
            <div className="card-title">
              <h3>账户与权限</h3>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  logout();
                  navigate('/m/login', { replace: true });
                }}
              >
                注销
              </button>
            </div>
            <div className="m-item-meta" style={{ fontSize: '0.85em' }}>
              <span className="mono">{session.username}</span>
              <span>{groupText(session.group)}</span>
              <span>本地时间 {fmtDate(Math.floor(Date.now() / 1000))}</span>
            </div>
            <div className="m-thread-tags" style={{ marginTop: 10 }}>
              {session.permissions.map((permission) => (
                <span key={permission} className="badge badge-accent">
                  {PERMISSION_TEXT[permission] ?? permission}
                </span>
              ))}
            </div>
            <p className="hint" style={{ marginBottom: 0 }}>
              当前使用手机版界面。切回电脑版后，下次从站点入口进入也会走电脑版。
              <button
                className="link-btn"
                style={{ marginLeft: 6 }}
                onClick={() => {
                  writeUiMode('desktop');
                  navigate('/settings');
                }}
              >
                切换电脑版
              </button>
            </p>
          </div>

          <div className="card">
            <div className="card-title">
              <h3>修改密码</h3>
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              改完其它设备上的登录会失效，当前这台会保持登录。
            </p>
            <form
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
              <div className="field">
                <label htmlFor="m-current-password">当前密码</label>
                <input
                  id="m-current-password"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={passwordDraft.current}
                  onChange={(event) => setPasswordDraft((prev) => ({ ...prev, current: event.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="m-new-password">新密码</label>
                <input
                  id="m-new-password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={passwordDraft.next}
                  onChange={(event) => setPasswordDraft((prev) => ({ ...prev, next: event.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="m-confirm-password">再输一次新密码</label>
                <input
                  id="m-confirm-password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={passwordDraft.confirm}
                  onChange={(event) => setPasswordDraft((prev) => ({ ...prev, confirm: event.target.value }))}
                />
              </div>
              <button
                className="btn btn-primary"
                type="submit"
                disabled={passwordBusy || !passwordDraft.current || !passwordDraft.next}
              >
                {passwordBusy ? '提交中…' : '修改密码'}
              </button>
            </form>
          </div>
        </>
      )}

      {tab === 'blacklist' && (
        <div className="card">
          <div className="card-title">
            <h3>黑名单</h3>
            <span className="hint">目录页与阅读页会自动隐藏命中的饼干和串</span>
          </div>

          <div className="field">
            <label htmlFor="m-block-cookie">屏蔽饼干</label>
            <div className="row">
              <input
                id="m-block-cookie"
                className="input mono"
                value={cookieInput}
                onChange={(event) => setCookieInput(event.target.value)}
                placeholder="例如 t4OnvWM"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
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
              {settings.blacklistCookies.map((cookie) => (
                <span key={cookie} className="tag">
                  <span className="mono">ID:{cookie}</span>
                  <button onClick={() => unblockCookie(cookie)} aria-label={`解除 ${cookie}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="m-block-thread">屏蔽串</label>
            <div className="row">
              <input
                id="m-block-thread"
                className="input mono"
                value={threadInput}
                onChange={(event) => setThreadInput(event.target.value)}
                placeholder="例如 59775198"
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && threadInput) {
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
              {settings.blacklistThreads.map((id) => (
                <span key={id} className="tag">
                  No.{id}
                  <button onClick={() => unblockThread(id)} aria-label={`解除 No.${id}`}>
                    ×
                  </button>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
