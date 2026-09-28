import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../state/AppContext';
import { IconBookmark, IconDocumentSearch, IconHome, IconSettings, IconShield } from '../components/icons';
import { toDesktopPath, writeUiMode } from './device';

/** 阅读页自带顶栏与底部工具条，全局标签栏要让位，否则一屏里三条横栏 */
const READER_PATH = /^\/m\/t\//;

interface TabItem {
  to: string;
  label: string;
  icon: ReactNode;
}

/** 手机端底部标签：管理按权限出现，和桌面端顶栏的「管理」一致 */
function useTabs(): TabItem[] {
  const { session } = useApp();
  const tabs: TabItem[] = [
    { to: '/m/home', label: '目录', icon: <IconHome /> },
    { to: '/m/search', label: '检索', icon: <IconDocumentSearch /> },
    { to: '/m/bookmarks', label: '书签', icon: <IconBookmark /> },
  ];
  if (session?.permissions.length) tabs.push({ to: '/m/admin', label: '管理', icon: <IconShield /> });
  tabs.push({ to: '/m/settings', label: '设置', icon: <IconSettings /> });
  return tabs;
}

function TopBar() {
  const { session } = useApp();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();

  return (
    <header className="app-header m-header">
      <div className="m-header-inner">
        <NavLink to="/m/home" className="brand">
          匿名版<span>阅读器</span>
        </NavLink>
        <span className="spacer" />
        {session && <span className="m-header-user mono">{session.username}</span>}
        <button
          className="btn btn-sm btn-ghost"
          title="切回电脑版界面（会记住这次选择）"
          onClick={() => {
            writeUiMode('desktop');
            navigate(toDesktopPath(pathname + search));
          }}
        >
          电脑版
        </button>
      </div>
    </header>
  );
}

function TabBar() {
  const tabs = useTabs();
  return (
    <nav className="m-tabbar">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} className={({ isActive }) => `m-tab ${isActive ? 'active' : ''}`}>
          {tab.icon}
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

export function MobileLayout() {
  const { pathname } = useLocation();
  const { notices } = useApp();
  const reader = READER_PATH.test(pathname);

  // 换页面回到页首：手机上一屏短，留着上一次的滚动位置会很突兀
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);

  // 给 <html> 打个标记：弹框/提示的层级要在手机端整体抬高（它们挂在 body 上，不在 .m-shell 里）
  useEffect(() => {
    document.documentElement.dataset.ui = 'mobile';
    return () => {
      delete document.documentElement.dataset.ui;
    };
  }, []);

  return (
    <div className={`m-shell ${reader ? 'm-shell-reader' : ''}`}>
      {!reader && <TopBar />}
      <main className={`m-container ${reader ? 'm-container-bare' : ''}`}>
        <Outlet />
      </main>
      {!reader && <TabBar />}
      {createPortal(
        <div className="toasts m-toasts">
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
