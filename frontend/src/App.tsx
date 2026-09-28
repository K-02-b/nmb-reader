import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { ReaderPage } from './pages/ReaderPage';
import { AdminPage } from './pages/AdminPage';
import { SettingsPage } from './pages/SettingsPage';
import { EntryRedirect } from './mobile/EntryRedirect';
import { MobileLayout } from './mobile/MobileLayout';
import { MobileRequireAuth } from './mobile/MobileRequireAuth';
import { MobileLoginPage } from './mobile/pages/MobileLoginPage';
import { MobileHomePage } from './mobile/pages/MobileHomePage';
import { MobileReaderPage } from './mobile/pages/MobileReaderPage';
import { MobileSearchPage } from './mobile/pages/MobileSearchPage';
import { MobileBookmarksPage } from './mobile/pages/MobileBookmarksPage';
import { MobileSettingsPage } from './mobile/pages/MobileSettingsPage';
import { MobileAdminPage } from './mobile/pages/MobileAdminPage';

/** 换串时整页重挂载，免得上一个串的页码、检索词跟过来 */
function ReaderRoute() {
  const { threadId } = useParams();
  return <ReaderPage key={threadId} />;
}

/** 手机端同样按串重挂载：阅读位置、检索词、引用弹框都不该跨串残留 */
function MobileReaderRoute() {
  const { threadId } = useParams();
  return <MobileReaderPage key={threadId} />;
}

/**
 * 两套 UI 用路由分开：`/m/...` 是手机端，其余是电脑端。
 *
 * 两边共用 `AppContext`（登录态、设置、SSE 任务流、toast）、`api` 客户端与大部分展示组件；
 * 只有页面骨架与工具栏的形态不同。根路径由 EntryRedirect 按设备/上次选择分发。
 */
export function App() {
  return (
    <Routes>
      {/* 登录页不套布局：手机端与电脑端各一份落点 */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/m/login" element={<MobileLoginPage />} />

      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/home" element={<HomePage />} />
        <Route path="/t/:threadId" element={<ReaderRoute />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>

      <Route
        path="/m"
        element={
          <MobileRequireAuth>
            <MobileLayout />
          </MobileRequireAuth>
        }
      >
        <Route index element={<Navigate to="/m/home" replace />} />
        <Route path="home" element={<MobileHomePage />} />
        <Route path="t/:threadId" element={<MobileReaderRoute />} />
        <Route path="search" element={<MobileSearchPage />} />
        <Route path="bookmarks" element={<MobileBookmarksPage />} />
        <Route path="settings" element={<MobileSettingsPage />} />
        <Route path="admin" element={<MobileAdminPage />} />
      </Route>

      <Route path="*" element={<EntryRedirect />} />
    </Routes>
  );
}
