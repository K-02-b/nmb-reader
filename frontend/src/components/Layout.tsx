import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import { LayoutProvider, useLayout } from '../state/LayoutContext';
import { groupText } from './format';
import { toMobilePath, writeUiMode } from '../mobile/device';

export function Layout() {
  return (
    <LayoutProvider>
      <Shell />
    </LayoutProvider>
  );
}

function Shell() {
  const { session, logout, notices } = useApp();
  const { dockOpen } = useLayout();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();

  // 换页面回到页首：否则从阅读页回目录会停在上一次的滚动位置
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header-inner">
          <div className="brand">
            匿名版<span>阅读器</span>
          </div>
          <nav className="nav">
            <NavLink to="/home">目录</NavLink>
            <NavLink to="/admin">管理</NavLink>
            <NavLink to="/settings">设置</NavLink>
          </nav>
          <div className="user-chip">
            {session && (
              <>
                <span>
                  {session.username} · {groupText(session.group)}
                </span>
                <button
                  className="btn btn-sm btn-ghost"
                  title="切到手机版界面（会记住这次选择）"
                  onClick={() => {
                    writeUiMode('mobile');
                    navigate(toMobilePath(pathname + search));
                  }}
                >
                  手机版
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => {
                    logout();
                    navigate('/login', { replace: true });
                  }}
                >
                  注销
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      {/* 工具栏展开时正文让出宽度（container-dock），而不是被面板盖住 */}
      <main className={`container ${dockOpen ? 'container-dock' : ''}`}>
        <Outlet />
      </main>
      {createPortal(
        <div className="toasts">
          {notices.map((n) => (
            <div key={n.id} className={`toast toast-${n.kind}`}>
              {n.text}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
